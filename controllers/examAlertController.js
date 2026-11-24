// controllers/examAlertController.js

import mongoose from "mongoose";
import ExamAlert from "../models/ExamAlert.js";

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
