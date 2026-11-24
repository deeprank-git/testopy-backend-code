// controllers/notificationController.js

import mongoose from "mongoose";
import Notification from "../models/Notification.js";
import { isValidLink, LINK_RULE_MESSAGE } from "../utils/isValidLink.js";
import User from "../models/Users.js";
import {
  NOTIFICATION_SOURCES,
  resolveSource,
  sourceFilter,
} from "../utils/notificationSource.js";

const NOTIFICATION_TYPES = Notification.schema.path("type").enumValues;

const badRequest = (res, message) => res.status(400).json({ success: false, message });

// Broadcasts are "All students" notifications, so admins never receive or read them.
const receivesBroadcasts = (user) => user.role !== "admin";

// ✅ GET /api/notifications/me — targeted + broadcasts (students only), newest first.
// Optional: ?type= ?source=manual|exam_alert ?unread=1 ?before=<_id> ?limit=1..50 (default 20)
export const getMyNotifications = async (req, res) => {
  try {
    const uid = req.user._id;
    const { type, source, unread, before } = req.query;

    if (type !== undefined && !NOTIFICATION_TYPES.includes(type)) {
      return badRequest(res, `type must be one of: ${NOTIFICATION_TYPES.join(", ")}`);
    }
    if (source !== undefined && !NOTIFICATION_SOURCES.includes(source)) {
      return badRequest(res, `source must be one of: ${NOTIFICATION_SOURCES.join(", ")}`);
    }
    if (before !== undefined && !mongoose.isValidObjectId(before)) {
      return badRequest(res, "before must be a notification id");
    }
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));

    const broadcasts = receivesBroadcasts(req.user);
    const unreadClause = broadcasts
      ? { $or: [{ user: uid, isRead: false }, { user: null, readBy: { $ne: uid } }] }
      : { user: uid, isRead: false };
    const clauses = [broadcasts ? { $or: [{ user: uid }, { user: null }] } : { user: uid }];
    if (type) clauses.push({ type });
    if (source) clauses.push(sourceFilter(source));
    if (unread === "1" || unread === "true") clauses.push(unreadClause);
    if (before) clauses.push({ _id: { $lt: before } });

    // _id order matches createdAt order and has no ties, so it is a safe cursor.
    const rows = await Notification.find({ $and: clauses })
      .sort({ _id: -1 })
      .limit(limit + 1)
      .lean();
    const hasMore = rows.length > limit;

    // Broadcasts have no personal isRead flag (see model note): derive it from readBy.
    const data = rows.slice(0, limit).map(({ readBy, ...n }) => ({
      ...n,
      isRead: n.user === null ? (readBy ?? []).some((id) => String(id) === String(uid)) : n.isRead,
      source: resolveSource(n),
    }));

    // Badge count: everything unread, ignoring filters and paging.
    const unreadCount = await Notification.countDocuments(unreadClause);

    res.status(200).json({ success: true, count: data.length, unreadCount, hasMore, data });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching notifications",
      error: error.message,
    });
  }
};

// ✅ PATCH /api/notifications/:id/read
export const markAsRead = async (req, res) => {
  try {
    const notification = await Notification.findById(req.params.id);
    if (!notification) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }

    // must be either the targeted recipient or a broadcast the caller receives
    const isMine = notification.user && String(notification.user) === String(req.user.id);
    const isBroadcast = notification.user === null;
    if (!isMine && !(isBroadcast && receivesBroadcasts(req.user))) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    if (isBroadcast) {
      if (!notification.readBy.some((id) => String(id) === String(req.user.id))) {
        notification.readBy.push(req.user.id);
      }
    } else {
      notification.isRead = true;
    }

    await notification.save();

    res.status(200).json({ success: true, message: "Marked as read" });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error updating notification",
      error: error.message,
    });
  }
};

// ✅ POST /api/admin/notifications — targeted (userId set) or broadcast (omit userId)
export const createNotification = async (req, res) => {
  try {
    const { userId, title, message, type, link } = req.body;

    if (!title || !message) {
      return res.status(400).json({
        success: false,
        message: "title and message are required",
      });
    }

    if (!isValidLink(link)) {
      return res.status(400).json({ success: false, message: LINK_RULE_MESSAGE });
    }

    const notification = await Notification.create({
      user: userId || null,
      title,
      message,
      type,
      link: link || "",
      source: "manual",
      createdBy: req.user.id,
    });

    res.status(201).json({ success: true, message: "Notification sent", data: notification });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error creating notification",
      error: error.message,
    });
  }
};

// ✅ GET /api/admin/notifications — admin view of everything sent.
// audience: "all" (broadcast) | "student" (targeted; user is null if that account was deleted).
export const getAllNotificationsAdmin = async (req, res) => {
  try {
    // Not populated: populate turns a deleted user into null, which looks like a broadcast.
    const rows = await Notification.find()
      .sort({ createdAt: -1 })
      .limit(Number(req.query.limit) || 100)
      .lean();

    const ids = [...new Set(rows.filter((n) => n.user).map((n) => String(n.user)))];
    const users = await User.find({ _id: { $in: ids } }).select("name email").lean();
    const userById = new Map(users.map((u) => [String(u._id), u]));

    const data = rows.map(({ readBy, user, ...n }) =>
      user
        ? { ...n, audience: "student", user: userById.get(String(user)) ?? null, source: resolveSource(n) }
        : { ...n, audience: "all", user: null, readCount: readBy?.length ?? 0, source: resolveSource(n) },
    );

    res.status(200).json({ success: true, count: data.length, data });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error fetching notifications",
      error: error.message,
    });
  }
};

// ✅ DELETE /api/admin/notifications/:id — hard delete (nothing references notifications)
export const deleteNotification = async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = mongoose.isValidObjectId(id) ? await Notification.findByIdAndDelete(id) : null;

    if (!deleted) {
      return res.status(404).json({ success: false, message: "Notification not found" });
    }

    res.status(200).json({ success: true, message: "Notification deleted" });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error deleting notification",
      error: error.message,
    });
  }
};

// ✅ PATCH /api/notifications/read-all — mark everything the caller can see as read
export const markAllAsRead = async (req, res) => {
  try {
    const uid = req.user._id;
    await Promise.all([
      Notification.updateMany({ user: uid, isRead: false }, { $set: { isRead: true } }),
      receivesBroadcasts(req.user) &&
        Notification.updateMany({ user: null, readBy: { $ne: uid } }, { $addToSet: { readBy: uid } }),
    ]);
    res.status(200).json({ success: true, message: "All notifications marked as read" });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Error updating notifications",
      error: error.message,
    });
  }
};
