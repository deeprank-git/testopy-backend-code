// routes/examAlertRoutes.js (public)

import express from "express";
import { optionalAuth } from "../middleware/authMiddleware.js";
import { getExamAlerts, getExamAlertSummary } from "../controllers/examAlertController.js";

const router = express.Router();

router.use(optionalAuth);
router.get("/", getExamAlerts);
router.get("/summary", getExamAlertSummary);

export default router;
