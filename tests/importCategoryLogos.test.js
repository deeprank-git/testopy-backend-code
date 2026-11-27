import fs from "fs";
import os from "os";
import path from "path";
import { connectTestDb, disconnectTestDb, clearTestDb } from "./testDb.js";
import Category from "../models/Category.js";
import TestSeries from "../models/TestSeries.js";
import { applyLogos, logoKey, matchLogos } from "../scripts/importCategoryLogos.js";

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

let tmp;
let logos;
let uploads;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "logos-"));
  logos = path.join(tmp, "logos");
  uploads = path.join(tmp, "uploads");
  fs.mkdirSync(logos);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

const write = (name, body = "png-bytes") => fs.writeFileSync(path.join(logos, name), body);
const exists = (url) => fs.existsSync(path.join(uploads, url.slice("/uploads/".length)));
const read = (url) => fs.readFileSync(path.join(uploads, url.slice("/uploads/".length)), "utf8");

describe("logoKey / matchLogos", () => {
  it("normalises names so files match categories loosely", () => {
    expect(logoKey("SSC Exams")).toBe("ssc-exams");
    expect(logoKey("SSC_Exams")).toBe("ssc-exams");
    expect(logoKey("State Govt. Exams")).toBe("state-govt-exams");
    expect(logoKey("Data Science & Analytics")).toBe("data-science-analytics");
  });

  it("matches by name or slug, ignores non-images, reports leftovers both ways", () => {
    const cats = [
      { _id: "a", name: "SSC Exams", slug: "ssc-exams" },
      { _id: "b", name: "Banking Exams", slug: "banking-exams" },
      { _id: "c", name: "Police Exams", slug: "police-exams" },
    ];
    const r = matchLogos(["ssc-exams.png", "Banking_Exams.JPG", "readme.txt", "random.png", "SSC Exams.webp"], cats);
    expect(r.matches.map((m) => [m.file, m.category._id])).toEqual([
      ["Banking_Exams.JPG", "b"],
      ["SSC Exams.webp", "a"],
    ]);
    expect(r.unmatchedFiles).toEqual(["random.png", "ssc-exams.png"]); // second file for SSC is a leftover
    expect(r.categoriesWithoutLogo).toEqual(["Police Exams"]);
  });
});

describe("applyLogos", () => {
  it("gives each category and empty-image exam its own upload-style copy", async () => {
    const ssc = await Category.create({ name: "SSC Exams" });
    const bank = await Category.create({ name: "Banking Exams", image: "/uploads/category_image/admin.png" });
    const cgl = await TestSeries.create({ name: "SSC CGL", category: ssc._id });
    const chsl = await TestSeries.create({ name: "SSC CHSL", category: ssc._id, image: "/uploads/testseries_image/mine.png" });
    write("SSC Exams.png", "ssc-logo");
    write("banking-exams.png", "bank-logo");

    const stats = await applyLogos(logos, { uploadDir: uploads, series: true });
    expect([stats.matched, stats.categoriesSet, stats.categoriesKept, stats.seriesSet]).toEqual([2, 1, 1, 1]);

    const sscImage = (await Category.findById(ssc._id).lean()).image;
    expect(sscImage).toMatch(new RegExp(`^/uploads/category_image/categoryImage-${ssc._id}-\\d+-\\d+\\.png$`));
    expect(read(sscImage)).toBe("ssc-logo");
    expect((await Category.findById(bank._id).lean()).image).toBe("/uploads/category_image/admin.png");

    const cglImage = (await TestSeries.findById(cgl._id).lean()).image;
    expect(cglImage).toMatch(new RegExp(`^/uploads/testseries_image/image-${cgl._id}-\\d+-\\d+\\.png$`));
    expect(cglImage).not.toBe(sscImage);
    expect(read(cglImage)).toBe("ssc-logo");
    expect((await TestSeries.findById(chsl._id).lean()).image).toBe("/uploads/testseries_image/mine.png");
  });

  it("--overwrite replaces category images (deleting the old upload) but never exam images", async () => {
    fs.mkdirSync(path.join(uploads, "category_image"), { recursive: true });
    fs.writeFileSync(path.join(uploads, "category_image", "old.png"), "old");
    const ssc = await Category.create({ name: "SSC Exams", image: "/uploads/category_image/old.png" });
    await TestSeries.create({ name: "SSC CGL", category: ssc._id, image: "/uploads/testseries_image/mine.png" });
    write("ssc-exams.png", "new-logo");

    const stats = await applyLogos(logos, { uploadDir: uploads, series: true, overwrite: true });
    expect([stats.categoriesSet, stats.seriesSet]).toEqual([1, 0]);
    const image = (await Category.findById(ssc._id).lean()).image;
    expect(read(image)).toBe("new-logo");
    await new Promise((r) => setTimeout(r, 50)); // unlink is async
    expect(exists("/uploads/category_image/old.png")).toBe(false);
    expect((await TestSeries.findOne({ name: "SSC CGL" }).lean()).image).toBe("/uploads/testseries_image/mine.png");
  });

  it("dry run counts but writes no files and changes nothing", async () => {
    const ssc = await Category.create({ name: "SSC Exams" });
    await TestSeries.create({ name: "SSC CGL", category: ssc._id });
    write("ssc-exams.png");

    const stats = await applyLogos(logos, { uploadDir: uploads, series: true, dryRun: true });
    expect([stats.categoriesSet, stats.seriesSet]).toEqual([1, 1]);
    expect(fs.existsSync(uploads)).toBe(false);
    expect((await Category.findById(ssc._id).lean()).image).toBe("");
  });

  it("is safe to re-run: nothing changes the second time", async () => {
    const ssc = await Category.create({ name: "SSC Exams" });
    await TestSeries.create({ name: "SSC CGL", category: ssc._id });
    write("ssc-exams.png");

    await applyLogos(logos, { uploadDir: uploads, series: true });
    const again = await applyLogos(logos, { uploadDir: uploads, series: true });
    expect([again.categoriesSet, again.categoriesKept, again.seriesSet]).toEqual([0, 1, 0]);
    expect(fs.readdirSync(path.join(uploads, "category_image"))).toHaveLength(1);
    expect(fs.readdirSync(path.join(uploads, "testseries_image"))).toHaveLength(1);
  });
});
