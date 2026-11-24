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
