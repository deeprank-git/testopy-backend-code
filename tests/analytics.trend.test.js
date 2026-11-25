import mongoose from "mongoose";
import request from "supertest";
import app from "../app.js";
import { connectTestDb, disconnectTestDb, clearTestDb } from "./testDb.js";
import User from "../models/Users.js";
import TestAttempt from "../models/TestAttempt.js";
import generateToken from "../utils/generateToken.js";
import { todayUtcMidnight, addUtcDays } from "../utils/dateOnly.js";

const createUser = (role) =>
  User.create({
    email: `${role}-${new mongoose.Types.ObjectId()}@example.com`,
    password: "Passw0rd!",
    role,
  });
const bearer = (user) => `Bearer ${generateToken(user._id.toString(), user.role)}`;
const ymd = (d) => d.toISOString().slice(0, 10);
const ym = (d) => d.toISOString().slice(0, 7);
const monthsAgo = (n) => {
  const t = todayUtcMidnight();
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - n, 15));
};

// Raw insert so createdAt is exactly what we set (bypasses Mongoose timestamps).
const insertAttemptsOn = (date, n, status = "completed") =>
  TestAttempt.collection.insertMany(
    Array.from({ length: n }, () => ({
      user: new mongoose.Types.ObjectId(),
      test: new mongoose.Types.ObjectId(),
      status,
      createdAt: date,
      updatedAt: date,
    })),
  );

const getTrend = async (query) => {
  const admin = await createUser("admin");
  return request(app)
    .get(`/api/admin/analytics/attempts-trend${query}`)
    .set("Authorization", bearer(admin));
};

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

describe("GET /api/admin/analytics/attempts-trend", () => {
  it("requires an admin", async () => {
    const student = await createUser("student");
    const res = await request(app)
      .get("/api/admin/analytics/attempts-trend")
      .set("Authorization", bearer(student));
    expect(res.status).toBe(403);
  });

  it("defaults to 30 zero-filled UTC days ending today, oldest first", async () => {
    const today = todayUtcMidnight();
    await insertAttemptsOn(today, 3); // today 00:00 UTC
    await insertAttemptsOn(new Date(addUtcDays(today, -1).getTime() + 23 * 3600e3), 2); // yesterday 23:00
    await insertAttemptsOn(addUtcDays(today, -29), 1); // first day in range
    await insertAttemptsOn(addUtcDays(today, -30), 5); // outside range

    const res = await getTrend("");

    expect(res.status).toBe(200);
    const { range, granularity, total, points } = res.body.data;
    expect(range).toBe("30d");
    expect(granularity).toBe("day");
    expect(points).toHaveLength(30);
    expect(points[0]).toMatchObject({ date: ymd(addUtcDays(today, -29)), count: 1 });
    expect(points[28]).toMatchObject({ date: ymd(addUtcDays(today, -1)), count: 2 });
    expect(points[29]).toMatchObject({ date: ymd(today), count: 3 });
    expect(total).toBe(6);
  });

  it("supports 7d", async () => {
    const today = todayUtcMidnight();
    await insertAttemptsOn(addUtcDays(today, -6), 2);
    await insertAttemptsOn(addUtcDays(today, -7), 4); // outside

    const res = await getTrend("?range=7d");

    expect(res.body.data.points).toHaveLength(7);
    expect(res.body.data.points[0]).toMatchObject({ date: ymd(addUtcDays(today, -6)), count: 2 });
    expect(res.body.data.total).toBe(2);
  });

  it("all: monthly buckets from the first attempt's month to this month", async () => {
    await insertAttemptsOn(monthsAgo(9), 4);
    await insertAttemptsOn(monthsAgo(1), 2);
    await insertAttemptsOn(monthsAgo(0), 1);

    const res = await getTrend("?range=all");

    const { granularity, total, points } = res.body.data;
    expect(granularity).toBe("month");
    expect(points).toHaveLength(10);
    expect(points[0]).toMatchObject({ date: ym(monthsAgo(9)), count: 4 });
    expect(points[8]).toMatchObject({ date: ym(monthsAgo(1)), count: 2 });
    expect(points[9]).toMatchObject({ date: ym(monthsAgo(0)), count: 1 });
    expect(total).toBe(7);
  });

  it("all: shows at least the last 6 months", async () => {
    await insertAttemptsOn(monthsAgo(0), 1);
    const res = await getTrend("?range=all");
    expect(res.body.data.points).toHaveLength(6);
    expect(res.body.data.points[5]).toMatchObject({ date: ym(monthsAgo(0)), count: 1 });
  });

  it("splits each bucket by status (paused counts as in progress)", async () => {
    const today = todayUtcMidnight();
    await insertAttemptsOn(today, 3, "completed");
    await insertAttemptsOn(today, 2, "auto-submitted");
    await insertAttemptsOn(today, 1, "in-progress");
    await insertAttemptsOn(today, 1, "paused");

    const res = await getTrend("?range=7d");

    expect(res.body.data.points[6]).toEqual({
      date: ymd(today),
      count: 7,
      completed: 3,
      autoSubmitted: 2,
      inProgress: 2,
    });
    expect(res.body.data.points[0]).toEqual({
      date: ymd(addUtcDays(today, -6)),
      count: 0,
      completed: 0,
      autoSubmitted: 0,
      inProgress: 0,
    });
  });

  it("rejects an unknown range", async () => {
    const res = await getTrend("?range=1y");
    expect(res.status).toBe(400);
  });
});
