// routes/examAlertRoutes.js (public)

import express from "express";
import { optionalAuth } from "../middleware/authMiddleware.js";
import { getExamAlerts } from "../controllers/examAlertController.js";

const router = express.Router();

router.use(optionalAuth);
router.get("/", getExamAlerts);

export default router;
