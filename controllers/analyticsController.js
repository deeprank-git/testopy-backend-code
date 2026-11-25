// controllers/analyticsController.js
//
// GET /api/admin/analytics/overview — a single dashboard-stats endpoint.
// Everything here is derived from data that already exists (Users,
// Category, Test, TestSeries, Question, TestAttempt, Report) — no new
// tracking/events system, just aggregation queries over what's there.

import User from "../models/Users.js";
import Category from "../models/Category.js";
import Test from "../models/Test.js";
import TestSeries from "../models/TestSeries.js";
import Question from "../models/Question.js";
import TestAttempt from "../models/TestAttempt.js";
import Report from "../models/Report.js";
import CurrentAffairs from "../models/CurrentAffairs.js";
import { todayUtcMidnight, addUtcDays } from "../utils/dateOnly.js";

export const getAnalyticsOverview = async (req, res) => {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [
      totalUsers,
      totalStudents,
      totalAdmins,
      totalInstructors,
      blockedUsers,
      newUsersLast7Days,
      totalCategories,
      totalTestSeries,
      totalTests,
      publishedTests,
      totalQuestions,
      totalAttempts,
      inProgressAttempts,
      completedAttempts,
      autoSubmittedAttempts,
      attemptsLast7Days,
      pendingReports,
      totalCurrentAffairs,
      scoreAgg,
    ] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ role: "student" }),
      User.countDocuments({ role: "admin" }),
      User.countDocuments({ role: "instructor" }),
      User.countDocuments({ isActive: false }),
      User.countDocuments({ createdAt: { $gte: sevenDaysAgo } }),
      Category.countDocuments({ isActive: true }),
      TestSeries.countDocuments({ isActive: true }),
      Test.countDocuments({ isActive: true }),
      Test.countDocuments({ isActive: true, isPublished: true }),
      Question.countDocuments({ isActive: true }),
      TestAttempt.countDocuments(),
      TestAttempt.countDocuments({ status: "in-progress" }),
      TestAttempt.countDocuments({ status: "completed" }),
      TestAttempt.countDocuments({ status: "auto-submitted" }),
      TestAttempt.countDocuments({ createdAt: { $gte: sevenDaysAgo } }),
      Report.countDocuments({ status: "pending" }),
      CurrentAffairs.countDocuments({ isActive: true }),
      TestAttempt.aggregate([
        { $match: { status: { $in: ["completed", "auto-submitted"] }, totalMarks: { $gt: 0 } } },
        {
          $group: {
            _id: null,
            avgPercentage: { $avg: { $multiply: [{ $divide: ["$score", "$totalMarks"] }, 100] } },
          },
        },
      ]),
    ]);

    res.status(200).json({
      success: true,
      data: {
        users: {
          total: totalUsers,
          students: totalStudents,
          admins: totalAdmins,
          instructors: totalInstructors,
          blocked: blockedUsers,
          newLast7Days: newUsersLast7Days,
        },
        content: {
          categories: totalCategories,
          testSeries: totalTestSeries,
          tests: totalTests,
          publishedTests,
          questions: totalQuestions,
          currentAffairs: totalCurrentAffairs,
        },
        attempts: {
          total: totalAttempts,
          inProgress: inProgressAttempts,
          completed: completedAttempts,
          autoSubmitted: autoSubmittedAttempts,
          last7Days: attemptsLast7Days,
          avgScorePercentage: scoreAgg[0] ? Number(scoreAgg[0].avgPercentage.toFixed(2)) : 0,
        },
        moderation: {
          pendingReports,
        },
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching analytics",
      error: error.message,
    });
  }
};

// GET /api/admin/analytics/attempts-trend?range=7d|30d|all
// Test attempts started per period, zero-filled, oldest first, each point split
// into completed / autoSubmitted / inProgress (+ total `count`) — powers the
// admin dashboard trend chart. Days/months are UTC (same convention as
// utils/dateOnly.js). "all" buckets by month, from the first attempt's month
// (at least the last MIN_MONTHS months) to the current month.
const DAY_RANGES = { "7d": 7, "30d": 30 };
const MIN_MONTHS = 6;

// Attempt status -> trend series. "paused" is unfinished, so it counts as in progress.
const STATUS_SERIES = {
  completed: "completed",
  "auto-submitted": "autoSubmitted",
  "in-progress": "inProgress",
  paused: "inProgress",
};

// bucket ("YYYY-MM-DD" or "YYYY-MM") -> { completed, autoSubmitted, inProgress }
const countByBucket = async (start, format) => {
  const rows = await TestAttempt.aggregate([
    { $match: { createdAt: { $gte: start } } },
    {
      $group: {
        _id: {
          bucket: { $dateToString: { format, date: "$createdAt", timezone: "UTC" } },
          status: "$status",
        },
        count: { $sum: 1 },
      },
    },
  ]);
  const buckets = new Map();
  for (const { _id, count } of rows) {
    const series = STATUS_SERIES[_id.status];
    if (!series) continue;
    const b = buckets.get(_id.bucket) ?? { completed: 0, autoSubmitted: 0, inProgress: 0 };
    b[series] += count;
    buckets.set(_id.bucket, b);
  }
  return buckets;
};

const toPoint = (date, buckets) => {
  const b = buckets.get(date) ?? { completed: 0, autoSubmitted: 0, inProgress: 0 };
  return { date, count: b.completed + b.autoSubmitted + b.inProgress, ...b };
};

export const getAttemptsTrend = async (req, res) => {
  try {
    const range = req.query.range ?? "30d";
    const today = todayUtcMidnight();
    let granularity;
    let points;

    if (DAY_RANGES[range]) {
      const days = DAY_RANGES[range];
      const start = addUtcDays(today, -(days - 1));
      const byDay = await countByBucket(start, "%Y-%m-%d");
      granularity = "day";
      points = Array.from({ length: days }, (_, i) => {
        return toPoint(addUtcDays(start, i).toISOString().slice(0, 10), byDay);
      });
    } else if (range === "all") {
      const first = await TestAttempt.findOne({}, { createdAt: 1 }).sort({ createdAt: 1 }).lean();
      const y = today.getUTCFullYear();
      const m = today.getUTCMonth();
      const floor = new Date(Date.UTC(y, m - (MIN_MONTHS - 1), 1));
      const firstMonth = first?.createdAt
        ? new Date(Date.UTC(first.createdAt.getUTCFullYear(), first.createdAt.getUTCMonth(), 1))
        : floor;
      const start = firstMonth < floor ? firstMonth : floor;
      const months =
        (y - start.getUTCFullYear()) * 12 + (m - start.getUTCMonth()) + 1;
      const byMonth = await countByBucket(start, "%Y-%m");
      granularity = "month";
      points = Array.from({ length: months }, (_, i) => {
        const date = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1))
          .toISOString()
          .slice(0, 7);
        return toPoint(date, byMonth);
      });
    } else {
      return res.status(400).json({
        success: false,
        message: 'range must be one of "7d", "30d" or "all"',
      });
    }

    res.status(200).json({
      success: true,
      data: {
        range,
        granularity,
        total: points.reduce((sum, p) => sum + p.count, 0),
        points,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching attempts trend",
      error: error.message,
    });
  }
};
