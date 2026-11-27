import { connectTestDb, disconnectTestDb, clearTestDb } from "./testDb.js";
import Category from "../models/Category.js";
import TestSeries from "../models/TestSeries.js";
import { parseCategories, buildImportPlan, importPlan } from "../scripts/importTestbookExams.js";

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

const SSC = "5e6189e15f66e94f14a21f94";
const BANK = "5e6189e15f66e94f14a21f8c";
const EMPTY = "684fdfc3a7a0c467493ad327";

const target = (id, title, primary) => ({
  _id: id,
  properties: { title, superGroupInfo: [{ _id: primary, isPrimary: true }] },
});

const catalogue = () => [
  { id: SSC, index: 0, title: "SSC Exams", targets: [target("t1", "SSC CGL", SSC), target("t2", "SBI Clerk", BANK)] },
  { id: BANK, index: 1, title: "Banking Exams", targets: [target("t2", "SBI Clerk", BANK), target("t3", "IBPS PO", BANK)] },
  { id: EMPTY, index: 2, title: "DIBO", targets: [] },
];

const counts = (s) => [
  s.categoriesCreated,
  s.categoriesUpdated,
  s.categoriesUnchanged,
  s.seriesCreated,
  s.seriesUpdated,
  s.seriesUnchanged,
];

describe("parseCategories", () => {
  it("reads each super-group tab once, in order, decoding entities", () => {
    const tab = (id, i, title, cls) =>
      `<a _ngcontent-sc22="" class="tab" cb-await-id="identifierswitchsupergroup_${id}_${i}"><img src="x.png"><span _ngcontent-sc22="" class="${cls}">${title}</span></a>`;
    const html =
      tab(BANK, 1, "Data Science &amp; Analytics", "tab__text") +
      tab(SSC, 0, "SSC Exams ", "tab__text") +
      tab(SSC, 0, "SSC Exams", "h3"); // mobile duplicate
    expect(parseCategories(html)).toEqual([
      { id: SSC, index: 0, title: "SSC Exams" },
      { id: BANK, index: 1, title: "Data Science & Analytics" },
    ]);
  });
});

describe("buildImportPlan", () => {
  it("puts each exam once, under its primary category, and drops empty categories", () => {
    expect(buildImportPlan(catalogue())).toEqual([
      {
        name: "SSC Exams",
        slug: "ssc-exams",
        testbookId: SSC,
        exams: [{ name: "SSC CGL", slug: "ssc-cgl", testbookId: "t1" }],
      },
      {
        name: "Banking Exams",
        slug: "banking-exams",
        testbookId: BANK,
        exams: [
          { name: "SBI Clerk", slug: "sbi-clerk", testbookId: "t2" },
          { name: "IBPS PO", slug: "ibps-po", testbookId: "t3" },
        ],
      },
    ]);
  });

  it("keeps empty categories with includeEmpty", () => {
    expect(buildImportPlan(catalogue(), { includeEmpty: true }).map((c) => c.name)).toContain("DIBO");
  });
});

describe("importPlan (add only)", () => {
  it("creates categories (appended after existing order) and unpublished series with testbookIds", async () => {
    await Category.create({ name: "Existing", order: 4 });

    const stats = await importPlan(buildImportPlan(catalogue()));
    expect(counts(stats)).toEqual([2, 0, 0, 3, 0, 0]);

    const cats = await Category.find().sort({ order: 1 }).lean();
    expect(cats.map((c) => [c.name, c.slug, c.order, c.testbookId])).toEqual([
      ["Existing", "existing", 4, undefined],
      ["SSC Exams", "ssc-exams", 5, SSC],
      ["Banking Exams", "banking-exams", 6, BANK],
    ]);

    const bank = cats.find((c) => c.name === "Banking Exams");
    const series = await TestSeries.find({ category: bank._id }).sort({ name: 1 }).lean();
    expect(series.map((s) => [s.name, s.slug, s.testbookId, s.isPublished, s.isActive])).toEqual([
      ["IBPS PO", "ibps-po", "t3", false, true],
      ["SBI Clerk", "sbi-clerk", "t2", false, true],
    ]);
    expect(series[0].createdAt).toBeInstanceOf(Date);
  });

  it("is idempotent and never overwrites existing categories or series", async () => {
    const ssc = await Category.create({ name: "ssc exams", description: "mine", order: 1 });
    const other = await Category.create({ name: "Other", order: 2 });
    await TestSeries.create({ name: "SSC CGL", category: other._id, isPublished: true, description: "edited" });

    expect(counts(await importPlan(buildImportPlan(catalogue())))).toEqual([1, 0, 1, 2, 0, 1]);
    expect(counts(await importPlan(buildImportPlan(catalogue())))).toEqual([0, 0, 2, 0, 0, 3]);

    expect(await Category.countDocuments()).toBe(3);
    const sscAfter = await Category.findById(ssc._id).lean();
    expect([sscAfter.name, sscAfter.description, sscAfter.testbookId]).toEqual(["ssc exams", "mine", undefined]);
    const cgl = await TestSeries.findOne({ slug: "ssc-cgl" }).lean();
    expect([String(cgl.category), cgl.isPublished, cgl.description, cgl.testbookId]).toEqual([
      String(other._id),
      true,
      "edited",
      undefined,
    ]);
  });

  it("does not duplicate an exam Testbook renamed (matched by testbookId)", async () => {
    await importPlan(buildImportPlan(catalogue()));
    const renamed = catalogue();
    renamed[1].targets[1] = target("t3", "IBPS PO 2026", BANK);

    expect(counts(await importPlan(buildImportPlan(renamed)))).toEqual([0, 0, 2, 0, 0, 3]);
    expect(await TestSeries.countDocuments()).toBe(3);
    expect(await TestSeries.findOne({ testbookId: "t3" }).lean()).toMatchObject({ name: "IBPS PO" });
  });
});

describe("importPlan --update", () => {
  it("renames, moves and backfills testbookId but leaves admin fields alone", async () => {
    await importPlan(buildImportPlan(catalogue()));
    const other = await Category.create({ name: "Other", order: 9 });
    // Admin edits: moves SSC CGL, publishes it, writes a description.
    await TestSeries.updateOne({ testbookId: "t1" }, { category: other._id, isPublished: true, description: "edited" });
    // Admin-created series sharing a Testbook exam's name (no testbookId yet).
    await TestSeries.deleteOne({ testbookId: "t2" });
    await TestSeries.create({ name: "SBI Clerk", category: other._id, price: 99 });

    const changed = catalogue();
    changed[0].title = "SSC Exams 2026"; // category renamed
    changed[1].targets[1] = target("t3", "IBPS PO 2026", BANK); // exam renamed

    const stats = await importPlan(buildImportPlan(changed), { update: true });
    expect(counts(stats)).toEqual([0, 1, 1, 0, 3, 0]);
    expect(stats.conflicts).toEqual([]);

    const ssc = await Category.findOne({ testbookId: SSC }).lean();
    expect([ssc.name, ssc.slug, ssc.order]).toEqual(["SSC Exams 2026", "ssc-exams-2026", 1]);
    const bank = await Category.findOne({ testbookId: BANK }).lean();

    const cgl = await TestSeries.findOne({ testbookId: "t1" }).lean();
    expect([String(cgl.category), cgl.isPublished, cgl.description]).toEqual([String(ssc._id), true, "edited"]);

    const ibps = await TestSeries.findOne({ testbookId: "t3" }).lean();
    expect([ibps.name, ibps.slug]).toEqual(["IBPS PO 2026", "ibps-po-2026"]);

    const sbi = await TestSeries.findOne({ slug: "sbi-clerk" }).lean();
    expect([sbi.testbookId, String(sbi.category), sbi.price]).toEqual(["t2", String(bank._id), 99]);
    expect(await TestSeries.countDocuments()).toBe(3);

    // Re-running with nothing new changes nothing.
    expect(counts(await importPlan(buildImportPlan(changed), { update: true }))).toEqual([0, 0, 2, 0, 0, 3]);
  });

  it("skips a rename whose new name is already taken and reports it", async () => {
    await importPlan(buildImportPlan(catalogue()));
    const bank = await Category.findOne({ testbookId: BANK });
    await TestSeries.create({ name: "IBPS PO 2026", category: bank._id }); // someone else owns the new name

    const changed = catalogue();
    changed[1].targets[1] = target("t3", "IBPS PO 2026", BANK);

    const stats = await importPlan(buildImportPlan(changed), { update: true });
    expect(stats.conflicts).toEqual(['exam "IBPS PO" -> "IBPS PO 2026": name already used']);
    expect(await TestSeries.findOne({ testbookId: "t3" }).lean()).toMatchObject({ name: "IBPS PO", slug: "ibps-po" });
    expect(await TestSeries.countDocuments()).toBe(4);
  });
});
