import mongoose from "mongoose";
import request from "supertest";
import app from "../app.js";
import { connectTestDb, disconnectTestDb, clearTestDb } from "./testDb.js";
import User from "../models/Users.js";
import Category from "../models/Category.js";
import generateToken from "../utils/generateToken.js";

const createUser = (role) =>
  User.create({
    email: `${role}-${new mongoose.Types.ObjectId()}@example.com`,
    password: "Passw0rd!",
    role,
  });
const bearer = (user) => `Bearer ${generateToken(user._id.toString(), user.role)}`;
const names = (res) => res.body.data.map((c) => c.name);

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

describe("category ordering", () => {
  it("sorts by order, then name, on public and admin lists", async () => {
    const admin = await createUser("admin");
    await Category.create({ name: "Banking", order: 2 });
    await Category.create({ name: "SSC", order: 1 });
    await Category.create({ name: "Railways", order: 1 });

    const pub = await request(app).get("/api/categories");
    expect(names(pub)).toEqual(["Railways", "SSC", "Banking"]);

    const adm = await request(app).get("/api/categories?admin=true").set("Authorization", bearer(admin));
    expect(names(adm)).toEqual(["Railways", "SSC", "Banking"]);
  });

  it("appends newly created categories to the end", async () => {
    const admin = await createUser("admin");
    await Category.create({ name: "Zeta", order: 5 });

    const res = await request(app)
      .post("/api/admin/categories")
      .set("Authorization", bearer(admin))
      .field("name", "Alpha");

    expect(res.status).toBe(201);
    expect(res.body.data.order).toBe(6);
  });
});

describe("PATCH /api/admin/categories/reorder", () => {
  it("saves the given sequence as order 0..n-1", async () => {
    const admin = await createUser("admin");
    const a = await Category.create({ name: "A" });
    const b = await Category.create({ name: "B" });
    const c = await Category.create({ name: "C" });

    const res = await request(app)
      .patch("/api/admin/categories/reorder")
      .set("Authorization", bearer(admin))
      .send({ ids: [c._id, a._id, b._id] });

    expect(res.status).toBe(200);
    const pub = await request(app).get("/api/categories");
    expect(names(pub)).toEqual(["C", "A", "B"]);
  });

  it("rejects a missing or invalid ids list", async () => {
    const admin = await createUser("admin");
    for (const body of [{}, { ids: "x" }, { ids: ["not-an-id"] }]) {
      const res = await request(app)
        .patch("/api/admin/categories/reorder")
        .set("Authorization", bearer(admin))
        .send(body);
      expect(res.status).toBe(400);
    }
  });

  it("is admin-only", async () => {
    const student = await createUser("student");
    const res = await request(app)
      .patch("/api/admin/categories/reorder")
      .set("Authorization", bearer(student))
      .send({ ids: [] });
    expect(res.status).toBe(403);
  });
});
