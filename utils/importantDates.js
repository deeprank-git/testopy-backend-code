// utils/importantDates.js
//
// TestSeries.importantDates is { "<label>": entry }, where each entry has
// exact dates, free text, or both:
//   { from: "2026-09-30", to: "2026-10-30" }                  exact range (one day: from === to)
//   { text: "December 2026" }                                 no exact day known yet
//   { from: "2026-07-26", to: "2026-07-26", text: "Extended" } dates + a short note
// from/to must come as a pair so dates stay sortable and comparable; text is
// what the student sees when there are no dates, or a note beside them.

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const IMPORTANT_DATE_TEXT_MAX = 120;
const ALLOWED_KEYS = new Set(["from", "to", "text"]);

const isRealDay = (s) => {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

// Returns a cleaned copy (text trimmed, empty text dropped) or throws an Error
// whose message names the offending label.
export function normalizeImportantDates(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("must be an object of { label: { from, to, text } }");
  }
  const out = {};
  for (const [rawLabel, entry] of Object.entries(value)) {
    const label = rawLabel.trim();
    const fail = (why) => {
      throw new Error(`"${label || rawLabel}" ${why}`);
    };
    if (!label) fail("needs a label");
    if (out[label]) fail("is listed twice");
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail("must be { from, to } and/or { text }");

    const extra = Object.keys(entry).filter((k) => !ALLOWED_KEYS.has(k));
    if (extra.length) fail(`has unknown field(s): ${extra.join(", ")}`);

    const hasFrom = entry.from !== undefined && entry.from !== "";
    const hasTo = entry.to !== undefined && entry.to !== "";
    if (hasFrom !== hasTo) fail("needs both from and to (use the same day twice for one day)");
    if (hasFrom) {
      if (!isRealDay(entry.from) || !isRealDay(entry.to)) fail('dates must be "YYYY-MM-DD"');
      if (entry.from > entry.to) fail("has from after to");
    }

    if (entry.text !== undefined && typeof entry.text !== "string") fail("text must be a string");
    const text = (entry.text ?? "").replace(/\s+/g, " ").trim();
    if (text.length > IMPORTANT_DATE_TEXT_MAX) fail(`text must be at most ${IMPORTANT_DATE_TEXT_MAX} characters`);
    if (!hasFrom && !text) fail("needs dates, text, or both");

    out[label] = {
      ...(hasFrom && { from: entry.from, to: entry.to }),
      ...(text && { text }),
    };
  }
  return out;
}

// Multipart forms send importantDates as a JSON string; JSON bodies may send an object.
export function parseImportantDatesField(raw) {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("is not valid JSON");
    }
  }
  return normalizeImportantDates(value);
}
