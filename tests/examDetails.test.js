import mongoose from "mongoose";
import request from "supertest";
import app from "../app.js";
import { connectTestDb, disconnectTestDb, clearTestDb } from "./testDb.js";
import User from "../models/Users.js";
import Category from "../models/Category.js";
import TestSeries from "../models/TestSeries.js";
import generateToken from "../utils/generateToken.js";
import { EXAM_DETAIL_MAX, normalizeExamDetails } from "../utils/examDetails.js";

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

describe("normalizeExamDetails", () => {
  it("fills missing sections, trims, and normalises line endings", () => {
    expect(
      normalizeExamDetails({
        eligibility: "  Age: 18-32 years  \r\n\r\n\r\n- Graduate   \r\n",
        syllabus: null,
      })
    ).toEqual({ eligibility: "Age: 18-32 years\n\n- Graduate", pattern: "", syllabus: "" });
  });

  it.each([
    [null, /must be an object/],
    [["x"], /must be an object/],
    [{ eligibility: 5 }, /"eligibility" must be text/],
    [{ salary: "x" }, /unknown section/],
    [{ pattern: "a".repeat(EXAM_DETAIL_MAX + 1) }, /at most/],
  ])("rejects %j", (value, message) => {
    expect(() => normalizeExamDetails(value)).toThrow(message);
  });
});

describe("test-series examDetails via the API", () => {
  let admin;
  let student;
  let category;
  const bearer = (u) => `Bearer ${generateToken(u._id.toString(), u.role)}`;
  const user = (role) =>
    User.create({ email: `${role}-${new mongoose.Types.ObjectId()}@example.com`, password: "Passw0rd!", role });

  beforeEach(async () => {
    admin = await user("admin");
    student = await user("student");
    category = await Category.create({ name: "SSC" });
  });

  it("saves on create, replaces on update, and 400s on bad input", async () => {
    const created = await request(app)
      .post("/api/admin/test-series")
      .set("Authorization", bearer(admin))
      .field("name", "SSC CGL")
      .field("category", String(category._id))
      .field("examDetails", JSON.stringify({ eligibility: "Graduate", syllabus: "- Reasoning\n- Quant" }));
    expect(created.status).toBe(201);
    expect(created.body.data.examDetails).toEqual({ eligibility: "Graduate", pattern: "", syllabus: "- Reasoning\n- Quant" });

    const id = created.body.data._id;
    const updated = await request(app)
      .patch(`/api/admin/test-series/${id}`)
      .set("Authorization", bearer(admin))
      .field("examDetails", JSON.stringify({ pattern: "Tier 1: 100 questions" }));
    expect(updated.status).toBe(200);
    expect((await TestSeries.findById(id).lean()).examDetails).toEqual({
      eligibility: "",
      pattern: "Tier 1: 100 questions",
      syllabus: "",
    });

    for (const bad of ['{"salary":"x"}', '{"eligibility":5}', "not json"]) {
      const res = await request(app)
        .patch(`/api/admin/test-series/${id}`)
        .set("Authorization", bearer(admin))
        .field("examDetails", bad);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/^Invalid examDetails: /);
    }

    // Other fields still update without touching examDetails.
    await request(app).patch(`/api/admin/test-series/${id}`).set("Authorization", bearer(admin)).field("name", "SSC CGL 2026");
    expect((await TestSeries.findById(id).lean()).examDetails.pattern).toBe("Tier 1: 100 questions");
  });

  it("is left out of student lists but present on the exam page and admin list", async () => {
    await TestSeries.create({
      name: "SSC CGL",
      category: category._id,
      isPublished: true,
      examDetails: { eligibility: "Graduate" },
    });
    const id = (await TestSeries.findOne().lean())._id;

    const studentList = await request(app).get("/api/test-series").set("Authorization", bearer(student));
    expect(studentList.body.data[0].examDetails).toBeUndefined();
    const anonList = await request(app).get("/api/test-series");
    expect(anonList.body.data[0].examDetails).toBeUndefined();

    const page = await request(app).get(`/api/test-series/${id}`);
    expect(page.body.data.examDetails.eligibility).toBe("Graduate");

    const adminList = await request(app).get("/api/test-series").set("Authorization", bearer(admin));
    expect(adminList.body.data[0].examDetails.eligibility).toBe("Graduate");
  });
});
