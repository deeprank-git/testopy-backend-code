import { resolveSource, EXAM_ALERTS_PATH } from "../utils/notificationSource.js";

describe("resolveSource", () => {
  it("uses the stored source when present", () => {
    expect(resolveSource({ source: "manual", link: EXAM_ALERTS_PATH })).toBe("manual");
    expect(resolveSource({ source: "exam_alert", link: "" })).toBe("exam_alert");
  });

  it("falls back to the link for rows sent before source existed", () => {
    expect(resolveSource({ link: EXAM_ALERTS_PATH })).toBe("exam_alert");
    expect(resolveSource({ link: "/exams" })).toBe("manual");
    expect(resolveSource({})).toBe("manual");
  });
});
