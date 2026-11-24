import mongoose from "mongoose";
import request from "supertest";
import app from "../app.js";
import { connectTestDb, disconnectTestDb, clearTestDb } from "./testDb.js";
import User from "../models/Users.js";
import Notification from "../models/Notification.js";
import generateToken from "../utils/generateToken.js";

const createUser = (role) =>
  User.create({
    email: `${role}-${new mongoose.Types.ObjectId()}@example.com`,
    password: "Passw0rd!",
    role,
  });
const bearer = (user) => `Bearer ${generateToken(user._id.toString(), user.role)}`;

beforeAll(connectTestDb);
afterAll(disconnectTestDb);
afterEach(clearTestDb);

describe("notification links", () => {
  it("stores an in-app link and returns it to students", async () => {
    const admin = await createUser("admin");
    const student = await createUser("student");

    const sent = await request(app)
      .post("/api/admin/notifications")
      .set("Authorization", bearer(admin))
      .send({ title: "T", message: "M", link: "/dashboard/exam-alerts" });

    expect(sent.status).toBe(201);
    expect(sent.body.data.link).toBe("/dashboard/exam-alerts");

    const mine = await request(app).get("/api/notifications/me").set("Authorization", bearer(student));
    expect(mine.body.data[0].link).toBe("/dashboard/exam-alerts");
  });

  it("accepts a full https URL and an empty link", async () => {
    const admin = await createUser("admin");
    for (const link of ["https://ssc.gov.in/notice", ""]) {
      const res = await request(app)
        .post("/api/admin/notifications")
        .set("Authorization", bearer(admin))
        .send({ title: "T", message: "M", link });
      expect({ link, status: res.status }).toEqual({ link, status: 201 });
    }
  });

  it.each(["javascript:alert(1)", "//evil.example", "dashboard", "ftp://x.org"])(
    "rejects link %p with 400",
    async (link) => {
      const admin = await createUser("admin");
      const res = await request(app)
        .post("/api/admin/notifications")
        .set("Authorization", bearer(admin))
        .send({ title: "T", message: "M", link });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/link/i);
    },
  );
});
