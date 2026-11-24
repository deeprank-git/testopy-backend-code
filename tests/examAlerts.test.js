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
