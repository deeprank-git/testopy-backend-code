// scripts/importTestbookExams.js
//
// Imports the exam catalogue from https://testbook.com/exams into our DB:
//   Testbook "super group" (SSC Exams, Banking Exams, …) -> Category
//   Testbook "target"      (SSC CGL, IBPS PO, …)         -> TestSeries
//
// Usage (from testopy-backend-code/):
//   node scripts/importTestbookExams.js --dry-run         # fetch + print plan, no DB
//   node scripts/importTestbookExams.js                   # write to mongoDB_URL from .env
//   node scripts/importTestbookExams.js --include-empty   # also create categories with 0 exams
//   node scripts/importTestbookExams.js --update          # also sync existing records to Testbook
//   node scripts/importTestbookExams.js --details         # also fill empty officialWebsite /
//                                                         #   importantDates from each exam page
//   node scripts/importTestbookExams.js --details --dry-run --limit 20   # preview details, no DB
//
// --limit N caps how many exam pages --details reads (default: all, ~1,600
// pages, roughly 30–60 min). See scripts/testbookExamDetails.js.
//
// Matching: a record is matched by its stored testbookId first, then by
// slug (series) or slug/name (categories), so exams Testbook later renames
// aren't duplicated.
//
// Default mode only ADDS: anything that already exists is left untouched.
// --update also brings matched records in line with Testbook: renames them
// (name + slug), moves series to their Testbook category, and records the
// testbookId. It never touches description, image, order, isActive,
// isPublished, pricing, marks or tests, and never deletes anything. A rename
// whose new name is already taken by another record is skipped and reported.
//
// New series are created unpublished (TestSeries default), so they stay
// hidden from students until an admin adds tests and publishes them.
// Testbook logos are not imported — they're another site's branding, and
// resolveMediaUrl on the frontend would rewrite their absolute CDN URLs anyway.

import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import dotenv from "dotenv";
import mongoose from "mongoose";
import Category from "../models/Category.js";
import TestSeries from "../models/TestSeries.js";
import { slugify } from "../utils/slugify.js";
import { fillExamDetails } from "./testbookExamDetails.js";

const EXAMS_PAGE_URL = "https://testbook.com/exams";
const TARGETS_API_URL = (superGroupId) => `https://api.testbook.com/api/v1/tsg/${superGroupId}/targets`;
const USER_AGENT = "Mozilla/5.0 (compatible; exam-catalogue-import)";

const decodeEntities = (s) =>
  s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

// The /exams page server-renders one tab per super group, e.g.
//   cb-await-id="identifierswitchsupergroup_<24-hex id>_<index>"> … <span class="tab__text">SSC Exams</span>
// Each tab appears twice (desktop + mobile markup); keep the first per id.
export function parseCategories(html) {
  const re = /identifierswitchsupergroup_([0-9a-f]{24})_(\d+)"[\s\S]*?class="(?:tab__text|h3)">([^<]+)</g;
  const seen = new Map();
  let m;
  while ((m = re.exec(html))) {
    const [, id, index, title] = m;
    if (!seen.has(id)) seen.set(id, { id, index: Number(index), title: decodeEntities(title).trim() });
  }
  return [...seen.values()].sort((a, b) => a.index - b.index);
}

// categories: [{ id, title, targets: [testbook target] }] in display order.
// A target can belong to several super groups; it goes only under its primary
// one (TestSeries.slug is globally unique, so it can't be duplicated per category).
export function buildImportPlan(categories, { includeEmpty = false } = {}) {
  const categoryIds = new Set(categories.map((c) => c.id));
  const examsByCategory = new Map(categories.map((c) => [c.id, []]));
  const placed = new Set();

  for (const category of categories) {
    for (const target of category.targets) {
      const name = target.properties?.title?.trim();
      const slug = name && slugify(name);
      if (!slug || placed.has(slug)) continue;

      const primary = target.properties.superGroupInfo?.find((s) => s.isPrimary)?._id;
      const home = primary && categoryIds.has(primary) ? primary : category.id;
      examsByCategory.get(home).push({ name, slug, testbookId: target._id, pageSlug: target.slug });
      placed.add(slug);
    }
  }

  return categories
    .map((c) => ({ name: c.title, slug: slugify(c.title), testbookId: c.id, exams: examsByCategory.get(c.id) }))
    .filter((c) => includeEmpty || c.exams.length > 0);
}

const sameId = (a, b) => String(a) === String(b);

// Writes the plan and returns counts. Without `update` existing documents are
// never modified; with it, matched ones are synced (see header comment).
// `conflicts` lists renames skipped because the new name was already taken.
export async function importPlan(plan, { update = false } = {}) {
  const stats = {
    categoriesCreated: 0,
    categoriesUpdated: 0,
    categoriesUnchanged: 0,
    seriesCreated: 0,
    seriesUpdated: 0,
    seriesUnchanged: 0,
    conflicts: [],
  };

  // ── Categories (few — one query per write is fine) ──
  const cats = await Category.find().select("name slug order testbookId").lean();
  const catByTb = new Map(cats.filter((c) => c.testbookId).map((c) => [c.testbookId, c]));
  const catBySlug = new Map(cats.map((c) => [c.slug, c]));
  const catByName = new Map(cats.map((c) => [c.name.toLowerCase(), c]));
  let nextOrder = cats.reduce((max, c) => Math.max(max, c.order ?? 0), 0) + 1;
  const categoryIdFor = new Map(); // plan testbookId -> our _id

  for (const entry of plan) {
    let category =
      catByTb.get(entry.testbookId) ?? catBySlug.get(entry.slug) ?? catByName.get(entry.name.toLowerCase());

    if (!category) {
      category = (await Category.create({ name: entry.name, testbookId: entry.testbookId, order: nextOrder++ })).toObject();
      stats.categoriesCreated++;
    } else if (update) {
      const set = {};
      if (category.testbookId !== entry.testbookId) set.testbookId = entry.testbookId;
      if (category.name !== entry.name) {
        const owner = catBySlug.get(entry.slug) ?? catByName.get(entry.name.toLowerCase());
        if (owner && !sameId(owner._id, category._id)) {
          stats.conflicts.push(`category "${category.name}" -> "${entry.name}": name already used`);
        } else {
          set.name = entry.name; // pre("findOneAndUpdate") regenerates slug
        }
      }
      if (Object.keys(set).length) {
        catBySlug.delete(category.slug);
        catByName.delete(category.name.toLowerCase());
        category = await Category.findByIdAndUpdate(category._id, { $set: set }, { returnDocument: "after" }).lean();
        catBySlug.set(category.slug, category);
        catByName.set(category.name.toLowerCase(), category);
        stats.categoriesUpdated++;
      } else {
        stats.categoriesUnchanged++;
      }
    } else {
      stats.categoriesUnchanged++;
    }
    categoryIdFor.set(entry.testbookId, category._id);
  }

  // ── Series (~1,600 — diff in memory, write in one bulk) ──
  const series = await TestSeries.find().select("name slug category testbookId").lean();
  const serByTb = new Map(series.filter((s) => s.testbookId).map((s) => [s.testbookId, s]));
  const serBySlug = new Map(series.map((s) => [s.slug, s]));
  const ops = [];

  for (const entry of plan) {
    const categoryId = categoryIdFor.get(entry.testbookId);
    for (const exam of entry.exams) {
      const existing = serByTb.get(exam.testbookId) ?? serBySlug.get(exam.slug);

      if (!existing) {
        ops.push({
          updateOne: {
            filter: { slug: exam.slug },
            update: {
              $setOnInsert: { name: exam.name, slug: exam.slug, category: categoryId, testbookId: exam.testbookId },
            },
            upsert: true,
          },
        });
        serBySlug.set(exam.slug, { slug: exam.slug });
        stats.seriesCreated++;
        continue;
      }
      if (!update) {
        stats.seriesUnchanged++;
        continue;
      }

      const set = {};
      if (existing.testbookId !== exam.testbookId) set.testbookId = exam.testbookId;
      if (!sameId(existing.category, categoryId)) set.category = categoryId;
      if (existing.name !== exam.name) {
        const owner = serBySlug.get(exam.slug);
        if (owner && owner !== existing) {
          stats.conflicts.push(`exam "${existing.name}" -> "${exam.name}": name already used`);
        } else {
          // bulkWrite skips the pre("findOneAndUpdate") hook — set slug ourselves.
          set.name = exam.name;
          set.slug = exam.slug;
          serBySlug.delete(existing.slug);
          serBySlug.set(exam.slug, existing);
        }
      }

      if (Object.keys(set).length) {
        ops.push({ updateOne: { filter: { _id: existing._id }, update: { $set: set } } });
        stats.seriesUpdated++;
      } else {
        stats.seriesUnchanged++;
      }
    }
  }

  if (ops.length) await TestSeries.bulkWrite(ops, { ordered: true });
  return stats;
}

async function fetchWithRetry(url, as, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return as === "json" ? await res.json() : await res.text();
    } catch (err) {
      if (i >= attempts) throw new Error(`${url}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000 * i));
    }
  }
}

export async function fetchTestbookCatalogue() {
  const html = await fetchWithRetry(EXAMS_PAGE_URL, "text");
  const groups = parseCategories(html);
  if (groups.length === 0) throw new Error("No exam categories found on the Testbook page — markup may have changed.");

  const categories = [];
  for (const group of groups) {
    const json = await fetchWithRetry(TARGETS_API_URL(group.id), "json");
    categories.push({ ...group, targets: json?.data?.targets ?? [] });
    await new Promise((r) => setTimeout(r, 250)); // be polite
  }
  return categories;
}

function parseArgs(argv) {
  const opts = { dryRun: false, includeEmpty: false, update: false, details: false, limit: Infinity };
  const flags = { "--dry-run": "dryRun", "--include-empty": "includeEmpty", "--update": "update", "--details": "details" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (flags[a]) opts[flags[a]] = true;
    else if (a === "--limit") {
      opts.limit = Number(argv[++i]);
      if (!Number.isInteger(opts.limit) || opts.limit < 1) throw new Error("--limit needs a positive whole number");
    } else throw new Error(`Unknown option: ${a}`);
  }
  if (opts.limit !== Infinity && !opts.details) throw new Error("--limit only applies with --details");
  return opts;
}

const fetchExamPage = async (pageSlug) => {
  const html = await fetchWithRetry(`https://testbook.com/${encodeURIComponent(pageSlug)}`, "text");
  await new Promise((r) => setTimeout(r, 300)); // be polite
  return html;
};

async function runDetails(plan, { dryRun, limit }) {
  console.log(`\nReading exam pages for official website + important dates${dryRun ? " (dry run)" : ""} …`);
  const s = await fillExamDetails(plan, {
    fetchPage: fetchExamPage,
    dryRun,
    limit,
    onProgress: (done, total) => {
      if (done % 25 === 0 || done === total) console.log(`  ${done}/${total} pages`);
    },
  });

  if (dryRun) {
    for (const p of s.preview) {
      console.log(`\n${p.exam}`);
      if (p.officialWebsite) console.log(`  website: ${p.officialWebsite}`);
      for (const [label, { from, to }] of Object.entries(p.importantDates ?? {})) {
        console.log(`  ${label}: ${from === to ? from : `${from} → ${to}`}`);
      }
    }
  }
  if (s.skipped.length) {
    console.log(`\nDates that couldn't be read exactly — fill these in the admin panel if needed:`);
    for (const { exam, rows } of s.skipped) {
      console.log(`  ${exam}`);
      for (const r of rows) console.log(`    ${r.label}: ${r.value}`);
    }
  }
  if (s.failed.length) {
    console.log(`\nPages that failed to load:`);
    for (const f of s.failed) console.log(`  ${f.exam}: ${f.error}`);
  }
  console.log(
    `\nDetails: ${s.total} exam(s) needed data, ${s.checked} page(s) read, ${s.failed.length} failed.\n` +
      `  ${dryRun ? "Would fill" : "Filled"}: official website ${s.websiteFilled}, important dates ${s.datesFilled}; ` +
      `${s.noData} page(s) had nothing usable.`
  );
}

async function main() {
  const { dryRun, includeEmpty, update, details, limit } = parseArgs(process.argv.slice(2));

  console.log(`Fetching ${EXAMS_PAGE_URL} …`);
  const plan = buildImportPlan(await fetchTestbookCatalogue(), { includeEmpty });
  const total = plan.reduce((n, c) => n + c.exams.length, 0);
  for (const c of plan) console.log(`  ${c.name.padEnd(32)} ${String(c.exams.length).padStart(4)} exams`);
  console.log(`${plan.length} categories, ${total} exams.`);

  if (dryRun) {
    if (details) await runDetails(plan, { dryRun, limit });
    console.log("\nDry run — nothing written.");
    return;
  }

  dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
  if (!process.env.mongoDB_URL) throw new Error("mongoDB_URL is not set (.env).");
  const { default: connectDB } = await import("../db.js");
  await connectDB();
  try {
    const s = await importPlan(plan, { update });
    console.log(
      `Mode: ${update ? "add + update existing" : "add only (existing left untouched)"}\n` +
        `Categories: ${s.categoriesCreated} created, ${s.categoriesUpdated} updated, ${s.categoriesUnchanged} unchanged.\n` +
        `Exams (test series): ${s.seriesCreated} created, ${s.seriesUpdated} updated, ${s.seriesUnchanged} unchanged.`
    );
    if (s.conflicts.length) {
      console.log(`Skipped ${s.conflicts.length} rename(s) — target name already in use:`);
      for (const c of s.conflicts) console.log(`  ${c}`);
    }
    if (details) await runDetails(plan, { dryRun, limit });
  } finally {
    await mongoose.disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Import failed:", err.message);
    process.exit(1);
  });
}
