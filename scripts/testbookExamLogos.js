// scripts/testbookExamLogos.js
//
// `--logos` step of importTestbookExams.js: downloads each exam's logo (the
// exam body's logo, from the Testbook catalogue API) and sets it as the
// TestSeries image — ONLY for exams that have no image yet, so anything an
// admin uploaded is kept. Category icons are not fetched.
//
// Files are stored exactly like an admin upload (uploads/testseries_image/
// image-<seriesId>-…), so admins can replace them from the admin panel.
// Only PNG/JPEG/WebP/GIF, checked by the file's bytes (no SVG: served from our
// own origin, an SVG could carry script).

import TestSeries from "../models/TestSeries.js";
import { removeOldUpload, saveUpload } from "./uploadFiles.js";

const MAX_BYTES = 2 * 1024 * 1024; // logos are ~10 KB; anything huge is wrong

// The file's own bytes decide its type (some CDN responses say
// application/octet-stream), and anything that isn't PNG/JPEG/WebP/GIF is
// refused whatever the header claims. Returns the extension or "".
export function sniffImageExt(data) {
  if (!data || data.length < 12) return "";
  if (data[0] === 0x89 && data.toString("latin1", 1, 4) === "PNG") return ".png";
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return ".jpg";
  if (data.toString("latin1", 0, 4) === "GIF8") return ".gif";
  if (data.toString("latin1", 0, 4) === "RIFF" && data.toString("latin1", 8, 12) === "WEBP") return ".webp";
  return "";
}

// "//cdn.example.com/a.png" -> "https://cdn.example.com/a.png"; junk -> "".
export function logoUrl(raw) {
  if (typeof raw !== "string" || !raw.trim()) return "";
  const s = raw.trim();
  const withScheme = s.startsWith("//") ? `https:${s}` : s;
  try {
    const url = new URL(withScheme);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}

const EMPTY_IMAGE = { $or: [{ image: "" }, { image: { $exists: false } }, { image: null }] };

async function mapLimit(items, limit, fn) {
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// fetchImage(url) -> { contentType, data: Buffer }.
export async function fillExamLogos(
  plan,
  { fetchImage, uploadDir, dryRun = false, limit = Infinity, concurrency = 3, onProgress = () => {} } = {}
) {
  if (!dryRun && !uploadDir) throw new Error("uploadDir is required");
  const exams = plan.flatMap((c) => c.exams).filter((e) => logoUrl(e.logo));
  const stats = { total: 0, set: 0, failed: [], noLogo: plan.flatMap((c) => c.exams).length - exams.length };

  const docs = await TestSeries.find({
    $and: [
      EMPTY_IMAGE,
      { $or: [{ testbookId: { $in: exams.map((e) => e.testbookId) } }, { slug: { $in: exams.map((e) => e.slug) } }] },
    ],
  })
    .select("slug testbookId")
    .lean();
  const byTb = new Map(docs.filter((d) => d.testbookId).map((d) => [d.testbookId, d]));
  const bySlug = new Map(docs.map((d) => [d.slug, d]));
  const todo = exams
    .map((exam) => ({ exam, doc: byTb.get(exam.testbookId) ?? bySlug.get(exam.slug) }))
    .filter((t) => t.doc)
    .slice(0, limit);
  stats.total = todo.length;

  if (dryRun) {
    stats.set = todo.length;
    return stats;
  }

  await mapLimit(todo, concurrency, async ({ exam, doc }, idx) => {
    try {
      const { contentType, data } = await fetchImage(logoUrl(exam.logo));
      if (!data?.length || data.length > MAX_BYTES) throw new Error(`bad size (${data?.length ?? 0} bytes)`);
      const ext = sniffImageExt(data);
      if (!ext) throw new Error(`not a supported image (${contentType || "no type"})`);

      const url = saveUpload(data, uploadDir, "testseries_image", "image", doc._id, ext);
      // Re-check emptiness so an admin upload made mid-run wins.
      const res = await TestSeries.updateOne({ _id: doc._id, ...EMPTY_IMAGE }, { $set: { image: url } });
      if (res.modifiedCount) stats.set++;
      else removeOldUpload(url, uploadDir);
    } catch (err) {
      stats.failed.push({ exam: exam.name, error: err.message });
    } finally {
      onProgress(idx + 1, todo.length);
    }
  });
  return stats;
}
