// routes/examAlertAdminRoutes.js

import express from "express";
import authMiddleware from "../middleware/authMiddleware.js";
import authorize from "../middleware/authorize.js";
import {
  getAllExamAlertsAdmin,
  createExamAlert,
  updateExamAlert,
  deleteExamAlert,
} from "../controllers/examAlertController.js";

const router = express.Router();

router.use(authMiddleware, authorize("admin"));

router.get("/", getAllExamAlertsAdmin);
router.post("/", createExamAlert);
router.patch("/:id", updateExamAlert);
router.delete("/:id", deleteExamAlert);

export default router;
