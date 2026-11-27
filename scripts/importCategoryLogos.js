// scripts/importCategoryLogos.js
//
// Sets category images (and optionally their exams' images) from a folder of
// logo files you provide — e.g. official logos downloaded from ssc.gov.in.
// Files are matched to categories by name: "SSC Exams.png", "ssc-exams.png"
// and "SSC_Exams.webp" all match the category "SSC Exams".
//
// Usage (from testopy-backend-code/, ON THE MACHINE THE SERVER RUNS ON —
// images are stored in its local uploads/ folder):
//   node scripts/importCategoryLogos.js <folder> --dry-run     # show matches, change nothing
//   node scripts/importCategoryLogos.js <folder>               # set empty category images
//   node scripts/importCategoryLogos.js <folder> --series      # …and empty exam (series) images too
//   node scripts/importCategoryLogos.js <folder> --overwrite   # also replace existing category images
//
// Each record gets its OWN copy, stored exactly like an admin upload
// (uploads/category_image/categoryImage-<id>-…, uploads/testseries_image/image-<id>-…).
// That matters: when an admin later replaces an image from the admin panel
// the backend deletes the old file, so shared files would break other records.
// Series images are only ever filled when empty — --overwrite never touches them.

import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import dotenv from "dotenv";
import mongoose from "mongoose";
import Category from "../models/Category.js";
import TestSeries from "../models/TestSeries.js";
import { slugify } from "../utils/slugify.js";
import { removeOldUpload, saveUpload, serverUploadDir } from "./uploadFiles.js";

export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".svg", ".gif"]);
const MAX_BYTES = 20 * 1024 * 1024; // same limit as middleware/upload.js

// "SSC_Exams (1).PNG" -> "ssc-exams-1"; "State Govt. Exams" -> "state-govt-exams"
export const logoKey = (name) =>
  slugify(name.replace(/[_.]+/g, " ").replace(/\s+/g, " ").trim()).replace(/-+/g, "-").replace(/^-|-$/g, "");

// Pure: folder file names + categories -> what goes where.
export function matchLogos(fileNames, categories) {
  const byKey = new Map();
  for (const c of categories) {
    byKey.set(logoKey(c.name), c);
    if (c.slug) byKey.set(logoKey(c.slug), c);
  }
  const matches = [];
  const unmatchedFiles = [];
  const used = new Set();
  for (const file of [...fileNames].sort()) {
    const ext = path.extname(file).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) continue;
    const category = byKey.get(logoKey(path.basename(file, path.extname(file))));
    if (!category || used.has(String(category._id))) {
      unmatchedFiles.push(file);
      continue;
    }
    used.add(String(category._id));
    matches.push({ file, category });
  }
  const categoriesWithoutLogo = categories.filter((c) => !used.has(String(c._id))).map((c) => c.name);
  return { matches, unmatchedFiles, categoriesWithoutLogo };
}

// Copies `src` into uploads/<subdir>/ named like multer would, returns the /uploads/... URL.
const copyAsUpload = (src, uploadDir, subdir, fieldname, entityId) =>
  saveUpload(fs.readFileSync(src), uploadDir, subdir, fieldname, entityId, path.extname(src));

export async function applyLogos(folder, { uploadDir, series = false, overwrite = false, dryRun = false } = {}) {
  if (!uploadDir) throw new Error("uploadDir is required");
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) throw new Error(`Not a folder: ${folder}`);

  const categories = await Category.find().select("name slug image").lean();
  const { matches, unmatchedFiles, categoriesWithoutLogo } = matchLogos(fs.readdirSync(folder), categories);
  const stats = {
    matched: matches.length,
    categoriesSet: 0,
    categoriesKept: 0,
    seriesSet: 0,
    tooLarge: [],
    unmatchedFiles,
    categoriesWithoutLogo,
  };

  for (const { file, category } of matches) {
    const src = path.join(folder, file);
    if (fs.statSync(src).size > MAX_BYTES) {
      stats.tooLarge.push(file);
      continue;
    }

    if (category.image && !overwrite) {
      stats.categoriesKept++;
    } else if (dryRun) {
      stats.categoriesSet++;
    } else {
      const url = copyAsUpload(src, uploadDir, "category_image", "categoryImage", category._id);
      // Filter on the value we read, so an admin upload made mid-run wins.
      const current = category.image ? category.image : { $in: ["", null] };
      const res = await Category.updateOne({ _id: category._id, image: current }, { $set: { image: url } });
      if (res.modifiedCount) {
        stats.categoriesSet++;
        if (category.image) removeOldUpload(category.image, uploadDir); // same as the admin replace flow
      } else {
        removeOldUpload(url, uploadDir); // lost the race — don't leave an orphan file
      }
    }

    if (!series) continue;
    const empty = await TestSeries.find({
      category: category._id,
      $or: [{ image: "" }, { image: { $exists: false } }, { image: null }],
    })
      .select("_id")
      .lean();
    if (dryRun) {
      stats.seriesSet += empty.length;
      continue;
    }
    for (const s of empty) {
      const url = copyAsUpload(src, uploadDir, "testseries_image", "image", s._id);
      const res = await TestSeries.updateOne(
        { _id: s._id, $or: [{ image: "" }, { image: { $exists: false } }, { image: null }] },
        { $set: { image: url } }
      );
      if (res.modifiedCount) stats.seriesSet++;
      else removeOldUpload(url, uploadDir);
    }
  }
  return stats;
}

function parseArgs(argv) {
  const opts = { folder: null, series: false, overwrite: false, dryRun: false };
  const flags = { "--series": "series", "--overwrite": "overwrite", "--dry-run": "dryRun" };
  for (const a of argv) {
    if (flags[a]) opts[flags[a]] = true;
    else if (a.startsWith("--")) throw new Error(`Unknown option: ${a}`);
    else if (!opts.folder) opts.folder = a;
    else throw new Error(`Unexpected argument: ${a}`);
  }
  if (!opts.folder) throw new Error("Usage: node scripts/importCategoryLogos.js <folder> [--series] [--overwrite] [--dry-run]");
  return opts;
}

async function main() {
  const { folder, series, overwrite, dryRun } = parseArgs(process.argv.slice(2));
  const backendRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  dotenv.config({ path: path.join(backendRoot, ".env") });
  if (!process.env.mongoDB_URL) throw new Error("mongoDB_URL is not set (.env).");

  const uploadDir = serverUploadDir(backendRoot);

  const { default: connectDB } = await import("../db.js");
  await connectDB();
  try {
    const s = await applyLogos(path.resolve(folder), { uploadDir, series, overwrite, dryRun });
    const verb = dryRun ? "Would set" : "Set";
    console.log(
      `${s.matched} logo file(s) matched a category.\n` +
        `${verb} ${s.categoriesSet} category image(s); kept ${s.categoriesKept} existing` +
        `${overwrite ? "" : " (use --overwrite to replace)"}.` +
        (series ? `\n${verb} ${s.seriesSet} exam image(s) (only exams with no image).` : "")
    );
    if (s.unmatchedFiles.length) console.log(`\nFiles that match no category:\n  ${s.unmatchedFiles.join("\n  ")}`);
    if (s.tooLarge.length) console.log(`\nSkipped, over 20 MB:\n  ${s.tooLarge.join("\n  ")}`);
    if (s.categoriesWithoutLogo.length) {
      console.log(`\nCategories with no logo file (name a file like "<category name>.png"):`);
      console.log(`  ${s.categoriesWithoutLogo.join("\n  ")}`);
    }
    if (dryRun) console.log("\nDry run — nothing written.");
  } finally {
    await mongoose.disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Logo import failed:", err.message);
    process.exit(1);
  });
}
