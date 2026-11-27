// scripts/testbookExamDetails.js
//
// `--details` step of importTestbookExams.js: reads each exam's Testbook page
// (e.g. https://testbook.com/ssc-cgl-exam) and fills two TestSeries fields,
// ONLY when they're still empty (admin data is never overwritten):
//   officialWebsite — the external link in the page's overview table
//   importantDates  — { label: { from?, to?, text? } } from the page's date tables
//
// Testbook writes dates as free text ("22nd June 2026 25th June 2026",
// "21st September", "December 2026", "TBA"). Each row is stored in the shape
// utils/importantDates.js accepts:
//   exact day(s)      -> { from, to }, plus { text } for a bracketed note
//                        such as "(Extended)"
//   anything else that still names a month or "TBA"-style status
//                     -> { text } as written ("December 2026")
// Text that mentions Testbook, links, sites or apps is never stored. Rows
// that fit neither shape are returned as `skipped` for admins.
// Eligibility, pattern, syllabus and other prose are deliberately not copied.

import TestSeries from "../models/TestSeries.js";
import { isValidLink } from "../utils/isValidLink.js";
import { IMPORTANT_DATE_TEXT_MAX } from "../utils/importantDates.js";

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const ORD = "(?:st|nd|rd|th)?";
// "29 & 30 July 2026" / "1st-3rd July 2026" / "21st May 2026" / "21 May" / "May 21, 2026"
const DAY_RANGE = new RegExp(`\\b(\\d{1,2})${ORD}\\s*(?:&|and|-|–|to)\\s*(\\d{1,2})${ORD}\\s+(${MONTH_RE})\\.?,?\\s*(\\d{4})?\\b`, "gi");
const DAY_MONTH = new RegExp(`\\b(\\d{1,2})${ORD}\\s+(${MONTH_RE})\\.?,?\\s*(\\d{4})?\\b`, "gi");
const MONTH_DAY = new RegExp(`\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})${ORD},?\\s*(\\d{4})?\\b`, "gi");
const CONNECTOR = /^\s*(?:-|–|—|to|till|until)\s*$/i;

const DATE_TABLE_HEADING = /\bdates?\b|schedule|calendar|timeline|important events/i;
const DATE_LABEL = /date|start|end|last|release|window|exam|admit|result|answer key|notification|appl|registration|interview|correction|deadline|slip|reopen/i;
const WEBSITE_LABEL = /official|website|conduct|organi[sz]ation|exam body|authority|board|commission/i;
const SKIP_HOSTS = /(^|\.)(testbook\.com|google\.com|youtube\.com|youtu\.be|facebook\.com|twitter\.com|x\.com|instagram\.com|t\.me|telegram\.me|whatsapp\.com|linkedin\.com|wikipedia\.org)$/i;

const decode = (s) =>
  s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&ndash;/g, "–")
    .replace(/&mdash;/g, "—")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
const strip = (html) => decode(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const pad = (n) => String(n).padStart(2, "0");

const toIso = (y, m, d) => {
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
};

// Every full or partial date mention in `text`, in order, as
// { start, end, from: {y,m,d}, to: {y,m,d} } (y may be null = no year written).
function findDateTokens(text) {
  const tokens = [];
  const taken = [];
  const overlaps = (s, e) => taken.some(([a, b]) => s < b && e > a);
  const add = (m, from, to) => {
    const start = m.index;
    const end = m.index + m[0].length;
    if (overlaps(start, end)) return;
    taken.push([start, end]);
    tokens.push({ start, end, from, to });
  };
  for (const m of text.matchAll(DAY_RANGE)) {
    const mo = MONTHS[m[3].toLowerCase()];
    const y = m[4] ? Number(m[4]) : null;
    add(m, { y, m: mo, d: Number(m[1]) }, { y, m: mo, d: Number(m[2]) });
  }
  for (const m of text.matchAll(DAY_MONTH)) {
    const p = { y: m[3] ? Number(m[3]) : null, m: MONTHS[m[2].toLowerCase()], d: Number(m[1]) };
    add(m, p, p);
  }
  for (const m of text.matchAll(MONTH_DAY)) {
    const p = { y: m[3] ? Number(m[3]) : null, m: MONTHS[m[1].toLowerCase()], d: Number(m[2]) };
    add(m, p, p);
  }
  return tokens.sort((a, b) => a.start - b.start);
}

// Free text -> { from, to } ("YYYY-MM-DD") or null when it isn't an exact day.
// Mentions joined by "to"/"-" form a range; mentions placed side by side are
// revisions (Testbook keeps the struck-out old date), so the LAST one wins.
export function parseDateRange(raw) {
  const text = raw.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const tokens = findDateTokens(text);
  if (tokens.length === 0) return null;

  const ranges = [];
  for (const t of tokens) {
    const prev = ranges.at(-1);
    if (prev && !prev.joined && CONNECTOR.test(text.slice(prev.end, t.start))) {
      prev.to = t.to;
      prev.end = t.end;
      prev.joined = true;
    } else {
      ranges.push({ ...t });
    }
  }
  const { from, to } = ranges.at(-1);

  // "23rd June to 25th June 2026": the year written once applies to both ends.
  const year = to.y ?? from.y;
  if (!year) return null;
  const fromIso = toIso(from.y ?? year, from.m, from.d);
  const toIsoStr = toIso(to.y ?? year, to.m, to.d);
  if (!fromIso || !toIsoStr || fromIso > toIsoStr) return null;
  return { from: fromIso, to: toIsoStr };
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// "SSC CGL 2026 Tier 1 Exam Date" -> "Tier 1 Exam Date",
// "Last Date to Apply for SSC CHSL" -> "Last Date to Apply". Mongo-safe key.
function cleanLabel(label, examName) {
  let s = label.replace(new RegExp(`(?:\\s+(?:of|for|in))?\\s*\\b${escapeRe(examName)}\\b`, "gi"), " ");
  s = s.replace(/\b(19|20)\d{2}\b/g, "").replace(/[.$]/g, "").replace(/\s+/g, " ").replace(/^[\s:–-]+|[\s:–-]+$/g, "");
  return (s || label.replace(/[.$]/g, "")).slice(0, 80).trim();
}

function* tablesWithHeadings(html) {
  const re = /<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>|<table[\s\S]*?<\/table>/gi;
  let heading = "";
  for (const m of html.matchAll(re)) {
    if (m[1] !== undefined) heading = strip(m[1]);
    else yield { heading, html: m[0] };
  }
}

const rowsOf = (tableHtml) =>
  [...tableHtml.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((r) => ({
    cells: [...r[0].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) => strip(c[1])),
    html: r[0],
  }));

function externalLinks(html) {
  const links = [];
  for (const m of html.matchAll(/href="(https?:\/\/[^"\s]+)"/gi)) {
    try {
      const url = new URL(decode(m[1]));
      if (!SKIP_HOSTS.test(url.hostname) && isValidLink(url.href)) links.push(url.href);
    } catch {
      /* not a URL */
    }
  }
  return links;
}

const MAX_DATES = 15;

// Never store text that points somewhere else — the source site, links, apps.
const BLOCKED_TEXT = /testbook|https?:|www\.|\b[\w-]+\.(?:com|in|org|net|gov|co)\b|click|check (?:here|now|out)|download|\blinks?\b|\bapps?\b|telegram|whatsapp|youtube|subscribe|enroll|mock test|test series|coaching/i;
const STATUS_TEXT = /\btba\b|\btbd\b|to be (?:announced|notified|released|declared|updated|decided)|notified soon|announced soon|awaited|expected|tentative|onwards/i;
// A month only counts next to a day or year ("October 2026", "10th September"),
// so prose like "multiple entries may lead to…" isn't mistaken for a date.
const MONTH_WORD = new RegExp(`\\b\\d{1,2}${ORD}\\s+(?:${MONTH_RE})\\b|\\b(?:${MONTH_RE})\\.?,?\\s+\\d{1,4}\\b`, "i");

const cleanText = (s) => {
  const t = s.replace(/\s+/g, " ").replace(/^[\s,;:–-]+|[\s,;:–-]+$/g, "").trim();
  if (!t || BLOCKED_TEXT.test(t)) return "";
  return t.length <= IMPORTANT_DATE_TEXT_MAX ? t : t.slice(0, IMPORTANT_DATE_TEXT_MAX - 1).replace(/\s+\S*$/, "") + "…";
};
const capitalise = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// Note to keep beside exact dates: bracketed remarks and "onwards".
// "26th July 2026(Extended)" -> "Extended"; "1st Nov 2026 onwards" -> "Onwards".
function noteFor(value) {
  const parts = [...value.matchAll(/\(([^)]*)\)/g)].map((m) => cleanText(m[1])).filter(Boolean);
  if (/\bonwards\b/i.test(value.replace(/\([^)]*\)/g, ""))) parts.unshift("onwards");
  return cleanText([...new Set(parts.map(capitalise))].join("; "));
}

// Free-text value worth showing when there's no exact day: it must still say
// something about timing (a month, or TBA-style status).
function dateTextFor(value) {
  const text = cleanText(value);
  return text && (MONTH_WORD.test(text) || STATUS_TEXT.test(text)) ? text : "";
}

const hasTimingInfo = (entry) => !!entry.from || MONTH_WORD.test(entry.text ?? "");

// Pure: one exam page's HTML -> what we'd fill, plus the date rows we couldn't use.
export function parseExamPage(html, examName) {
  let officialWebsite = "";
  const importantDates = {};
  const skipped = [];
  const seenValues = new Set();

  // Tables headed as date tables ("… Exam Date 2026", "Important Dates") come
  // first and count every row. Every other table (overview, "Recruitment
  // 2026", …) only counts rows with date-like labels, and repeats of a date
  // already taken are dropped — overviews restate the same events.
  const tables = [...tablesWithHeadings(html)]
    .map((t) => ({ ...t, isDateTable: DATE_TABLE_HEADING.test(t.heading), isOverview: /overview/i.test(t.heading) }))
    .sort((a, b) => b.isDateTable - a.isDateTable);

  for (const { html: tableHtml, isDateTable, isOverview } of tables) {
    for (const row of rowsOf(tableHtml)) {
      if (row.cells.length !== 2) continue;
      const [label, value] = row.cells;
      if (!label || !value || /^(particulars|events?|details|dates?)\b/i.test(label)) continue;
      if (BLOCKED_TEXT.test(label)) continue;

      if (!officialWebsite && (isOverview || WEBSITE_LABEL.test(label))) {
        officialWebsite = externalLinks(row.html)[0] ?? "";
      }

      if (!isDateTable && !DATE_LABEL.test(label)) continue;
      const range = parseDateRange(value);
      let entry;
      if (range) {
        const note = noteFor(value);
        entry = note ? { ...range, text: note } : range;
      } else {
        const text = dateTextFor(value);
        if (!text) {
          if (findDateTokens(value).length || /\b(19|20)\d{2}\b/.test(value)) skipped.push({ label, value });
          continue;
        }
        entry = { text };
      }

      const key = cleanLabel(label, examName);
      const valueKey = entry.from ? `${entry.from}|${entry.to}` : entry.text.toLowerCase();
      // Overview tables repeat the dedicated date table under other labels.
      if (!key || importantDates[key] || (!isDateTable && seenValues.has(valueKey))) continue;
      if (Object.keys(importantDates).length >= MAX_DATES) break;
      importantDates[key] = entry;
      seenValues.add(valueKey);
    }
  }
  return { officialWebsite, importantDates, skipped };
}

const isEmptyDates = (v) => !v || (typeof v === "object" && Object.keys(v).length === 0);

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

// Fills officialWebsite / importantDates for the plan's exams where they're
// empty in the DB. `fetchPage(pageSlug)` returns the page HTML.
// dryRun: no DB at all — parses every exam in the plan and reports.
export async function fillExamDetails(
  plan,
  { fetchPage, dryRun = false, limit = Infinity, concurrency = 2, onProgress = () => {} } = {}
) {
  const exams = plan.flatMap((c) => c.exams).filter((e) => e.pageSlug);
  const stats = { checked: 0, websiteFilled: 0, datesFilled: 0, noData: 0, failed: [], skipped: [], preview: [] };

  let todo;
  if (dryRun) {
    todo = exams.map((exam) => ({ exam, needWebsite: true, needDates: true }));
  } else {
    const docs = await TestSeries.find({
      $or: [{ testbookId: { $in: exams.map((e) => e.testbookId) } }, { slug: { $in: exams.map((e) => e.slug) } }],
    })
      .select("slug testbookId officialWebsite importantDates")
      .lean();
    const byTb = new Map(docs.filter((d) => d.testbookId).map((d) => [d.testbookId, d]));
    const bySlug = new Map(docs.map((d) => [d.slug, d]));
    todo = exams
      .map((exam) => {
        const doc = byTb.get(exam.testbookId) ?? bySlug.get(exam.slug);
        return doc && { exam, doc, needWebsite: !doc.officialWebsite, needDates: isEmptyDates(doc.importantDates) };
      })
      .filter((t) => t && (t.needWebsite || t.needDates));
  }
  todo = todo.slice(0, limit);

  await mapLimit(todo, concurrency, async ({ exam, doc, needWebsite, needDates }, idx) => {
    let parsed;
    try {
      parsed = parseExamPage(await fetchPage(exam.pageSlug), exam.name);
    } catch (err) {
      stats.failed.push({ exam: exam.name, error: err.message });
      return;
    } finally {
      onProgress(idx + 1, todo.length);
    }
    stats.checked++;
    if (parsed.skipped.length) stats.skipped.push({ exam: exam.name, rows: parsed.skipped });

    const website = needWebsite && parsed.officialWebsite;
    // A set that's only "TBA" isn't saved: it would mark the field as filled
    // and stop a later run from adding the real dates once they're announced.
    const dates = needDates && Object.values(parsed.importantDates).some(hasTimingInfo) && parsed.importantDates;
    if (!website && !dates) {
      stats.noData++;
      return;
    }

    if (dryRun) {
      stats.preview.push({ exam: exam.name, officialWebsite: website || undefined, importantDates: dates || undefined });
      if (website) stats.websiteFilled++;
      if (dates) stats.datesFilled++;
      return;
    }

    // Filters re-check emptiness, so an admin edit made mid-run still wins.
    if (website) {
      const r = await TestSeries.updateOne(
        { _id: doc._id, $or: [{ officialWebsite: "" }, { officialWebsite: { $exists: false } }] },
        { $set: { officialWebsite: website } }
      );
      if (r.modifiedCount) stats.websiteFilled++;
    }
    if (dates) {
      const r = await TestSeries.updateOne(
        { _id: doc._id, $or: [{ importantDates: {} }, { importantDates: { $exists: false } }, { importantDates: null }] },
        { $set: { importantDates: dates } }
      );
      if (r.modifiedCount) stats.datesFilled++;
    }
  });

  return { ...stats, total: todo.length };
}
