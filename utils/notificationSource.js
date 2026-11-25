// utils/notificationSource.js
//
// Where a notification came from. Rows sent before the `source` field existed
// have none; those are treated as exam alerts when they link to the student
// Exam Alerts page (the only thing that used to create such links).

export const EXAM_ALERTS_PATH = "/dashboard/exam-alerts";
export const NOTIFICATION_SOURCES = ["manual", "exam_alert"];

export const resolveSource = (n) =>
  n.source || (n.link === EXAM_ALERTS_PATH ? "exam_alert" : "manual");

// Mongo clause matching resolveSource(n) === source.
export const sourceFilter = (source) =>
  source === "exam_alert"
    ? { $or: [{ source: "exam_alert" }, { source: { $exists: false }, link: EXAM_ALERTS_PATH }] }
    : { $or: [{ source: "manual" }, { source: { $exists: false }, link: { $ne: EXAM_ALERTS_PATH } }] };
