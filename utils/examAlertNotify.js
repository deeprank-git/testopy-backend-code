// utils/examAlertNotify.js
//
// The broadcast students get for an exam alert. Shared by the admin
// controller and scripts/syncExamAlerts.js.

import Notification from "../models/Notification.js";
import { EXAM_ALERTS_PATH } from "./notificationSource.js";

export const formatAlertDate = (date) =>
  new Date(date).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

// One broadcast per new (or, when asked, edited) alert. Failure is reported,
// never fatal: the alert is saved either way. adminId is null for the sync.
export const notifyStudents = async (alert, adminId, { updated = false } = {}) => {
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
