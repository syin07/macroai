import { describe, expect, it } from "vitest";
import { addDays, localDate, localDayBounds } from "./local-day";
import { decodeCursor, encodeCursor, isVisible } from "./meals";

describe("local day helpers", () => {
  it("finds the local date of an instant", () => {
    expect(localDate("2026-10-27T05:00:00Z", "America/Los_Angeles")).toBe("2026-10-26");
    expect(localDate("2026-10-27T05:00:00Z", "Asia/Tokyo")).toBe("2026-10-27");
  });

  it("adds days across month and year ends", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("gives DST-aware day bounds", () => {
    // US DST ends 2026-11-01: that day is 25 hours long in Los Angeles.
    expect(localDayBounds("2026-11-01", "America/Los_Angeles")).toEqual({
      start: "2026-11-01T07:00:00.000Z",
      end: "2026-11-02T08:00:00.000Z",
    });
    // And starts 2026-03-08: 23 hours.
    const { start, end } = localDayBounds("2026-03-08", "America/Los_Angeles");
    expect(Date.parse(end) - Date.parse(start)).toBe(23 * 3600 * 1000);
  });
});

describe("meal cursor and visibility", () => {
  it("round-trips a cursor, keeping microsecond precision", () => {
    const row = { consumed_at: "2026-10-26T19:30:00.123456+00:00", id: "a0000000-0000-4000-8000-000000000001" };
    expect(decodeCursor(encodeCursor(row))).toEqual({ consumedAt: row.consumed_at, id: row.id });
  });

  it("hides pending deletions once the undo window has passed", () => {
    const deletedAt = "2026-10-26T19:00:00.000Z";
    const now = Date.parse(deletedAt);
    expect(isVisible({ status: "active", deleted_at: null }, now)).toBe(true);
    expect(isVisible({ status: "pending_deletion", deleted_at: deletedAt }, now + 9_999)).toBe(true);
    expect(isVisible({ status: "pending_deletion", deleted_at: deletedAt }, now + 10_000)).toBe(false);
  });
});
