import mongoose from "mongoose";
import request from "supertest";
import app from "../app.js";
import { connectTestDb, disconnectTestDb, clearTestDb } from "./testDb.js";
import User from "../models/Users.js";
import generateToken from "../utils/generateToken.js";

const createUser = (role, over = {}) =>
  User.create({
    email: `${role}-${new mongoose.Types.ObjectId()}@example.com`,
    password: "Passw0rd!",
    role,
    ...over,
  });
const bearer = (user) => `Bearer ${generateToken(user._id.toString(), user.role)}`;

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

describe("GET /api/admin/users search and limit", () => {
  const get = (admin, qs) =>
    request(app).get(`/api/admin/users${qs}`).set("Authorization", bearer(admin));
  const emails = (res) => res.body.data.map((u) => u.email).sort();

  it("returns every matching user when no search or limit is given", async () => {
    const admin = await createUser("admin");
    await Promise.all([1, 2, 3].map(() => createUser("student")));
    const res = await get(admin, "?role=student");
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
  });

  it("searches name and email, case-insensitively", async () => {
    const admin = await createUser("admin");
    await createUser("student", { name: "Asha Verma", email: "asha@example.com" });
    await createUser("student", { name: "Ravi", email: "VERMA.r@example.com" });
    await createUser("student", { name: "Kiran", email: "kiran@example.com" });

    expect(emails(await get(admin, "?role=student&search=verma"))).toEqual([
      "asha@example.com",
      "verma.r@example.com",
    ]);
  });

  it("treats the search as literal text, not a regex", async () => {
    const admin = await createUser("admin");
    await createUser("student", { email: "a.b@example.com" });
    await createUser("student", { email: "axb@example.com" });
    expect(emails(await get(admin, "?role=student&search=a.b"))).toEqual(["a.b@example.com"]);
  });

  it("caps results with limit (1..100)", async () => {
    const admin = await createUser("admin");
    await Promise.all([1, 2, 3].map(() => createUser("student")));
    expect((await get(admin, "?role=student&limit=2")).body.data).toHaveLength(2);
    expect((await get(admin, "?role=student&limit=0")).body.data).toHaveLength(1);
  });
});
