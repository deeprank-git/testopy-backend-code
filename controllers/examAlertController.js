// controllers/examAlertController.js

import mongoose from "mongoose";
import ExamAlert, { EXAM_ALERT_TYPES } from "../models/ExamAlert.js";
import Category from "../models/Category.js";
import Notification from "../models/Notification.js";
import { isValidLink, LINK_RULE_MESSAGE } from "../utils/isValidLink.js";
import { EXAM_ALERTS_PATH } from "../utils/notificationSource.js";

const CATEGORY_FIELDS = { path: "category", select: "name slug" };

const serverError = (res, message, error) =>
  res.status(500).json({ success: false, message, error: error.message });

// "YYYY-MM" → Mongo range for that calendar month in UTC, or null if malformed.
const monthRange = (month) => {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return null;
  return {
    $gte: new Date(Date.UTC(year, monthIndex, 1)),
    $lt: new Date(Date.UTC(year, monthIndex + 1, 1)),
  };
};

// ✅ GET /api/exam-alerts — public; active only. Optional ?type= ?category= ?month=YYYY-MM
export const getExamAlerts = async (req, res) => {
  try {
    const { type, category, month } = req.query;
    const filter = { isActive: true };

    if (type) filter.type = String(type);

    if (category) {
      if (!mongoose.isValidObjectId(category)) {
        return res.status(200).json({ success: true, count: 0, data: [] });
      }
      filter.category = category;
    }

    if (month) {
      const range = monthRange(String(month));
      if (!range) {
        return res.status(400).json({ success: false, message: "month must be YYYY-MM" });
      }
      filter.date = range;
    }

    const alerts = await ExamAlert.find(filter).populate(CATEGORY_FIELDS).sort({ date: -1 });
    res.status(200).json({ success: true, count: alerts.length, data: alerts });
  } catch (error) {
    serverError(res, "Error fetching exam alerts", error);
  }
};

const EDITABLE = ["title", "description", "type", "date", "link", "isActive"];

// Returns an error message, or null when valid. `partial` (PATCH) checks only fields present.
const validateAlert = async (body, { partial = false } = {}) => {
  const has = (key) => body[key] !== undefined;

  if (!partial || has("title")) {
    if (typeof body.title !== "string" || !body.title.trim()) return "title is required";
  }
  if (!partial || has("type")) {
    if (!EXAM_ALERT_TYPES.includes(body.type)) {
      return `type must be one of: ${EXAM_ALERT_TYPES.join(", ")}`;
    }
  }
  if (!partial || has("date")) {
    if (!body.date || Number.isNaN(new Date(body.date).getTime())) return "date must be a valid date";
  }
  if (has("link") && !isValidLink(body.link)) return LINK_RULE_MESSAGE;
  if (has("category") && body.category) {
    if (!mongoose.isValidObjectId(body.category)) return "category is not a valid id";
    if (!(await Category.exists({ _id: body.category }))) return "category not found";
  }
  return null;
};

// Text fields that "clear" to "" rather than null.
const CLEARABLE = ["description", "link"];

const pickEditable = (body) => {
  const out = {};
  for (const key of EDITABLE) {
    if (body[key] === undefined) continue;
    out[key] = body[key] === null && CLEARABLE.includes(key) ? "" : body[key];
  }
  if (body.category !== undefined) out.category = body.category || null;
  return out;
};

const notFound = (res) => res.status(404).json({ success: false, message: "Exam alert not found" });

// ✅ GET /api/admin/exam-alerts — everything, including archived
export const getAllExamAlertsAdmin = async (req, res) => {
  try {
    const alerts = await ExamAlert.find().populate(CATEGORY_FIELDS).sort({ date: -1 });
    res.status(200).json({ success: true, count: alerts.length, data: alerts });
  } catch (error) {
    serverError(res, "Error fetching exam alerts", error);
  }
};

const formatAlertDate = (date) =>
  new Date(date).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

// One broadcast per new (or, when asked, edited) alert. Failure is reported,
// never fatal: the alert is saved either way.
const notifyStudents = async (alert, adminId, { updated = false } = {}) => {
  try {
    await Notification.create({
      user: null,
      title: updated ? `Updated: ${alert.title}` : alert.title,
      message: alert.description?.trim() || formatAlertDate(alert.date),
      type: "info",
      link: EXAM_ALERTS_PATH,
      source: "exam_alert",
      createdBy: adminId,
    });
    return true;
  } catch (error) {
    console.error("Exam alert notification failed:", error.message);
    return false;
  }
};

// ✅ POST /api/admin/exam-alerts — body may include notify: boolean
export const createExamAlert = async (req, res) => {
  try {
    const error = await validateAlert(req.body);
    if (error) return res.status(400).json({ success: false, message: error });

    const alert = await ExamAlert.create({
      ...pickEditable(req.body),
      isActive: true,
      createdBy: req.user._id,
    });
    const notified = req.body.notify === true ? await notifyStudents(alert, req.user._id) : false;
    await alert.populate(CATEGORY_FIELDS);

    res.status(201).json({ success: true, message: "Exam alert created", data: alert, notified });
  } catch (error) {
    serverError(res, "Error creating exam alert", error);
  }
};

// ✅ PATCH /api/admin/exam-alerts/:id — edit any field; isActive: true restores.
// notify: true sends an "Updated: …" broadcast, but only for an active alert.
export const updateExamAlert = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return notFound(res);

    const error = await validateAlert(req.body, { partial: true });
    if (error) return res.status(400).json({ success: false, message: error });

    const alert = await ExamAlert.findByIdAndUpdate(req.params.id, pickEditable(req.body), {
      returnDocument: "after",
      runValidators: true,
    }).populate(CATEGORY_FIELDS);
    if (!alert) return notFound(res);

    const notified =
      req.body.notify === true && alert.isActive
        ? await notifyStudents(alert, req.user._id, { updated: true })
        : false;

    res.status(200).json({ success: true, message: "Exam alert updated", data: alert, notified });
  } catch (error) {
    serverError(res, "Error updating exam alert", error);
  }
};

// ✅ DELETE /api/admin/exam-alerts/:id — soft delete
export const deleteExamAlert = async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) return notFound(res);

    const alert = await ExamAlert.findByIdAndUpdate(
      req.params.id,
      { isActive: false },
      { returnDocument: "after" }
    );
    if (!alert) return notFound(res);

    res.status(200).json({ success: true, message: "Exam alert archived" });
  } catch (error) {
    serverError(res, "Error archiving exam alert", error);
  }
};
