// controllers/testSeriesController.js

import fs from "fs";
import path from "path";
import TestSeries from "../models/TestSeries.js";
import { toUploadUrl } from "../middleware/upload.js";
// importantDates entries: exact { from, to }, free { text }, or both — see utils/importantDates.js.
import { parseImportantDatesField } from "../utils/importantDates.js";
import { parseExamDetailsField } from "../utils/examDetails.js";

// The body minus the JSON-string fields, which applyJsonFields parses separately.
function withoutJsonFields(body) {
  const rest = { ...body };
  delete rest.importantDates;
  delete rest.examDetails;
  return rest;
}

// Parses the JSON form fields shared by create and update into `payload`.
// Returns an error message for a 400, or null.
function applyJsonFields(body, payload) {
  const { importantDates, examDetails } = body;
  try {
    if (importantDates !== undefined) payload.importantDates = parseImportantDatesField(importantDates);
  } catch (e) {
    return `Invalid importantDates: ${e.message}`;
  }
  try {
    if (examDetails !== undefined) payload.examDetails = parseExamDetailsField(examDetails);
  } catch (e) {
    return `Invalid examDetails: ${e.message}`;
  }
  return null;
}

// ✅ GET all (filter by category optional)
// Students/instructors only see published + active series. Admin sees all.
export const getTestSeries = async (req, res) => {
  try {
    const filter = {};

    if (req.user?.role === "admin") {
      if (req.query.isActive !== undefined) filter.isActive = req.query.isActive === "true";
      if (req.query.isPublished !== undefined)
        filter.isPublished = req.query.isPublished === "true";
    } else {
      filter.isActive = true;
      filter.isPublished = true;
    }

    if (req.query.category) {
      filter.category = req.query.category;
    }

    const query = TestSeries.find(filter).populate("category", "name slug").sort({ createdAt: -1 });
    // examDetails can be long and only the exam page (GET /:id) shows it, so
    // student lists leave it out. Admins keep it: the edit drawer opens from
    // the list, and saving without it would wipe the sections.
    if (req.user?.role !== "admin") query.select("-examDetails");
    const series = await query.lean();

    res.status(200).json({
      success: true,
      count: series.length,
      data: series,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching test series",
      error: error.message,
    });
  }
};

// ✅ GET single
export const getTestSeriesById = async (req, res) => {
  try {
    const series = await TestSeries.findById(req.params.id).lean();

    if (!series || (!series.isActive && req.user?.role !== "admin")) {
      return res.status(404).json({
        success: false,
        message: "Test Series not found",
      });
    }

    if (req.user?.role !== "admin" && !series.isPublished) {
      return res.status(404).json({
        success: false,
        message: "Test Series not found",
      });
    }

    res.status(200).json({
      success: true,
      data: series,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching test series",
      error: error.message,
    });
  }
};

// ✅ CREATE
export const createTestSeries = async (req, res) => {
  try {
    const payload = { ...withoutJsonFields(req.body), createdBy: req.user.id };

    if (req.uploadEntityId) payload._id = req.uploadEntityId;

    const jsonError = applyJsonFields(req.body, payload);
    if (jsonError) return res.status(400).json({ success: false, message: jsonError });

    if (req.files?.image?.[0]) {
      payload.image = toUploadUrl(req.files.image[0]);
    }
    if (req.files?.notificationPdf?.[0]) {
      payload.notificationPdf = toUploadUrl(req.files.notificationPdf[0]);
    }

    const series = await TestSeries.create(payload);

    res.status(201).json({
      success: true,
      message: "Test Series created",
      data: series,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error creating test series",
      error: error.message,
    });
  }
};

// ✅ UPDATE
export const updateTestSeries = async (req, res) => {
  try {
    const payload = withoutJsonFields(req.body);

    // Same rules as create. Each JSON field, when sent, replaces the whole object.
    const jsonError = applyJsonFields(req.body, payload);
    if (jsonError) return res.status(400).json({ success: false, message: jsonError });

    if (req.files?.image?.[0] || req.files?.notificationPdf?.[0]) {
      const existing = await TestSeries.findById(req.params.id);
      if (!existing) {
        return res.status(404).json({
          success: false,
          message: "Test Series not found",
        });
      }
      if (req.files.image?.[0]) {
        payload.image = toUploadUrl(req.files.image[0]);
        if (existing.image) {
          fs.unlink(path.join(process.cwd(), existing.image), () => {});
        }
      }
      if (req.files.notificationPdf?.[0]) {
        payload.notificationPdf = toUploadUrl(req.files.notificationPdf[0]);
        if (existing.notificationPdf) {
          fs.unlink(path.join(process.cwd(), existing.notificationPdf), () => {});
        }
      }
    }

    const updated = await TestSeries.findByIdAndUpdate(req.params.id, payload, {
      new: true,
      runValidators: true,
    });

    if (!updated) {
      return res.status(404).json({
        success: false,
        message: "Test Series not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Test Series updated",
      data: updated,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error updating test series",
      error: error.message,
    });
  }
};

// ✅ DELETE (soft)
export const deleteTestSeries = async (req, res) => {
  try {
    const deleted = await TestSeries.findByIdAndUpdate(
      req.params.id,
      { isActive: false, isPublished: false },
      { new: true }
    );

    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: "Test Series not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Test Series deleted (soft)",
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error deleting test series",
      error: error.message,
    });
  }
};
