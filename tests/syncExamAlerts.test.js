import mongoose from "mongoose";
import request from "supertest";
import app from "../app.js";
import { connectTestDb, disconnectTestDb, clearTestDb } from "./testDb.js";
import User from "../models/Users.js";
import Category from "../models/Category.js";
import TestSeries from "../models/TestSeries.js";
import ExamAlert from "../models/ExamAlert.js";
import Notification from "../models/Notification.js";
import generateToken from "../utils/generateToken.js";
import { alertTypeFor, syncExamAlerts } from "../scripts/syncExamAlerts.js";

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

const today = new Date("2026-11-28T00:00:00.000Z");
const day = (d) => ({ from: d, to: d });
const alertsOf = async () => ExamAlert.find().sort({ date: 1 }).lean();

const makeExam = async (importantDates, extra = {}) => {
  const cat = await Category.create({ name: `SSC ${new mongoose.Types.ObjectId()}` });
  return TestSeries.create({ name: "SSC CGL", category: cat._id, isPublished: true, importantDates, ...extra });
};

describe("alertTypeFor", () => {
  it.each([
    ["Tier 1 Exam Date", "exam_date"],
    ["Interview", "exam_date"],
    ["Admit Card Release", "admit_card"],
    ["City Intimation Slip", "admit_card"],
    ["Last Date to Apply", "registration"],
    ["Fee Payment Last Date", "registration"],
    ["Tier 1 Result", "result"],
    ["Answer Key", "other"],
    ["Notification Release Date", "other"],
  ])("%s -> %s", (label, type) => expect(alertTypeFor(label)).toBe(type));
});

describe("syncExamAlerts", () => {
  it("creates an alert per upcoming exact date of published exams and notifies students", async () => {
    const exam = await makeExam({
      "Tier 1 Exam Date": { from: "2026-12-01", to: "2026-12-20" },
      "Fee Payment Last Date": { ...day("2026-12-05"), text: "Extended" },
      "Tier 2 Exam Date": { text: "February 2027" }, // no exact day: no alert
      "Notification Release Date": day("2026-05-21"), // past: no alert
    });
    await makeExam({ "Exam Date": day("2026-12-10") }, { name: "SSC CHSL", isPublished: false });
    await makeExam({ "Exam Date": day("2026-12-11") }, { name: "SSC MTS", isActive: false });

    const stats = await syncExamAlerts({ today });
    expect([stats.created, stats.updated, stats.archived, stats.notified]).toEqual([2, 0, 0, 2]);

    const alerts = await alertsOf();
    expect(alerts).toHaveLength(2);
    expect(alerts[0]).toMatchObject({
      title: "SSC CGL Tier 1 Exam Date",
      description: "01 Dec 2026 – 20 Dec 2026",
      type: "exam_date",
      category: exam.category,
      link: `/exams/${exam._id}`,
      testSeries: exam._id,
      dateLabel: "Tier 1 Exam Date",
      autoSync: true,
      isActive: true,
    });
    expect(alerts[0].date.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    expect(alerts[1]).toMatchObject({ title: "SSC CGL Fee Payment Last Date", description: "05 Dec 2026 (Extended)", type: "registration" });

    const notes = await Notification.find().sort({ title: 1 }).lean();
    expect(notes.map((n) => [n.title, n.source, n.user])).toEqual([
      ["SSC CGL Fee Payment Last Date", "exam_alert", null],
      ["SSC CGL Tier 1 Exam Date", "exam_alert", null],
    ]);

    // Running again changes nothing and sends nothing.
    const again = await syncExamAlerts({ today });
    expect([again.created, again.updated, again.archived, again.notified]).toEqual([0, 0, 0, 0]);
    expect(await Notification.countDocuments()).toBe(2);
  });

  it("doesn't repeat the exam name when the label already has it", async () => {
    await makeExam({ "SSC CGL Admit Card": day("2026-12-01") });
    await syncExamAlerts({ today });
    expect((await alertsOf())[0].title).toBe("SSC CGL Admit Card");
  });

  it("follows the exam's dates, archives alerts whose date is gone, and revives them", async () => {
    const exam = await makeExam({ "Exam Date": day("2026-12-01"), "Result": day("2026-12-30") });
    await syncExamAlerts({ today });

    await TestSeries.updateOne(
      { _id: exam._id },
      { $set: { importantDates: { "Exam Date": day("2026-12-03"), Result: { text: "TBA" } } } }
    );
    const stats = await syncExamAlerts({ today });
    expect([stats.created, stats.updated, stats.archived, stats.notified]).toEqual([0, 1, 1, 0]);
    const [examAlert, resultAlert] = await alertsOf();
    expect([examAlert.date.toISOString().slice(0, 10), examAlert.isActive]).toEqual(["2026-12-03", true]);
    expect([resultAlert.dateLabel, resultAlert.isActive]).toEqual(["Result", false]);

    // Unpublishing archives the rest; publishing again brings them back.
    await TestSeries.updateOne({ _id: exam._id }, { $set: { isPublished: false } });
    expect((await syncExamAlerts({ today })).archived).toBe(1);
    await TestSeries.updateOne(
      { _id: exam._id },
      { $set: { isPublished: true, "importantDates.Result": day("2026-12-30") } }
    );
    const back = await syncExamAlerts({ today });
    expect([back.created, back.updated, back.notified]).toEqual([0, 2, 0]);
    expect((await alertsOf()).every((a) => a.isActive)).toBe(true);
  });

  it("keeps an exam's past alerts, so the alerts page still lists them", async () => {
    await makeExam({ "Exam Date": day("2026-12-01") });
    await syncExamAlerts({ today });
    const later = await syncExamAlerts({ today: new Date("2027-01-15T00:00:00.000Z") });
    expect([later.archived, later.updated]).toEqual([0, 0]);
    expect((await alertsOf())[0].isActive).toBe(true);
  });

  it("leaves alerts an admin edited or archived", async () => {
    const admin = await User.create({ email: "admin@example.com", password: "Passw0rd!", role: "admin" });
    const auth = `Bearer ${generateToken(admin._id.toString(), admin.role)}`;
    const exam = await makeExam({ "Exam Date": day("2026-12-01"), "Admit Card": day("2026-11-29") });
    await syncExamAlerts({ today });
    const [admit, examAlert] = await alertsOf();

    const edited = await request(app)
      .patch(`/api/admin/exam-alerts/${examAlert._id}`)
      .set("Authorization", auth)
      .send({ title: "CGL exam (admin wording)" });
    expect(edited.status).toBe(200);
    const archived = await request(app).delete(`/api/admin/exam-alerts/${admit._id}`).set("Authorization", auth);
    expect(archived.status).toBe(200);

    await TestSeries.updateOne(
      { _id: exam._id },
      { $set: { importantDates: { "Exam Date": day("2026-12-09"), "Admit Card": day("2026-11-30") } } }
    );
    const stats = await syncExamAlerts({ today });
    expect([stats.created, stats.updated, stats.archived]).toEqual([0, 0, 0]);

    const [a, e] = await alertsOf();
    expect([a.isActive, a.autoSync]).toEqual([false, false]);
    expect([e.title, e.date.toISOString().slice(0, 10), e.autoSync]).toEqual(["CGL exam (admin wording)", "2026-12-01", false]);
  });

  it("notify: false creates alerts without notifications", async () => {
    await makeExam({ "Exam Date": day("2026-12-01") });
    const stats = await syncExamAlerts({ today, notify: false });
    expect([stats.created, stats.notified]).toEqual([1, 0]);
    expect(await Notification.countDocuments()).toBe(0);
  });

  it("dry run reports what it would do and writes nothing", async () => {
    await makeExam({ "Exam Date": day("2026-12-01") });
    const stats = await syncExamAlerts({ today, dryRun: true });
    expect(stats.created).toBe(1);
    expect(stats.preview).toEqual([{ action: "create", title: "SSC CGL Exam Date", date: "2026-12-01" }]);
    expect(await ExamAlert.countDocuments()).toBe(0);
    expect(await Notification.countDocuments()).toBe(0);
  });
});
