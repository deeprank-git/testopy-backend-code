// utils/examDetails.js
//
// TestSeries.examDetails: the exam page's Eligibility / Exam Pattern /
// Syllabus sections, written by admins as plain text (no HTML — the frontend
// renders it as paragraphs, with lines starting "- " as bullets).
//   { eligibility: "...", pattern: "...", syllabus: "..." }   "" = not added yet

export const EXAM_DETAIL_KEYS = ["eligibility", "pattern", "syllabus"];
export const EXAM_DETAIL_MAX = 20000; // characters per section

export const emptyExamDetails = () => ({ eligibility: "", pattern: "", syllabus: "" });

// Returns a cleaned copy with every key present (missing ones = ""), or throws
// an Error naming the offending section.
export function normalizeExamDetails(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("must be an object of { eligibility, pattern, syllabus }");
  }
  const extra = Object.keys(value).filter((k) => !EXAM_DETAIL_KEYS.includes(k));
  if (extra.length) throw new Error(`has unknown section(s): ${extra.join(", ")}`);

  const out = emptyExamDetails();
  for (const key of EXAM_DETAIL_KEYS) {
    const v = value[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "string") throw new Error(`"${key}" must be text`);
    // Normalise line endings and trailing spaces; keep the admin's line breaks.
    const text = v
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .map((line) => line.replace(/\s+$/, ""))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (text.length > EXAM_DETAIL_MAX) throw new Error(`"${key}" must be at most ${EXAM_DETAIL_MAX} characters`);
    out[key] = text;
  }
  return out;
}

// Multipart forms send examDetails as a JSON string; JSON bodies may send an object.
export function parseExamDetailsField(raw) {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("is not valid JSON");
    }
  }
  return normalizeExamDetails(value);
}
