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
    expect(sent.body.data.source).toBe("manual"); // hand-written, even though it links to exam alerts

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

describe("DELETE /api/admin/notifications/:id", () => {
  it("hard-deletes the notification, then 404s on repeat", async () => {
    const admin = await createUser("admin");
    const n = await Notification.create({ title: "T", message: "M", user: null });

    const first = await request(app)
      .delete(`/api/admin/notifications/${n._id}`)
      .set("Authorization", bearer(admin));
    expect(first.status).toBe(200);
    expect(await Notification.countDocuments()).toBe(0);

    const again = await request(app)
      .delete(`/api/admin/notifications/${n._id}`)
      .set("Authorization", bearer(admin));
    expect(again.status).toBe(404);
  });

  it("404s on a malformed id", async () => {
    const admin = await createUser("admin");
    const res = await request(app)
      .delete("/api/admin/notifications/not-an-id")
      .set("Authorization", bearer(admin));
    expect(res.status).toBe(404);
  });

  it("is admin-only", async () => {
    const student = await createUser("student");
    const n = await Notification.create({ title: "T", message: "M", user: null });
    const res = await request(app)
      .delete(`/api/admin/notifications/${n._id}`)
      .set("Authorization", bearer(student));
    expect(res.status).toBe(403);
    expect(await Notification.countDocuments()).toBe(1);
  });
});

describe("GET /api/notifications/me unreadCount", () => {
  it("counts every unread notification, not just the returned page", async () => {
    const student = await createUser("student");
    const other = await createUser("student");

    await Notification.insertMany(
      Array.from({ length: 60 }, (_, i) => ({ title: `B${i}`, message: "m", user: null })),
    );
    await Notification.create([
      { title: "Mine", message: "m", user: student._id },
      { title: "MineRead", message: "m", user: student._id, isRead: true },
      { title: "Theirs", message: "m", user: other._id },
      { title: "Seen", message: "m", user: null, readBy: [student._id] },
    ]);

    const res = await request(app).get("/api/notifications/me").set("Authorization", bearer(student));

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(20); // default page size
    expect(res.body.unreadCount).toBe(61); // 60 unread broadcasts + "Mine"
  });
});

describe("PATCH /api/notifications/read-all", () => {
  it("marks targeted and broadcast notifications read for the caller only", async () => {
    const student = await createUser("student");
    const other = await createUser("student");
    await Notification.create([
      { title: "Mine", message: "m", user: student._id },
      { title: "Theirs", message: "m", user: other._id },
      { title: "Broadcast", message: "m", user: null },
      { title: "AlreadySeen", message: "m", user: null, readBy: [student._id] },
    ]);

    const res = await request(app)
      .patch("/api/notifications/read-all")
      .set("Authorization", bearer(student));
    expect(res.status).toBe(200);

    const mine = await request(app).get("/api/notifications/me").set("Authorization", bearer(student));
    expect(mine.body.unreadCount).toBe(0);
    expect(mine.body.data.every((n) => n.isRead)).toBe(true);

    const theirs = await request(app).get("/api/notifications/me").set("Authorization", bearer(other));
    expect(theirs.body.unreadCount).toBe(3); // Theirs + Broadcast + AlreadySeen

    const seen = await Notification.findOne({ title: "AlreadySeen" });
    expect(seen.readBy).toHaveLength(1); // $addToSet, no duplicate
  });
});

describe("GET /api/admin/notifications", () => {
  it("returns readCount for broadcasts and hides the raw readBy array", async () => {
    const admin = await createUser("admin");
    const s1 = await createUser("student");
    const s2 = await createUser("student");
    await Notification.create([
      { title: "Broadcast", message: "m", user: null, readBy: [s1._id, s2._id] },
      { title: "Targeted", message: "m", user: s1._id },
    ]);

    const res = await request(app).get("/api/admin/notifications").set("Authorization", bearer(admin));

    expect(res.status).toBe(200);
    const byTitle = Object.fromEntries(res.body.data.map((n) => [n.title, n]));
    expect(byTitle.Broadcast.readCount).toBe(2);
    expect(byTitle.Broadcast.readBy).toBeUndefined();
    expect(byTitle.Targeted.readCount).toBeUndefined();
    expect(byTitle.Targeted.user.email).toBe(s1.email);
  });

  it("labels audience and source, and keeps a deleted student's notification targeted", async () => {
    const admin = await createUser("admin");
    const gone = await createUser("student");
    await Notification.create([
      { title: "Broadcast", message: "m", user: null, source: "exam_alert", link: "/dashboard/exam-alerts" },
      { title: "ToGone", message: "m", user: gone._id, source: "manual" },
    ]);
    await User.deleteOne({ _id: gone._id }); // no API does this; only a direct DB delete

    const res = await request(app).get("/api/admin/notifications").set("Authorization", bearer(admin));

    const byTitle = Object.fromEntries(res.body.data.map((n) => [n.title, n]));
    expect(byTitle.Broadcast).toMatchObject({ audience: "all", source: "exam_alert", readCount: 0 });
    expect(byTitle.ToGone).toMatchObject({ audience: "student", user: null, source: "manual" });
    expect(byTitle.ToGone.readCount).toBeUndefined();
  });
});

describe("GET /api/notifications/me filters and paging", () => {
  const get = (user, qs = "") =>
    request(app).get(`/api/notifications/me${qs}`).set("Authorization", bearer(user));
  const titles = (res) => res.body.data.map((n) => n.title).sort();

  it("filters by type and unread, alone and together; unreadCount stays unfiltered", async () => {
    const student = await createUser("student");
    await Notification.create([
      { title: "ResultUnread", message: "m", type: "result", user: student._id },
      { title: "ResultRead", message: "m", type: "result", user: student._id, isRead: true },
      { title: "OfferBroadcast", message: "m", type: "offer", user: null },
      { title: "ResultSeen", message: "m", type: "result", user: null, readBy: [student._id] },
    ]);

    expect(titles(await get(student, "?type=result"))).toEqual(["ResultRead", "ResultSeen", "ResultUnread"]);
    expect(titles(await get(student, "?unread=1"))).toEqual(["OfferBroadcast", "ResultUnread"]);

    const both = await get(student, "?type=result&unread=1");
    expect(titles(both)).toEqual(["ResultUnread"]);
    expect(both.body.unreadCount).toBe(2);
  });

  it("filters by source, counting old exam-alert-linked rows as exam alerts", async () => {
    const student = await createUser("student");
    await Notification.create([
      { title: "NewAlert", message: "m", user: null, source: "exam_alert", link: "/dashboard/exam-alerts" },
      { title: "Manual", message: "m", user: null, source: "manual", link: "/dashboard/exam-alerts" },
    ]);
    // Rows sent before `source` existed: raw insert so the field is absent.
    await Notification.collection.insertMany([
      { title: "OldAlert", message: "m", type: "info", user: null, link: "/dashboard/exam-alerts", readBy: [], createdAt: new Date() },
      { title: "OldManual", message: "m", type: "info", user: null, link: "/x", readBy: [], createdAt: new Date() },
    ]);

    const alerts = await get(student, "?source=exam_alert");
    expect(titles(alerts)).toEqual(["NewAlert", "OldAlert"]);
    expect(alerts.body.data.every((n) => n.source === "exam_alert")).toBe(true);
    expect(titles(await get(student, "?source=manual"))).toEqual(["Manual", "OldManual"]);
  });

  it("pages newest first with before, and reports hasMore", async () => {
    const student = await createUser("student");
    await Notification.insertMany(
      Array.from({ length: 5 }, (_, i) => ({ title: `N${i}`, message: "m", user: null })),
    );

    const first = await get(student, "?limit=3");
    expect(first.body.data.map((n) => n.title)).toEqual(["N4", "N3", "N2"]);
    expect(first.body.hasMore).toBe(true);

    const second = await get(student, `?limit=3&before=${first.body.data[2]._id}`);
    expect(second.body.data.map((n) => n.title)).toEqual(["N1", "N0"]);
    expect(second.body.hasMore).toBe(false);
  });

  it("derives isRead per caller for broadcasts and hides readBy", async () => {
    const student = await createUser("student");
    await Notification.create({ title: "B", message: "m", user: null, readBy: [student._id] });
    const res = await get(student);
    expect(res.body.data[0].isRead).toBe(true);
    expect(res.body.data[0].readBy).toBeUndefined();
  });

  it.each(["?type=nope", "?source=nope", "?before=not-an-id"])("400s on %s", async (qs) => {
    const student = await createUser("student");
    expect((await get(student, qs)).status).toBe(400);
  });
});

describe("broadcasts skip admins", () => {
  it("lists only an admin's own targeted notifications and counts only those as unread", async () => {
    const admin = await createUser("admin");
    await Notification.create([
      { title: "Broadcast", message: "m", user: null },
      { title: "ToAdmin", message: "m", user: admin._id },
    ]);

    const res = await request(app).get("/api/notifications/me").set("Authorization", bearer(admin));

    expect(res.status).toBe(200);
    expect(res.body.data.map((n) => n.title)).toEqual(["ToAdmin"]);
    expect(res.body.unreadCount).toBe(1);
  });

  it("never records an admin as a broadcast reader", async () => {
    const admin = await createUser("admin");
    const b = await Notification.create({ title: "Broadcast", message: "m", user: null });
    const auth = { Authorization: bearer(admin) };

    const one = await request(app).patch(`/api/notifications/${b._id}/read`).set(auth);
    expect(one.status).toBe(403);

    const all = await request(app).patch("/api/notifications/read-all").set(auth);
    expect(all.status).toBe(200);

    expect((await Notification.findById(b._id)).readBy).toHaveLength(0);
  });

  it("still delivers broadcasts to students", async () => {
    const student = await createUser("student");
    await Notification.create({ title: "Broadcast", message: "m", user: null });
    const res = await request(app).get("/api/notifications/me").set("Authorization", bearer(student));
    expect(res.body.data.map((n) => n.title)).toEqual(["Broadcast"]);
  });
});
