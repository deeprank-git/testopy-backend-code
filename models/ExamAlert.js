// models/ExamAlert.js

import mongoose from "mongoose";

export const EXAM_ALERT_TYPES = ["exam_date", "registration", "admit_card", "result", "other"];

const examAlertSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, default: "", trim: true },
    type: { type: String, enum: EXAM_ALERT_TYPES, required: true },

    // The day the alert is about. Admins pick it with a date input, so it is
    // stored as UTC midnight; clients read the UTC calendar day.
    date: { type: Date, required: true },

    category: { type: mongoose.Schema.Types.ObjectId, ref: "Category", default: null },

    // "" | "https://…" | "/in-app/path" — see utils/isValidLink.js
    link: { type: String, default: "", trim: true },

    // Soft delete, same convention as other content.
    isActive: { type: Boolean, default: true },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

examAlertSchema.index({ isActive: 1, date: -1 });

export default mongoose.model("ExamAlert", examAlertSchema);
