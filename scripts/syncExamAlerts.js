// scripts/syncExamAlerts.js
//
// Turns exams' important dates into exam alerts, so students see them on the
// Exam Alerts page (and get a notification) without an admin re-typing them.
//
// Usage (from testopy-backend-code/):
//   node scripts/syncExamAlerts.js --dry-run     # print what would change, no writes
//   node scripts/syncExamAlerts.js               # write to mongoDB_URL from .env
//   node scripts/syncExamAlerts.js --no-notify   # write, but send no notifications
// Run it after `importTestbookExams.js --details [--refresh-dates]`, or on a
// schedule. Running it twice in a row changes nothing.
//
// Which dates: every importantDates entry with exact days ({ from, to }) on an
// active, published exam — students can't open unpublished exams, so their
// alerts would lead nowhere. Text-only entries ("December 2026") get an alert
// once they have exact days.
//
// One alert per exam + date label (ExamAlert.testSeries / dateLabel):
//   - new and still upcoming (to >= today) -> created, and one notification
//     is broadcast for it (unless notify: false)
//   - already there, autoSync on           -> title, date, type, … follow the
//     exam; archived by the sync earlier -> brought back
//   - its date was removed, lost its exact days, or the exam was unpublished
//     -> archived (past alerts are kept: the page still lists them)
//   - an admin edited or archived it (autoSync off) -> never touched
// Updates send no notification.

import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import dotenv from "dotenv";
import mongoose from "mongoose";
import TestSeries from "../models/TestSeries.js";
import ExamAlert from "../models/ExamAlert.js";
import { formatAlertDate, notifyStudents } from "../utils/examAlertNotify.js";
import { todayUtcMidnight } from "../utils/dateOnly.js";

// Order matters: "Tier 1 Result" is a result, "Admit Card Release" an admit card.
const TYPE_RULES = [
  ["result", /result|merit list|cut ?off|score ?card|final selection/i],
  ["admit_card", /admit|hall ticket|call letter|intimation/i],
  ["registration", /regist|appl|apply|form|fee|correction|enrol/i],
  ["exam_date", /exam|tier|prelim|mains|\btest\b|cbt|interview|skill|phase|stage|paper/i],
];

export const alertTypeFor = (label) => TYPE_RULES.find(([, re]) => re.test(label))?.[0] ?? "other";

const ymd = (d) => d.toISOString().slice(0, 10);
const utcDay = (s) => new Date(`${s}T00:00:00.000Z`);

// The alert an exam date should have, or null if it has no exact days.
function alertFor(series, label, entry) {
  if (!entry?.from || !entry?.to) return null;
  const name = series.name.trim();
  const range =
    entry.from === entry.to
      ? formatAlertDate(utcDay(entry.from))
      : `${formatAlertDate(utcDay(entry.from))} – ${formatAlertDate(utcDay(entry.to))}`;
  return {
    title: label.toLowerCase().includes(name.toLowerCase()) ? label : `${name} ${label}`,
    description: entry.text ? `${range} (${entry.text})` : range,
    type: alertTypeFor(label),
    date: utcDay(entry.from),
    category: series.category ?? null,
    link: `/exams/${series._id}`,
    to: entry.to,
  };
}

const SYNCED = ["title", "description", "type", "date", "category", "link"];
const sameValue = (a, b) => String(a ?? "") === String(b ?? "") || (a instanceof Date && b instanceof Date && +a === +b);
const differs = (alert, want) => !alert.isActive || SYNCED.some((k) => !sameValue(alert[k], want[k]));

export async function syncExamAlerts({ today = todayUtcMidnight(), notify = true, dryRun = false } = {}) {
  const todayYmd = ymd(today);
  const stats = { created: 0, updated: 0, archived: 0, notified: 0, preview: [] };
  const note = (action, title, date) => stats.preview.push({ action, title, date: ymd(date) });

  const [series, existing] = await Promise.all([
    TestSeries.find({ isActive: true, isPublished: true }).select("name category importantDates").lean(),
    ExamAlert.find({ testSeries: { $ne: null } }).lean(),
  ]);
  const byKey = new Map(existing.map((a) => [`${a.testSeries}|${a.dateLabel}`, a]));
  const wanted = new Set();

  for (const s of series) {
    for (const [label, entry] of Object.entries(s.importantDates ?? {})) {
      const want = alertFor(s, label, entry);
      if (!want) continue;
      const key = `${s._id}|${label}`;
      wanted.add(key);
      const { to, ...fields } = want;
      const alert = byKey.get(key);

      if (!alert) {
        if (to < todayYmd) continue; // only upcoming dates become new alerts
        stats.created++;
        note("create", fields.title, fields.date);
        if (dryRun) continue;
        try {
          const created = await ExamAlert.create({ ...fields, testSeries: s._id, dateLabel: label, autoSync: true });
          if (notify && (await notifyStudents(created, null))) stats.notified++;
        } catch (err) {
          if (err.code !== 11000) throw err; // made by a parallel run: leave it
          stats.created--;
        }
      } else if (alert.autoSync && differs(alert, fields)) {
        stats.updated++;
        note("update", fields.title, fields.date);
        if (dryRun) continue;
        // autoSync in the filter: an admin edit made mid-run still wins.
        await ExamAlert.updateOne({ _id: alert._id, autoSync: true }, { $set: { ...fields, isActive: true } });
      }
    }
  }

  // Alerts whose exam date is gone (or exam unpublished) are archived.
  for (const alert of existing) {
    if (!alert.autoSync || !alert.isActive || wanted.has(`${alert.testSeries}|${alert.dateLabel}`)) continue;
    stats.archived++;
    note("archive", alert.title, alert.date);
    if (!dryRun) await ExamAlert.updateOne({ _id: alert._id, autoSync: true }, { $set: { isActive: false } });
  }
  return stats;
}

function parseArgs(argv) {
  const opts = { dryRun: false, notify: true };
  for (const a of argv) {
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--no-notify") opts.notify = false;
    else throw new Error(`Unknown option: ${a}`);
  }
  return opts;
}

async function main() {
  const { dryRun, notify } = parseArgs(process.argv.slice(2));
  const backendRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  dotenv.config({ path: path.join(backendRoot, ".env") });
  if (!process.env.mongoDB_URL) throw new Error("mongoDB_URL is not set (.env).");
  const { default: connectDB } = await import("../db.js");
  await connectDB();
  try {
    const s = await syncExamAlerts({ dryRun, notify });
    for (const p of s.preview) console.log(`  ${p.action.padEnd(7)} ${p.date}  ${p.title}`);
    console.log(
      `\nExam alerts${dryRun ? " (dry run — nothing written)" : ""}: ${s.created} created, ` +
        `${s.updated} updated, ${s.archived} archived; ${dryRun ? "no" : s.notified} notification(s) sent.`
    );
  } finally {
    await mongoose.disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Sync failed:", err.message);
    process.exit(1);
  });
}
