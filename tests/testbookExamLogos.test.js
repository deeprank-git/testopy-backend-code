import fs from "fs";
import os from "os";
import path from "path";
import { connectTestDb, disconnectTestDb, clearTestDb } from "./testDb.js";
import Category from "../models/Category.js";
import TestSeries from "../models/TestSeries.js";
import { fillExamLogos, logoUrl, sniffImageExt } from "../scripts/testbookExamLogos.js";

// Minimal byte signatures (padded) for each accepted type, plus a tag to tell files apart.
const PNG = (tag) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]), Buffer.from(tag)]);
const WEBP = (tag) => Buffer.concat([Buffer.from("RIFF\0\0\0\0WEBP"), Buffer.from(tag)]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const GIF = Buffer.from("GIF89a\0\0\0\0\0\0");

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

let uploads;
beforeEach(() => {
  uploads = fs.mkdtempSync(path.join(os.tmpdir(), "exam-logos-"));
});
afterEach(() => fs.rmSync(uploads, { recursive: true, force: true }));

const read = (url) => fs.readFileSync(path.join(uploads, url.slice("/uploads/".length)));

describe("sniffImageExt", () => {
  it("identifies raster images by their bytes and refuses everything else", () => {
    expect(sniffImageExt(PNG("x"))).toBe(".png");
    expect(sniffImageExt(JPG)).toBe(".jpg");
    expect(sniffImageExt(GIF)).toBe(".gif");
    expect(sniffImageExt(WEBP("x"))).toBe(".webp");
    expect(sniffImageExt(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe("");
    expect(sniffImageExt(Buffer.from("<!doctype html><html></html>"))).toBe("");
    expect(sniffImageExt(Buffer.from("short"))).toBe("");
  });
});

describe("logoUrl", () => {
  it.each([
    ["//cdn.example.com/a/SSC_All_1.png", "https://cdn.example.com/a/SSC_All_1.png"],
    ["https://cdn.example.com/b%20c.webp", "https://cdn.example.com/b%20c.webp"],
    ["", ""],
    [undefined, ""],
    ["javascript:alert(1)", ""],
    ["not a url", ""],
  ])("%j -> %j", (raw, url) => {
    expect(logoUrl(raw)).toBe(url);
  });
});

describe("fillExamLogos", () => {
  const exam = (testbookId, name, logo) => ({ name, slug: name.toLowerCase().replace(/\s+/g, "-"), testbookId, logo });
  const plan = [
    {
      exams: [
        exam("t1", "SSC CGL", "//cdn.example.com/cgl.png"),
        exam("t2", "SSC CHSL", "//cdn.example.com/chsl.webp"),
        exam("t3", "SSC MTS", "//cdn.example.com/mts.png"),
        exam("t4", "SSC GD", "//cdn.example.com/gd.svg"),
        exam("t5", "SSC JE", ""),
        exam("t6", "SSC Steno", "//cdn.example.com/untitled_123"),
        exam("t7", "SSC JHT", "//cdn.example.com/fake.png"),
      ],
    },
  ];
  const files = {
    "https://cdn.example.com/cgl.png": { contentType: "image/png", data: PNG("cgl") },
    "https://cdn.example.com/chsl.webp": { contentType: "image/webp; charset=binary", data: WEBP("chsl") },
    "https://cdn.example.com/gd.svg": { contentType: "image/svg+xml", data: Buffer.from("<svg>.......</svg>") },
    // Real PNG served with a generic type, as some CDN entries are.
    "https://cdn.example.com/untitled_123": { contentType: "application/octet-stream", data: PNG("steno") },
    // Claims to be a PNG but is an HTML error page.
    "https://cdn.example.com/fake.png": { contentType: "image/png", data: Buffer.from("<!doctype html>not found") },
  };
  const fetchImage = async (url) => {
    if (!files[url]) throw new Error("HTTP 404");
    return files[url];
  };

  it("stores logos like admin uploads, only for exams with no image", async () => {
    const cat = await Category.create({ name: "SSC Exams" });
    const cgl = await TestSeries.create({ name: "SSC CGL", testbookId: "t1", category: cat._id });
    // No testbookId yet: matched by slug.
    const chsl = await TestSeries.create({ name: "SSC CHSL", category: cat._id });
    await TestSeries.create({ name: "SSC MTS", testbookId: "t3", category: cat._id });
    await TestSeries.create({ name: "SSC GD", testbookId: "t4", category: cat._id });
    await TestSeries.create({ name: "SSC JE", testbookId: "t5", category: cat._id, image: "/uploads/testseries_image/mine.png" });
    const steno = await TestSeries.create({ name: "SSC Steno", testbookId: "t6", category: cat._id });
    await TestSeries.create({ name: "SSC JHT", testbookId: "t7", category: cat._id });

    const stats = await fillExamLogos(plan, { fetchImage, uploadDir: uploads });
    expect([stats.total, stats.set, stats.noLogo]).toEqual([6, 3, 1]);
    expect(stats.failed.map((f) => f.exam).sort()).toEqual(["SSC GD", "SSC JHT", "SSC MTS"]);
    expect(stats.failed.find((f) => f.exam === "SSC GD").error).toMatch(/not a supported image/);
    expect(stats.failed.find((f) => f.exam === "SSC JHT").error).toMatch(/not a supported image/);

    const cglImage = (await TestSeries.findById(cgl._id).lean()).image;
    expect(cglImage).toMatch(new RegExp(`^/uploads/testseries_image/image-${cgl._id}-\\d+-\\d+\\.png$`));
    expect(read(cglImage)).toEqual(PNG("cgl"));
    const chslImage = (await TestSeries.findById(chsl._id).lean()).image;
    expect(chslImage).toMatch(/\.webp$/);
    expect(read(chslImage)).toEqual(WEBP("chsl"));
    expect((await TestSeries.findById(steno._id).lean()).image).toMatch(/\.png$/);

    // Stored path names only our ids — nothing about where it came from.
    expect(cglImage).not.toMatch(/cdn|example|cgl\.png/);
    expect((await TestSeries.findOne({ testbookId: "t5" }).lean()).image).toBe("/uploads/testseries_image/mine.png");
    expect((await TestSeries.findOne({ testbookId: "t4" }).lean()).image).toBe("");

    // Re-run: only the three that failed are retried.
    const again = await fillExamLogos(plan, { fetchImage, uploadDir: uploads });
    expect([again.total, again.set]).toEqual([3, 0]);
    expect(fs.readdirSync(path.join(uploads, "testseries_image"))).toHaveLength(3);
  });

  it("dry run counts without downloading or writing; limit caps work", async () => {
    const cat = await Category.create({ name: "SSC Exams" });
    for (const [id, name] of [["t1", "SSC CGL"], ["t2", "SSC CHSL"]]) {
      await TestSeries.create({ name, testbookId: id, category: cat._id });
    }
    let calls = 0;
    const dry = await fillExamLogos(plan, { fetchImage: async () => (calls++, files["x"]), dryRun: true });
    expect([dry.total, dry.set, calls]).toEqual([2, 2, 0]);

    const limited = await fillExamLogos(plan, { fetchImage, uploadDir: uploads, limit: 1 });
    expect([limited.total, limited.set]).toEqual([1, 1]);
  });
});
