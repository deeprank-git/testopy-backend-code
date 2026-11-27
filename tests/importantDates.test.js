import mongoose from "mongoose";
import request from "supertest";
import app from "../app.js";
import { connectTestDb, disconnectTestDb, clearTestDb } from "./testDb.js";
import User from "../models/Users.js";
import Category from "../models/Category.js";
import TestSeries from "../models/TestSeries.js";
import generateToken from "../utils/generateToken.js";
import { normalizeImportantDates, IMPORTANT_DATE_TEXT_MAX } from "../utils/importantDates.js";

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

describe("normalizeImportantDates", () => {
  it("accepts dates, text, or both, trimming text and dropping empty text", () => {
    expect(
      normalizeImportantDates({
        " Exam Date ": { from: "2026-09-30", to: "2026-10-30" },
        "Tier 2": { text: "  December   2026 " },
        "Last Date": { from: "2026-07-26", to: "2026-07-26", text: "Extended" },
        "Admit Card": { from: "2026-08-01", to: "2026-08-01", text: "  " },
        Result: { from: "", to: "", text: "TBA" },
      })
    ).toEqual({
      "Exam Date": { from: "2026-09-30", to: "2026-10-30" },
      "Tier 2": { text: "December 2026" },
      "Last Date": { from: "2026-07-26", to: "2026-07-26", text: "Extended" },
      "Admit Card": { from: "2026-08-01", to: "2026-08-01" },
      Result: { text: "TBA" },
    });
  });

  it.each([
    [{ X: {} }, /needs dates, text, or both/],
    [{ X: { text: "" } }, /needs dates, text, or both/],
    [{ X: { from: "2026-01-01" } }, /needs both from and to/],
    [{ X: { from: "2026-02-30", to: "2026-02-30" } }, /YYYY-MM-DD/],
    [{ X: { from: "July 2025", to: "July 2025" } }, /YYYY-MM-DD/],
    [{ X: { from: "2026-05-02", to: "2026-05-01" } }, /from after to/],
    [{ X: { text: 5 } }, /text must be a string/],
    [{ X: { text: "a".repeat(IMPORTANT_DATE_TEXT_MAX + 1) } }, /at most/],
    [{ X: { date: "2026-01-01" } }, /unknown field/],
    [{ X: "December 2026" }, /must be/],
    [{ "  ": { text: "TBA" } }, /needs a label/],
    [{ X: { text: "a" }, " X ": { text: "b" } }, /listed twice/],
    [[], /must be an object/],
  ])("rejects %j", (value, message) => {
    expect(() => normalizeImportantDates(value)).toThrow(message);
  });
});

describe("admin test-series API importantDates", () => {
  let admin;
  let category;
  const bearer = (u) => `Bearer ${generateToken(u._id.toString(), u.role)}`;

  beforeEach(async () => {
    admin = await User.create({
      email: `admin-${new mongoose.Types.ObjectId()}@example.com`,
      password: "Passw0rd!",
      role: "admin",
    });
    category = await Category.create({ name: "SSC" });
  });

  const dates = {
    "Exam Date": { from: "2026-09-30", to: "2026-10-30" },
    "Tier 2": { text: " December 2026 " },
    "Last Date": { from: "2026-07-26", to: "2026-07-26", text: "Extended" },
  };

  it("stores mixed entries on create and on update (multipart form field)", async () => {
    const created = await request(app)
      .post("/api/admin/test-series")
      .set("Authorization", bearer(admin))
      .field("name", "SSC CGL")
      .field("category", String(category._id))
      .field("importantDates", JSON.stringify(dates));
    expect(created.status).toBe(201);
    expect(created.body.data.importantDates["Tier 2"]).toEqual({ text: "December 2026" });

    const updated = await request(app)
      .patch(`/api/admin/test-series/${created.body.data._id}`)
      .set("Authorization", bearer(admin))
      .field("importantDates", JSON.stringify({ Result: { text: "TBA" } }));
    expect(updated.status).toBe(200);
    expect((await TestSeries.findById(created.body.data._id).lean()).importantDates).toEqual({
      Result: { text: "TBA" },
    });
  });

  it("rejects bad entries with 400 on update too (previously unchecked)", async () => {
    const series = await TestSeries.create({ name: "SSC CHSL", category: category._id, importantDates: dates });

    for (const bad of ['{"X":{"from":"2026-01-01"}}', '{"X":"July 2025"}', "not json"]) {
      const res = await request(app)
        .patch(`/api/admin/test-series/${series._id}`)
        .set("Authorization", bearer(admin))
        .field("importantDates", bad);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/^Invalid importantDates: /);
    }
    expect(Object.keys((await TestSeries.findById(series._id).lean()).importantDates)).toEqual(Object.keys(dates));
  });
});
