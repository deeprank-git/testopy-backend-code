// controllers/examAlertController.js

import mongoose from "mongoose";
import ExamAlert, { EXAM_ALERT_TYPES } from "../models/ExamAlert.js";
import Category from "../models/Category.js";
import { isValidLink, LINK_RULE_MESSAGE } from "../utils/isValidLink.js";
import { notifyStudents } from "../utils/examAlertNotify.js";
import { todayUtcMidnight } from "../utils/dateOnly.js";

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

// "YYYY-MM-DD" (the viewer's local day) → that day's UTC midnight, the way alert
// dates are stored. Missing → server's UTC today. Malformed → null.
const parseToday = (value) => {
  if (value === undefined) return todayUtcMidnight();
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};

const badRequest = (res, message) => res.status(400).json({ success: false, message });

// ✅ GET /api/exam-alerts — public; active only, latest date first.
// Optional: ?type= ?category= ?month=YYYY-MM ?monthOfYear=MM (any year)
//   ?status=upcoming|past (against ?today=YYYY-MM-DD, the viewer's day)
//   ?page=1.. ?limit=1..50 (default 10) — without page, every match is returned.
export const getExamAlerts = async (req, res) => {
  try {
    const { type, category, month, monthOfYear, status } = req.query;
    const clauses = [{ isActive: true }];

    if (type) clauses.push({ type: String(type) });

    if (category) {
      if (!mongoose.isValidObjectId(category)) {
        return res.status(200).json({ success: true, count: 0, total: 0, page: 1, totalPages: 1, data: [] });
      }
      clauses.push({ category });
    }

    if (month) {
      const range = monthRange(String(month));
      if (!range) return badRequest(res, "month must be YYYY-MM");
      clauses.push({ date: range });
    }

    if (monthOfYear !== undefined) {
      if (!/^(0[1-9]|1[0-2])$/.test(String(monthOfYear))) {
        return badRequest(res, "monthOfYear must be 01..12");
      }
      // Dates are UTC midnight, and $month reads UTC.
      clauses.push({ $expr: { $eq: [{ $month: "$date" }, Number(monthOfYear)] } });
    }

    if (status !== undefined) {
      if (status !== "upcoming" && status !== "past") {
        return badRequest(res, "status must be upcoming or past");
      }
      const today = parseToday(req.query.today);
      if (!today) return badRequest(res, "today must be YYYY-MM-DD");
      clauses.push({ date: status === "upcoming" ? { $gte: today } : { $lt: today } });
    }

    const filter = { $and: clauses };
    const query = ExamAlert.find(filter).populate(CATEGORY_FIELDS).sort({ date: -1, _id: -1 });

    if (req.query.page === undefined) {
      const alerts = await query;
      return res.status(200).json({ success: true, count: alerts.length, data: alerts });
    }

    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 10));
    const page = Math.max(1, Math.floor(Number(req.query.page)) || 1);
    const [alerts, total] = await Promise.all([
      query.skip((page - 1) * limit).limit(limit),
      ExamAlert.countDocuments(filter),
    ]);
    res.status(200).json({
      success: true,
      count: alerts.length,
      total,
      page,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      data: alerts,
    });
  } catch (error) {
    serverError(res, "Error fetching exam alerts", error);
  }
};

// ✅ GET /api/exam-alerts/summary — public. ?today=YYYY-MM-DD (viewer's day).
// Page header counts, plus every category an active alert uses (archived ones
// included) so the category filter can offer them.
export const getExamAlertSummary = async (req, res) => {
  try {
    const today = parseToday(req.query.today);
    if (!today) return badRequest(res, "today must be YYYY-MM-DD");

    const active = { isActive: true };
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [total, upcomingExams, newThisWeek, categoryIds] = await Promise.all([
      ExamAlert.countDocuments(active),
      ExamAlert.countDocuments({ ...active, type: "exam_date", date: { $gte: today } }),
      ExamAlert.countDocuments({ ...active, createdAt: { $gte: weekAgo } }),
      ExamAlert.distinct("category", { ...active, category: { $ne: null } }),
    ]);
    const categories = await Category.find({ _id: { $in: categoryIds } })
      .select("name slug")
      .sort({ name: 1 })
      .lean();

    res.status(200).json({
      success: true,
      data: { total, upcomingExams, newThisWeek, categories },
    });
  } catch (error) {
    serverError(res, "Error fetching exam alert summary", error);
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

    // An admin edit makes the alert theirs: syncExamAlerts stops updating it.
    const changes = { ...pickEditable(req.body), autoSync: false };
    const alert = await ExamAlert.findByIdAndUpdate(req.params.id, changes, {
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
      { isActive: false, autoSync: false }, // stays archived: the sync won't revive it
      { returnDocument: "after" }
    );
    if (!alert) return notFound(res);

    res.status(200).json({ success: true, message: "Exam alert archived" });
  } catch (error) {
    serverError(res, "Error archiving exam alert", error);
  }
};
