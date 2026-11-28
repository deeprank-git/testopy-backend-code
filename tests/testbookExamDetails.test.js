import { connectTestDb, disconnectTestDb, clearTestDb } from "./testDb.js";
import Category from "../models/Category.js";
import TestSeries from "../models/TestSeries.js";
import { parseDateRange, parseExamPage, fillExamDetails, mergeImportedDates } from "../scripts/testbookExamDetails.js";
import { normalizeImportantDates } from "../utils/importantDates.js";

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

describe("parseDateRange", () => {
  it.each([
    ["21st May 2026", "2026-05-21", "2026-05-21"],
    ["01 July 2026", "2026-07-01", "2026-07-01"],
    ["1st July 2026 to 3rd July 2026", "2026-07-01", "2026-07-03"],
    ["1st July 2026 - 3rd July 2026", "2026-07-01", "2026-07-03"],
    ["23rd June to 25th June 2026", "2026-06-23", "2026-06-25"],
    ["29 &amp; 30 July 2026".replace("&amp;", "&"), "2026-07-29", "2026-07-30"],
    ["30th September to 30th October 2026", "2026-09-30", "2026-10-30"],
    ["September 30, 2026", "2026-09-30", "2026-09-30"],
    // Testbook keeps the struck-out date next to the revised one: last wins.
    ["22nd June 2026 26th June 2026 (23:00 hours)", "2026-06-26", "2026-06-26"],
    ["21 July 2026 26th July 2026(Extended)", "2026-07-26", "2026-07-26"],
    ["2nd Nov 2026 onwards", "2026-11-02", "2026-11-02"],
    ["28th Dec 2026 to 3rd Jan 2027", "2026-12-28", "2027-01-03"],
  ])("%s", (text, from, to) => {
    expect(parseDateRange(text)).toEqual({ from, to });
  });

  it.each(["TBA", "To be Announced", "December 2026", "21st September", "31st February 2026", "5th July 2026 to 1st July 2026", ""])(
    "rejects %j",
    (text) => {
      expect(parseDateRange(text)).toBeNull();
    }
  );
});

const page = `
<h2>SSC CGL 2026: Overview</h2>
<table>
  <tr><td>Conducting Body</td><td><a href="https://ssc.gov.in/">Staff Selection Commission</a></td></tr>
  <tr><td>Vacancies</td><td>12256</td></tr>
  <tr><td>SSC CGL 2026 Notification</td><td>21st May 2026</td></tr>
  <tr><td>Application End Date</td><td><s>22nd June 2026</s> 25th June 2026</td></tr>
</table>
<h2>SSC CGL Recruitment 2026 Dates</h2>
<table>
  <tr><th>Events</th><th>Dates</th></tr>
  <tr><td>SSC CGL 2026 Notification Release Date</td><td>21st May 2026</td></tr>
  <tr><td>Last Date to Apply for SSC CGL</td><td>22nd June 2026</td></tr>
  <tr><td>Cycle</td><td>2025</td><td>2026</td></tr>
  <tr><td>Admit Card</td><td>4th Feb, 2026</td><td>To Be Announced</td></tr>
  <tr><td>SSC CGL City Intimation Slip 2026</td><td>21st September</td></tr>
  <tr><td>Tier 1 Exam Date</td><td>30th September to 30th October 2026</td></tr>
  <tr><td>Tier 2 Exam Date</td><td>December 2026</td></tr>
  <tr><td>Interview</td><td>TBA</td></tr>
  <tr><td>One Application Rule</td><td>Multiple entries may lead to disqualification.</td></tr>
  <tr><td>Fee Payment Last Date</td><td>26th June 2026 (Extended)</td></tr>
  <tr><td>Result</td><td>Check on the Testbook app</td></tr>
  <tr><td>Exam Cycle</td><td>Phase XIV/2026</td></tr>
  <tr><td>Answer Key</td><td>2nd Nov 2026 (visit testbook.com)</td></tr>
  <tr><td>Testbook Pass Offer</td><td>Till 30th Nov 2026</td></tr>
</table>
<h2>SSC CGL Salary 2026</h2>
<table><tr><td>Basic Pay</td><td>1st July 2026</td></tr></table>
<p><a href="https://www.youtube.com/x">video</a></p>`;

describe("parseExamPage", () => {
  it("extracts the official website and dates as exact days, text, or both", () => {
    const parsed = parseExamPage(page, "SSC CGL");
    expect(parsed).toEqual({
      officialWebsite: "https://ssc.gov.in/",
      importantDates: {
        "Notification Release Date": { from: "2026-05-21", to: "2026-05-21" },
        "Last Date to Apply": { from: "2026-06-22", to: "2026-06-22" },
        // Multi-cycle rows (3+ cells) are ignored: the old cycle's dates would be stale.
        "City Intimation Slip": { text: "21st September" },
        "Tier 1 Exam Date": { from: "2026-09-30", to: "2026-10-30" },
        "Tier 2 Exam Date": { text: "December 2026" },
        Interview: { text: "TBA" },
        "Fee Payment Last Date": { from: "2026-06-26", to: "2026-06-26", text: "Extended" },
        // Exact date kept; the note pointing at another site is dropped.
        "Answer Key": { from: "2026-11-02", to: "2026-11-02" },
        // From the overview; its "Notification" row repeats a date already taken.
        "Application End Date": { from: "2026-06-25", to: "2026-06-25" },
      },
      // "Check on the Testbook app" and the "Testbook Pass Offer" row are dropped silently.
      skipped: [{ label: "Exam Cycle", value: "Phase XIV/2026" }],
    });
    // Whatever the script stores must pass the API's own rule.
    expect(normalizeImportantDates(parsed.importantDates)).toEqual(parsed.importantDates);
    expect(JSON.stringify(parsed.importantDates)).not.toMatch(/testbook/i);
  });

  it("ignores social / Testbook links and pages with no date tables", () => {
    const html = `<h2>X Overview</h2><table><tr><td>Website</td><td><a href="https://testbook.com/x">tb</a> <a href="https://t.me/x">tg</a></td></tr></table>`;
    expect(parseExamPage(html, "X")).toEqual({ officialWebsite: "", importantDates: {}, skipped: [] });
  });
});

describe("fillExamDetails", () => {
  const plan = [
    {
      name: "SSC Exams",
      exams: [
        { name: "SSC CGL", slug: "ssc-cgl", testbookId: "t1", pageSlug: "ssc-cgl-exam" },
        { name: "SSC CHSL", slug: "ssc-chsl", testbookId: "t2", pageSlug: "ssc-chsl" },
        { name: "SSC MTS", slug: "ssc-mts", testbookId: "t3", pageSlug: "ssc-mts" },
        { name: "SSC GD", slug: "ssc-gd", testbookId: "t4", pageSlug: "ssc-gd" },
      ],
    },
  ];
  const fetchPage = async (slug) => {
    if (slug === "ssc-gd") throw new Error("HTTP 503");
    return page;
  };

  it("fills only empty fields, never overwriting admin data", async () => {
    const cat = await Category.create({ name: "SSC Exams" });
    await TestSeries.create({ name: "SSC CGL", testbookId: "t1", category: cat._id });
    await TestSeries.create({
      name: "SSC CHSL",
      testbookId: "t2",
      category: cat._id,
      officialWebsite: "https://admin.example/",
    });
    const adminDates = { "Exam Date": { from: "2026-01-01", to: "2026-01-01" } };
    await TestSeries.create({
      name: "SSC MTS",
      category: cat._id, // no testbookId yet — matched by slug
      officialWebsite: "https://admin.example/",
      importantDates: adminDates,
    });
    await TestSeries.create({ name: "SSC GD", testbookId: "t4", category: cat._id });

    const fetched = [];
    const stats = await fillExamDetails(plan, { fetchPage: async (s) => (fetched.push(s), fetchPage(s)) });

    expect(fetched.sort()).toEqual(["ssc-cgl-exam", "ssc-chsl", "ssc-gd"]); // MTS needs nothing
    expect([stats.total, stats.checked, stats.websiteFilled, stats.datesFilled]).toEqual([3, 2, 1, 2]);
    expect(stats.failed).toEqual([{ exam: "SSC GD", error: "HTTP 503" }]);
    expect(stats.skipped.map((s) => s.exam).sort()).toEqual(["SSC CGL", "SSC CHSL"]);

    const cgl = await TestSeries.findOne({ slug: "ssc-cgl" }).lean();
    expect(cgl.officialWebsite).toBe("https://ssc.gov.in/");
    expect(Object.keys(cgl.importantDates)).toHaveLength(9);

    const chsl = await TestSeries.findOne({ slug: "ssc-chsl" }).lean();
    expect(chsl.officialWebsite).toBe("https://admin.example/");
    expect(Object.keys(chsl.importantDates)).toHaveLength(9);

    const mts = await TestSeries.findOne({ slug: "ssc-mts" }).lean();
    expect([mts.officialWebsite, mts.importantDates]).toEqual(["https://admin.example/", adminDates]);

    // Second run: only the failed page still needs data.
    const again = await fillExamDetails(plan, { fetchPage: async () => page });
    expect([again.total, again.websiteFilled, again.datesFilled]).toEqual([1, 1, 1]);
  });

  it("doesn't save a set that's only TBA, so real dates can still be added later", async () => {
    const cat = await Category.create({ name: "SSC Exams" });
    await TestSeries.create({ name: "SSC CGL", testbookId: "t1", category: cat._id });
    const tbaOnly = `<h2>Exam Dates</h2><table><tr><td>Exam Date</td><td>TBA</td></tr><tr><td>Admit Card</td><td>To be announced</td></tr></table>`;

    const stats = await fillExamDetails([{ exams: [plan[0].exams[0]] }], { fetchPage: async () => tbaOnly });
    expect([stats.datesFilled, stats.noData]).toEqual([0, 1]);
    expect((await TestSeries.findOne({ testbookId: "t1" }).lean()).importantDates).toBeUndefined();
  });

  it("dry run parses every page, honours limit, and writes nothing", async () => {
    const cat = await Category.create({ name: "SSC Exams" });
    await TestSeries.create({ name: "SSC CGL", testbookId: "t1", category: cat._id });

    const stats = await fillExamDetails(plan, { fetchPage, dryRun: true, limit: 2 });
    expect([stats.total, stats.checked, stats.websiteFilled, stats.datesFilled]).toEqual([2, 2, 2, 2]);
    expect(stats.preview[0]).toMatchObject({ officialWebsite: "https://ssc.gov.in/" });

    const cgl = await TestSeries.findOne({ slug: "ssc-cgl" }).lean();
    // Mongoose doesn't store an empty Mixed default, so it's simply absent.
    expect([cgl.officialWebsite, cgl.importantDates]).toEqual(["", undefined]);
  });
});

describe("mergeImportedDates", () => {
  const day = (d) => ({ from: d, to: d });

  it("upgrades, changes and adds imported dates but keeps admin edits", () => {
    const current = {
      "Tier 2 Exam Date": { text: "December 2026" }, // imported, untouched
      "Admit Card": day("2026-08-01"), // imported, then edited by an admin
      Result: { text: "Soon" }, // admin's own row
    };
    const lastImported = { "Tier 2 Exam Date": { text: "December 2026" }, "Admit Card": day("2026-07-01") };
    const fresh = {
      "Tier 2 Exam Date": day("2026-12-14"),
      "Admit Card": day("2026-07-05"),
      Interview: { text: "TBA" },
    };
    const r = mergeImportedDates(current, lastImported, fresh);
    expect(r.dates).toEqual({
      "Tier 2 Exam Date": day("2026-12-14"),
      "Admit Card": day("2026-08-01"),
      Result: { text: "Soon" },
      Interview: { text: "TBA" },
    });
    expect(r.imported).toEqual({
      "Tier 2 Exam Date": day("2026-12-14"),
      "Admit Card": day("2026-07-01"), // still the old import, so the admin's edit stays theirs
      Interview: { text: "TBA" },
    });
    expect(r.changed).toEqual(["Tier 2 Exam Date", "Interview"]);
  });

  it("never replaces exact dates with text, and keeps rows the page no longer lists", () => {
    const current = { "Exam Date": day("2026-09-01"), Old: { text: "May 2026" } };
    const lastImported = { "Exam Date": day("2026-09-01"), Old: { text: "May 2026" } };
    const r = mergeImportedDates(current, lastImported, { "Exam Date": { text: "TBA" } });
    expect(r.dates).toEqual(current);
    expect(r.changed).toEqual([]);
  });

  it("without a record of past imports, only upgrades text to exact dates", () => {
    const current = { "Tier 2 Exam Date": { text: "December 2026" }, "Exam Date": day("2026-09-01") };
    const fresh = { "Tier 2 Exam Date": day("2026-12-14"), "Exam Date": day("2026-09-05") };
    const r = mergeImportedDates(current, undefined, fresh);
    expect(r.dates).toEqual({ "Tier 2 Exam Date": day("2026-12-14"), "Exam Date": day("2026-09-01") });
    expect(r.imported).toEqual({ "Tier 2 Exam Date": day("2026-12-14") });
    expect(r.changed).toEqual(["Tier 2 Exam Date"]);
  });
});

describe("fillExamDetails with refreshDates", () => {
  const exam = { name: "SSC CGL", slug: "ssc-cgl", testbookId: "t1", pageSlug: "ssc-cgl-exam" };
  const table = (rows) =>
    `<h2>Exam Dates</h2><table>${rows.map(([l, v]) => `<tr><td>${l}</td><td>${v}</td></tr>`).join("")}</table>`;
  const v1 = table([["Tier 1 Exam Date", "30th September 2026"], ["Tier 2 Exam Date", "December 2026"]]);
  const v2 = table([["Tier 1 Exam Date", "30th September 2026"], ["Tier 2 Exam Date", "14th December 2026"], ["Result", "TBA"]]);
  const load = async () => TestSeries.findOne({ testbookId: "t1" }).select("+importedDates").lean();

  it("refreshes dates on a later run and leaves rows an admin edited", async () => {
    const cat = await Category.create({ name: "SSC Exams" });
    await TestSeries.create({ name: "SSC CGL", testbookId: "t1", category: cat._id, officialWebsite: "https://x.gov.in/" });
    await fillExamDetails([{ exams: [exam] }], { fetchPage: async () => v1 });
    const first = await load();
    expect(first.importedDates).toEqual(first.importantDates);

    // Without the option, an exam that has dates isn't read again.
    const plain = await fillExamDetails([{ exams: [exam] }], { fetchPage: async () => v2 });
    expect(plain.total).toBe(0);

    // An admin edits Tier 1; the refresh must leave it alone.
    await TestSeries.updateOne(
      { testbookId: "t1" },
      { $set: { "importantDates.Tier 1 Exam Date": { from: "2026-10-01", to: "2026-10-01" } } }
    );
    const stats = await fillExamDetails([{ exams: [exam] }], { fetchPage: async () => v2, refreshDates: true });
    expect([stats.total, stats.datesRefreshed, stats.datesFilled]).toEqual([1, 1, 0]);
    expect(stats.refreshed).toEqual([{ exam: "SSC CGL", labels: ["Tier 2 Exam Date", "Result"] }]);

    const after = await load();
    expect(after.importantDates).toEqual({
      "Tier 1 Exam Date": { from: "2026-10-01", to: "2026-10-01" },
      "Tier 2 Exam Date": { from: "2026-12-14", to: "2026-12-14" },
      Result: { text: "TBA" },
    });
    expect(after.officialWebsite).toBe("https://x.gov.in/");

    // Nothing new on the page -> nothing written.
    const again = await fillExamDetails([{ exams: [exam] }], { fetchPage: async () => v2, refreshDates: true });
    expect([again.checked, again.datesRefreshed]).toEqual([1, 0]);
  });

  it("refreshes dates in the same run that fills an empty website", async () => {
    const cat = await Category.create({ name: "SSC Exams" });
    await TestSeries.create({ name: "SSC CGL", testbookId: "t1", category: cat._id });
    await fillExamDetails([{ exams: [exam] }], { fetchPage: async () => v1 });
    const withSite = `<h2>SSC CGL Overview</h2><table><tr><td>Official Website</td><td><a href="https://ssc.gov.in/">ssc</a></td></tr></table>${v2}`;
    const stats = await fillExamDetails([{ exams: [exam] }], { fetchPage: async () => withSite, refreshDates: true });
    expect([stats.websiteFilled, stats.datesRefreshed]).toEqual([1, 1]);
    expect((await load()).importantDates["Tier 2 Exam Date"]).toEqual({ from: "2026-12-14", to: "2026-12-14" });
  });

  it("can't be a dry run", async () => {
    await expect(fillExamDetails([], { fetchPage: async () => "", dryRun: true, refreshDates: true })).rejects.toThrow(/dry run/);
  });

  it("keeps the import record out of API reads", async () => {
    const cat = await Category.create({ name: "SSC Exams" });
    await TestSeries.create({ name: "SSC CGL", testbookId: "t1", category: cat._id });
    await fillExamDetails([{ exams: [exam] }], { fetchPage: async () => v1 });
    expect((await TestSeries.findOne({ testbookId: "t1" }).lean()).importedDates).toBeUndefined();
  });
});
