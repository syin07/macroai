import { describe, expect, it } from "vitest";
import type { Macros } from "@/types/api";
import { aggregateDays, daysInRange } from "./aggregate";
import { round1Macros } from "./calc";

const m = (calories: number, protein_g: number, carbs_g: number, fat_g: number): Macros => ({ calories, protein_g, carbs_g, fat_g });

describe("daysInRange", () => {
  it("counts both ends", () => {
    expect(daysInRange("2026-10-26", "2026-10-26")).toBe(1);
    expect(daysInRange("2026-10-19", "2026-10-25")).toBe(7);
  });

  it("crosses month, leap-day and year ends", () => {
    expect(daysInRange("2026-10-30", "2026-11-02")).toBe(4);
    expect(daysInRange("2028-02-28", "2028-03-01")).toBe(3); // 2028 is a leap year
    expect(daysInRange("2026-12-31", "2027-01-01")).toBe(2);
  });

  it("is unaffected by DST changes (calendar days, not hours)", () => {
    expect(daysInRange("2026-10-31", "2026-11-02")).toBe(3);
  });

  it("rejects reversed ranges and invalid dates", () => {
    expect(() => daysInRange("2026-10-27", "2026-10-26")).toThrow(RangeError);
    expect(() => daysInRange("2026-02-30", "2026-03-01")).toThrow(RangeError);
    expect(() => daysInRange("2026-10-1", "2026-10-02")).toThrow(RangeError);
    expect(() => daysInRange("2026-10-01T00:00:00Z", "2026-10-02")).toThrow(RangeError);
  });
});

describe("aggregateDays", () => {
  it("an empty range has no average (missing days are not zero)", () => {
    const result = aggregateDays([], { from: "2026-10-20", to: "2026-10-22" });
    expect(result).toEqual({
      from: "2026-10-20",
      to: "2026-10-22",
      days_in_range: 3,
      days_with_records: 0,
      missing_dates: ["2026-10-20", "2026-10-21", "2026-10-22"],
      sum: m(0, 0, 0, 0),
      average_per_recorded_day: null,
    });
  });

  it("one recorded day: the average equals that day", () => {
    const result = aggregateDays([{ date: "2026-10-26", totals: m(1850, 120.5, 200, 60) }], {
      from: "2026-10-26",
      to: "2026-10-26",
    });
    expect(result.days_in_range).toBe(1);
    expect(result.days_with_records).toBe(1);
    expect(result.missing_dates).toEqual([]);
    expect(result.sum).toEqual(m(1850, 120.5, 200, 60));
    expect(result.average_per_recorded_day).toEqual(m(1850, 120.5, 200, 60));
  });

  it("gaps: divides by recorded days only and lists the missing ones", () => {
    const days = [
      { date: "2026-10-19", totals: m(2000, 150, 200, 70) },
      { date: "2026-10-21", totals: m(1600, 110, 180, 50) },
      { date: "2026-10-25", totals: m(2300, 130, 260, 80) },
    ];
    const result = aggregateDays(days, { from: "2026-10-19", to: "2026-10-25" });
    expect(result.days_in_range).toBe(7);
    expect(result.days_with_records).toBe(3);
    expect(result.missing_dates).toEqual(["2026-10-20", "2026-10-22", "2026-10-23", "2026-10-24"]);
    expect(result.sum).toEqual(m(5900, 390, 640, 200));
    // 5900 / 3, not 5900 / 7.
    expect(result.average_per_recorded_day!.calories).toBeCloseTo(1966.6667, 4);
    expect(result.average_per_recorded_day!.protein_g).toBe(130);
    expect(round1Macros(result.average_per_recorded_day!)).toEqual(m(1966.7, 130, 213.3, 66.7));
  });

  it("crosses a month end", () => {
    const days = [
      { date: "2026-10-30", totals: m(1800, 100, 200, 60) },
      { date: "2026-10-31", totals: m(2200, 140, 220, 80) },
      { date: "2026-11-02", totals: m(2000, 120, 210, 70) },
    ];
    const result = aggregateDays(days, { from: "2026-10-30", to: "2026-11-02" });
    expect(result.days_in_range).toBe(4);
    expect(result.days_with_records).toBe(3);
    expect(result.missing_dates).toEqual(["2026-11-01"]);
    expect(result.sum).toEqual(m(6000, 360, 630, 210));
    expect(result.average_per_recorded_day).toEqual(m(2000, 120, 210, 70));
  });

  it("crosses a year end", () => {
    const result = aggregateDays(
      [
        { date: "2026-12-31", totals: m(2500, 100, 300, 90) },
        { date: "2027-01-01", totals: m(1500, 80, 150, 50) },
      ],
      { from: "2026-12-30", to: "2027-01-01" },
    );
    expect(result.days_in_range).toBe(3);
    expect(result.missing_dates).toEqual(["2026-12-30"]);
    expect(result.average_per_recorded_day).toEqual(m(2000, 90, 225, 70));
  });

  it("ignores days outside the range", () => {
    const result = aggregateDays(
      [
        { date: "2026-10-18", totals: m(9999, 999, 999, 999) },
        { date: "2026-10-19", totals: m(2000, 100, 200, 60) },
        { date: "2026-10-26", totals: m(9999, 999, 999, 999) },
      ],
      { from: "2026-10-19", to: "2026-10-25" },
    );
    expect(result.days_with_records).toBe(1);
    expect(result.sum).toEqual(m(2000, 100, 200, 60));
  });

  it("counts a recorded day with zero calories as recorded (e.g. only black coffee)", () => {
    const result = aggregateDays(
      [
        { date: "2026-10-20", totals: m(0, 0, 0, 0) },
        { date: "2026-10-21", totals: m(2000, 100, 200, 60) },
      ],
      { from: "2026-10-20", to: "2026-10-21" },
    );
    expect(result.days_with_records).toBe(2);
    expect(result.average_per_recorded_day).toEqual(m(1000, 50, 100, 30));
  });

  it("keeps values unrounded", () => {
    const result = aggregateDays(
      [
        { date: "2026-10-20", totals: m(100.333, 10.111, 0.005, 1.0004) },
        { date: "2026-10-21", totals: m(200.333, 20.111, 0.005, 2.0004) },
      ],
      { from: "2026-10-20", to: "2026-10-21" },
    );
    expect(result.sum.calories).toBeCloseTo(300.666, 9);
    expect(result.sum.carbs_g).toBeCloseTo(0.01, 9);
    expect(result.average_per_recorded_day!.fat_g).toBeCloseTo(1.5004, 9);
  });

  it("does not mutate its input", () => {
    const days = Object.freeze([Object.freeze({ date: "2026-10-20", totals: Object.freeze(m(1, 2, 3, 4)) })]);
    expect(() => aggregateDays(days, { from: "2026-10-20", to: "2026-10-20" })).not.toThrow();
  });

  it("rejects duplicate days, invalid dates and reversed ranges", () => {
    const day = { date: "2026-10-20", totals: m(1, 1, 1, 1) };
    expect(() => aggregateDays([day, day], { from: "2026-10-20", to: "2026-10-21" })).toThrow(/Duplicate/);
    expect(() => aggregateDays([{ ...day, date: "2026-13-01" }], { from: "2026-10-20", to: "2026-10-21" })).toThrow(RangeError);
    expect(() => aggregateDays([], { from: "2026-10-22", to: "2026-10-21" })).toThrow(RangeError);
  });
});
