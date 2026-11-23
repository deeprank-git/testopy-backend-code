import mongoose from "mongoose";
import request from "supertest";
import app from "../app.js";
import { connectTestDb, disconnectTestDb, clearTestDb } from "./testDb.js";
import User from "../models/Users.js";
import Category from "../models/Category.js";
import TestSeries from "../models/TestSeries.js";
import Test from "../models/Test.js";
import generateToken from "../utils/generateToken.js";

const createUser = (role) =>
  User.create({
    email: `${role}-${new mongoose.Types.ObjectId()}@example.com`,
    password: "Passw0rd!",
    role,
  });
const bearer = (user) => `Bearer ${generateToken(user._id.toString(), user.role)}`;

const section = { name: "Reasoning", no_of_questions: 2, no_of_marks: 4, duration: 10 };

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

describe("GET /api/categories?admin=true", () => {
  it("returns archived categories with description and seriesCount for admins", async () => {
    const admin = await createUser("admin");
    const ssc = await Category.create({ name: "SSC", description: "Staff Selection" });
    await Category.create({ name: "Old", isActive: false });
    await TestSeries.create({ name: "CGL", category: ssc._id });
    await TestSeries.create({ name: "CHSL", category: ssc._id, isActive: false });

    const res = await request(app).get("/api/categories?admin=true").set("Authorization", bearer(admin));

    expect(res.status).toBe(200);
    const byName = Object.fromEntries(res.body.data.map((c) => [c.name, c]));
    expect(Object.keys(byName).sort()).toEqual(["Old", "SSC"]);
    expect(byName.SSC.description).toBe("Staff Selection");
    expect(byName.SSC.isActive).toBe(true);
    expect(byName.SSC.seriesCount).toBe(1); // archived series not counted
    expect(byName.Old.seriesCount).toBe(0);
  });

  it("ignores admin=true for non-admins (public view unchanged)", async () => {
    const student = await createUser("student");
    await Category.create({ name: "SSC" });
    await Category.create({ name: "Old", isActive: false });

    const res = await request(app).get("/api/categories?admin=true").set("Authorization", bearer(student));

    expect(res.status).toBe(200);
    expect(res.body.data.map((c) => c.name)).toEqual(["SSC"]);
    expect(res.body.data[0].seriesCount).toBeUndefined();
  });
});

describe("admin getById for archived items", () => {
  it("returns an archived category, series and test to admins", async () => {
    const admin = await createUser("admin");
    const cat = await Category.create({ name: "Old", isActive: false });
    const series = await TestSeries.create({ name: "S", category: cat._id, isActive: false });
    const test = await Test.create({
      title: "T", testSeries: series._id, duration: 10, sections: [section], isActive: false,
    });

    for (const url of [`/api/categories/${cat._id}`, `/api/test-series/${series._id}`, `/api/tests/${test._id}`]) {
      const res = await request(app).get(url).set("Authorization", bearer(admin));
      expect({ url, status: res.status }).toEqual({ url, status: 200 });
      expect(res.body.data.isActive).toBe(false);
    }
  });

  it("still 404s archived items for students", async () => {
    const student = await createUser("student");
    const cat = await Category.create({ name: "Old", isActive: false });
    const res = await request(app).get(`/api/categories/${cat._id}`).set("Authorization", bearer(student));
    expect(res.status).toBe(404);
  });
});

describe("GET /api/tests (admin)", () => {
  it("includes sections and isActive in the list payload", async () => {
    const admin = await createUser("admin");
    const cat = await Category.create({ name: "SSC" });
    const series = await TestSeries.create({ name: "S", category: cat._id });
    await Test.create({ title: "T", testSeries: series._id, duration: 10, sections: [section] });

    const res = await request(app).get(`/api/tests?testSeries=${series._id}`).set("Authorization", bearer(admin));

    expect(res.status).toBe(200);
    expect(res.body.data[0].isActive).toBe(true);
    expect(res.body.data[0].sections).toHaveLength(1);
    expect(res.body.data[0].sections[0].no_of_questions).toBe(2);
  });
});
