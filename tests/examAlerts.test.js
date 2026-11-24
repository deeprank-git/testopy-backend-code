import mongoose from "mongoose";
import request from "supertest";
import { jest } from "@jest/globals";
import app from "../app.js";
import { connectTestDb, disconnectTestDb, clearTestDb } from "./testDb.js";
import User from "../models/Users.js";
import Category from "../models/Category.js";
import ExamAlert from "../models/ExamAlert.js";
import Notification from "../models/Notification.js";
import generateToken from "../utils/generateToken.js";

const createUser = (role) =>
  User.create({
    email: `${role}-${new mongoose.Types.ObjectId()}@example.com`,
    password: "Passw0rd!",
    role,
  });
const bearer = (user) => `Bearer ${generateToken(user._id.toString(), user.role)}`;
const day = (ymd) => new Date(`${ymd}T00:00:00.000Z`);

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

describe("GET /api/exam-alerts (public)", () => {
  it("returns only active alerts, latest date first, with category name and slug", async () => {
    const ssc = await Category.create({ name: "SSC" });
    await ExamAlert.create([
      { title: "Old", type: "result", date: day("2026-10-01") },
      { title: "New", type: "exam_date", date: day("2026-12-05"), category: ssc._id },
      { title: "Hidden", type: "other", date: day("2026-12-10"), isActive: false },
    ]);

    const res = await request(app).get("/api/exam-alerts"); // no token

    expect(res.status).toBe(200);
    expect(res.body.data.map((a) => a.title)).toEqual(["New", "Old"]);
    expect(res.body.data[0].category).toMatchObject({ name: "SSC", slug: expect.any(String) });
    expect(res.body.data[1].category).toBeNull();
  });

  it("filters by type, category and month", async () => {
    const ssc = await Category.create({ name: "SSC" });
    const bank = await Category.create({ name: "Banking" });
    await ExamAlert.create([
      { title: "A", type: "exam_date", date: day("2026-12-05"), category: ssc._id },
      { title: "B", type: "registration", date: day("2026-12-20"), category: bank._id },
      { title: "C", type: "exam_date", date: day("2027-01-10"), category: bank._id },
    ]);
    const titles = async (qs) =>
      (await request(app).get(`/api/exam-alerts?${qs}`)).body.data.map((a) => a.title);

    expect(await titles("type=exam_date")).toEqual(["C", "A"]);
    expect(await titles(`category=${bank._id}`)).toEqual(["C", "B"]);
    expect(await titles("month=2026-12")).toEqual(["B", "A"]);
    expect(await titles("type=exam_date&month=2026-12")).toEqual(["A"]);
    expect(await titles("category=not-an-id")).toEqual([]);
  });

  it.each(["2026-13", "dec", "2026-1"])("400s on malformed month %p", async (month) => {
    const res = await request(app).get(`/api/exam-alerts?month=${month}`);
    expect(res.status).toBe(400);
  });
});

describe("GET /api/exam-alerts month-of-year, status and paging", () => {
  const titles = async (qs) =>
    (await request(app).get(`/api/exam-alerts?${qs}`)).body.data.map((a) => a.title);

  it("filters by month of any year", async () => {
    await ExamAlert.create([
      { title: "Dec26", type: "exam_date", date: day("2026-12-05") },
      { title: "Dec27", type: "exam_date", date: day("2027-12-31") },
      { title: "Jan27", type: "exam_date", date: day("2027-01-01") },
    ]);
    expect(await titles("monthOfYear=12")).toEqual(["Dec27", "Dec26"]);
  });

  it("splits upcoming (today and later) from past against the viewer's today", async () => {
    await ExamAlert.create([
      { title: "Yesterday", type: "result", date: day("2026-11-23") },
      { title: "Today", type: "result", date: day("2026-11-24") },
      { title: "Later", type: "result", date: day("2026-12-01") },
    ]);
    expect(await titles("status=upcoming&today=2026-11-24")).toEqual(["Later", "Today"]);
    expect(await titles("status=past&today=2026-11-24")).toEqual(["Yesterday"]);
    expect(await titles("status=past&today=2026-11-24&monthOfYear=11")).toEqual(["Yesterday"]);
  });

  it("pages when page is given, reporting total and totalPages", async () => {
    await ExamAlert.create(
      [1, 2, 3, 4, 5].map((d) => ({ title: `D${d}`, type: "other", date: day(`2026-12-0${d}`) })),
    );
    const res = await request(app).get("/api/exam-alerts?page=2&limit=2");
    expect(res.body).toMatchObject({ total: 5, page: 2, totalPages: 3 });
    expect(res.body.data.map((a) => a.title)).toEqual(["D3", "D2"]);
  });

  it.each(["monthOfYear=13", "monthOfYear=1", "status=soon", "status=upcoming&today=24-11-2026"])(
    "400s on %s",
    async (qs) => {
      expect((await request(app).get(`/api/exam-alerts?${qs}`)).status).toBe(400);
    },
  );
});

describe("GET /api/exam-alerts/summary", () => {
  it("counts active alerts and lists the categories they use, archived ones included", async () => {
    const ssc = await Category.create({ name: "SSC" });
    const old = await Category.create({ name: "Old", isActive: false });
    await ExamAlert.create([
      { title: "UpcomingExam", type: "exam_date", date: day("2026-12-05"), category: ssc._id },
      { title: "PastExam", type: "exam_date", date: day("2026-11-01"), category: old._id },
      { title: "UpcomingResult", type: "result", date: day("2026-12-05") },
      { title: "Archived", type: "exam_date", date: day("2026-12-05"), isActive: false },
    ]);
    // Created long ago: insert raw so timestamps don't overwrite createdAt.
    await ExamAlert.collection.insertOne({
      title: "OldNews",
      type: "other",
      date: day("2026-12-05"),
      isActive: true,
      category: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });

    const res = await request(app).get("/api/exam-alerts/summary?today=2026-11-24");

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ total: 4, upcomingExams: 1, newThisWeek: 3 });
    expect(res.body.data.categories.map((c) => c.name)).toEqual(["Old", "SSC"]);
  });

  it("400s on a malformed today", async () => {
    expect((await request(app).get("/api/exam-alerts/summary?today=nope")).status).toBe(400);
  });
});

const valid = { title: "SSC CGL Tier 1", type: "exam_date", date: "2026-12-05" };

describe("admin exam alerts", () => {
  it("is admin-only", async () => {
    const student = await createUser("student");
    const asStudent = await request(app)
      .post("/api/admin/exam-alerts")
      .set("Authorization", bearer(student))
      .send(valid);
    expect(asStudent.status).toBe(403);

    const anon = await request(app).get("/api/admin/exam-alerts");
    expect(anon.status).toBe(401);
  });

  it("creates an alert (no notification unless asked)", async () => {
    const admin = await createUser("admin");
    const ssc = await Category.create({ name: "SSC" });

    const res = await request(app)
      .post("/api/admin/exam-alerts")
      .set("Authorization", bearer(admin))
      .send({ ...valid, description: "Exam on 5 Dec", category: ssc._id, link: "/exams/ssc" });

    expect(res.status).toBe(201);
    expect(res.body.notified).toBe(false);
    expect(res.body.data).toMatchObject({
      title: "SSC CGL Tier 1",
      type: "exam_date",
      isActive: true,
      link: "/exams/ssc",
      category: { name: "SSC" },
    });
    expect(res.body.data.date).toBe("2026-12-05T00:00:00.000Z");
    expect(await Notification.countDocuments()).toBe(0);
  });

  it.each([
    [{ ...valid, title: "  " }, /title/],
    [{ ...valid, type: "exam" }, /type/],
    [{ ...valid, date: "not a date" }, /date/],
    [{ title: "x", type: "result" }, /date/],
    [{ ...valid, link: "javascript:alert(1)" }, /link/],
    [{ ...valid, category: "nope" }, /category/],
    [{ ...valid, category: new mongoose.Types.ObjectId().toString() }, /category/],
  ])("400s on invalid input %#", async (body, message) => {
    const admin = await createUser("admin");
    const res = await request(app)
      .post("/api/admin/exam-alerts")
      .set("Authorization", bearer(admin))
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(message);
    expect(await ExamAlert.countDocuments()).toBe(0);
  });

  it("edits, archives and restores; admin list includes archived", async () => {
    const admin = await createUser("admin");
    const alert = await ExamAlert.create({ ...valid, date: day("2026-12-05") });
    const auth = { Authorization: bearer(admin) };

    const edited = await request(app)
      .patch(`/api/admin/exam-alerts/${alert._id}`)
      .set(auth)
      .send({ title: "Renamed", type: "admit_card" });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({ title: "Renamed", type: "admit_card" });

    const badPatch = await request(app)
      .patch(`/api/admin/exam-alerts/${alert._id}`)
      .set(auth)
      .send({ type: "nope" });
    expect(badPatch.status).toBe(400);

    const archived = await request(app).delete(`/api/admin/exam-alerts/${alert._id}`).set(auth);
    expect(archived.status).toBe(200);
    expect((await request(app).get("/api/exam-alerts")).body.data).toHaveLength(0);

    const adminList = await request(app).get("/api/admin/exam-alerts").set(auth);
    expect(adminList.body.data).toHaveLength(1);
    expect(adminList.body.data[0].isActive).toBe(false);

    const restored = await request(app)
      .patch(`/api/admin/exam-alerts/${alert._id}`)
      .set(auth)
      .send({ isActive: true });
    expect(restored.status).toBe(200);
    expect((await request(app).get("/api/exam-alerts")).body.data).toHaveLength(1);
  });

  it("stores empty strings when link or description is patched with null", async () => {
    const admin = await createUser("admin");
    const alert = await ExamAlert.create({ ...valid, date: day("2026-12-05"), description: "D", link: "/exams" });
    const res = await request(app)
      .patch(`/api/admin/exam-alerts/${alert._id}`)
      .set("Authorization", bearer(admin))
      .send({ link: null, description: null });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ link: "", description: "" });
  });

  it("clears the category when patched with null", async () => {
    const admin = await createUser("admin");
    const ssc = await Category.create({ name: "SSC" });
    const alert = await ExamAlert.create({ ...valid, date: day("2026-12-05"), category: ssc._id });
    const res = await request(app)
      .patch(`/api/admin/exam-alerts/${alert._id}`)
      .set("Authorization", bearer(admin))
      .send({ category: null });
    expect(res.status).toBe(200);
    expect(res.body.data.category).toBeNull();
  });

  it("404s for unknown or malformed ids", async () => {
    const admin = await createUser("admin");
    const auth = { Authorization: bearer(admin) };
    const missing = new mongoose.Types.ObjectId();
    expect(
      (await request(app).patch(`/api/admin/exam-alerts/${missing}`).set(auth).send({ title: "x" })).status,
    ).toBe(404);
    expect((await request(app).delete(`/api/admin/exam-alerts/${missing}`).set(auth)).status).toBe(404);
    expect((await request(app).delete("/api/admin/exam-alerts/nope").set(auth)).status).toBe(404);
  });
});

describe("POST /api/admin/exam-alerts notify", () => {
  it("creates exactly one broadcast linking to the student Exam Alerts page", async () => {
    const admin = await createUser("admin");
    const res = await request(app)
      .post("/api/admin/exam-alerts")
      .set("Authorization", bearer(admin))
      .send({ ...valid, description: "Exam on 5 Dec", notify: true });

    expect(res.status).toBe(201);
    expect(res.body.notified).toBe(true);
    const notes = await Notification.find();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      user: null,
      title: "SSC CGL Tier 1",
      message: "Exam on 5 Dec",
      type: "info",
      link: "/dashboard/exam-alerts",
      source: "exam_alert",
    });
    expect(String(notes[0].createdBy)).toBe(String(admin._id));
  });

  it("uses the formatted date as the message when there is no description", async () => {
    const admin = await createUser("admin");
    await request(app)
      .post("/api/admin/exam-alerts")
      .set("Authorization", bearer(admin))
      .send({ ...valid, notify: true });
    const note = await Notification.findOne();
    expect(note.message).toMatch(/Dec/);
    expect(note.message).toMatch(/2026/);
  });

  it("creates no notification when notify is false", async () => {
    const admin = await createUser("admin");
    const res = await request(app)
      .post("/api/admin/exam-alerts")
      .set("Authorization", bearer(admin))
      .send({ ...valid, notify: false });
    expect(res.body.notified).toBe(false);
    expect(await Notification.countDocuments()).toBe(0);
  });

  it("keeps the alert and reports notified: false when the notification insert fails", async () => {
    const admin = await createUser("admin");
    const createSpy = jest.spyOn(Notification, "create").mockRejectedValueOnce(new Error("db down"));
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app)
      .post("/api/admin/exam-alerts")
      .set("Authorization", bearer(admin))
      .send({ ...valid, notify: true });

    createSpy.mockRestore();
    errorSpy.mockRestore();
    expect(res.status).toBe(201);
    expect(res.body.notified).toBe(false);
    expect(await ExamAlert.countDocuments()).toBe(1);
  });

  it("does not notify on edit unless asked", async () => {
    const admin = await createUser("admin");
    const alert = await ExamAlert.create({ ...valid, date: day("2026-12-05") });
    const res = await request(app)
      .patch(`/api/admin/exam-alerts/${alert._id}`)
      .set("Authorization", bearer(admin))
      .send({ title: "Changed" });
    expect(res.status).toBe(200);
    expect(res.body.notified).toBe(false);
    expect(await Notification.countDocuments()).toBe(0);
  });

  it("notifies on edit when asked, with an Updated: title", async () => {
    const admin = await createUser("admin");
    const alert = await ExamAlert.create({ ...valid, date: day("2026-12-05") });
    const res = await request(app)
      .patch(`/api/admin/exam-alerts/${alert._id}`)
      .set("Authorization", bearer(admin))
      .send({ title: "Changed", description: "Moved to 9 Dec", notify: true });

    expect(res.status).toBe(200);
    expect(res.body.notified).toBe(true);
    const notes = await Notification.find();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      user: null,
      title: "Updated: Changed",
      message: "Moved to 9 Dec",
      link: "/dashboard/exam-alerts",
      source: "exam_alert",
    });
  });

  it("does not notify when editing an archived alert", async () => {
    const admin = await createUser("admin");
    const alert = await ExamAlert.create({ ...valid, date: day("2026-12-05"), isActive: false });
    const res = await request(app)
      .patch(`/api/admin/exam-alerts/${alert._id}`)
      .set("Authorization", bearer(admin))
      .send({ title: "Changed", notify: true });
    expect(res.body.notified).toBe(false);
    expect(await Notification.countDocuments()).toBe(0);
  });
});
