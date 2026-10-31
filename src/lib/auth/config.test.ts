import { describe, expect, it } from "vitest";
import { isApiPath, isCronPath, isPublicPage, safeNextPath } from "./config";

describe("safeNextPath", () => {
  it.each([
    ["/history", "/history"],
    ["/reset-password?mode=update", "/reset-password?mode=update"],
    ["/settings#goals", "/settings#goals"],
  ])("keeps same-origin path %s", (next, expected) => {
    expect(safeNextPath(next)).toBe(expected);
  });

  it.each([
    null,
    "",
    "history",
    "https://evil.example/chat",
    "//evil.example/chat",
    "/\\evil.example",
    "/\t/evil.example",
    "javascript:alert(1)",
  ])("falls back to /today for %j", (next) => {
    expect(safeNextPath(next)).toBe("/today");
  });
});

describe("route classes", () => {
  it("treats auth pages and the callback as public, and nothing else", () => {
    for (const path of ["/sign-in", "/sign-up", "/reset-password", "/not-approved", "/auth/callback"]) {
      expect(isPublicPage(path)).toBe(true);
    }
    for (const path of ["/", "/chat", "/settings", "/dev/api", "/sign-in-later", "/authx"]) {
      expect(isPublicPage(path)).toBe(false);
    }
  });

  it("recognizes API paths", () => {
    expect(isApiPath("/api/me")).toBe(true);
    expect(isApiPath("/api")).toBe(true);
    expect(isApiPath("/apiary")).toBe(false);
    expect(isCronPath("/api/cron/purge")).toBe(true);
    expect(isCronPath("/api/cronjob")).toBe(false);
    expect(isCronPath("/api/meals")).toBe(false);
  });
});
