// routes/analyticsAdminRoutes.js

import express from "express";
import authMiddleware from "../middleware/authMiddleware.js";
import authorize from "../middleware/authorize.js";
import { getAnalyticsOverview, getAttemptsTrend } from "../controllers/analyticsController.js";

const router = express.Router();

router.use(authMiddleware, authorize("admin"));

router.get("/overview", getAnalyticsOverview);
router.get("/attempts-trend", getAttemptsTrend);

export default router;
