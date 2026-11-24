// routes/notificationRoutes.js (any logged-in user)

import express from "express";
import authMiddleware from "../middleware/authMiddleware.js";
import { getMyNotifications, markAsRead, markAllAsRead } from "../controllers/notificationController.js";

const router = express.Router();

router.use(authMiddleware);

router.get("/me", getMyNotifications);
router.patch("/read-all", markAllAsRead);
router.patch("/:id/read", markAsRead);

export default router;
