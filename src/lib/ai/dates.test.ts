import { describe, expect, it } from "vitest";
import { parseTimePhrase, resolveConsumedAt } from "./dates";

const LA = "America/Los_Angeles";
// Sunday 2026-10-25, 9 PM in Los Angeles (PDT, -07:00).
const SUNDAY_9PM = new Date("2026-10-25T21:00:00-07:00");
const SUNDAY_9AM = new Date("2026-10-25T09:00:00-07:00");

function resolve(timePhrase: string | null, now = SUNDAY_9PM, timezone = LA, modelConsumedAt: string | null = null) {
  return resolveConsumedAt({ timePhrase, modelConsumedAt, now, timezone });
}

describe("resolveConsumedAt: PRD FR-09 phrases", () => {
  it.each([
    ["yesterday", "2026-10-24T21:00:00-07:00"],
    ["last night", "2026-10-24T20:00:00-07:00"],
    ["this morning", "2026-10-25T08:00:00-07:00"],
    ["two hours ago", "2026-10-25T19:00:00-07:00"],
    ["last Tuesday", "2026-10-20T21:00:00-07:00"],
    ["at 8 PM", "2026-10-25T20:00:00-07:00"],
  ])("%s", (phrase, expected) => {
    expect(resolve(phrase)).toBe(expected);
  });
});

describe("resolveConsumedAt: more phrasings", () => {
  it.each([
    ["just now", "2026-10-25T21:00:00-07:00"],
    ["half an hour ago", "2026-10-25T20:30:00-07:00"],
    ["45 min ago", "2026-10-25T20:15:00-07:00"],
    ["an hour ago", "2026-10-25T20:00:00-07:00"],
    ["3 days ago", "2026-10-22T21:00:00-07:00"],
    ["the day before yesterday", "2026-10-23T21:00:00-07:00"],
    ["yesterday at 7:30am", "2026-10-24T07:30:00-07:00"],
    ["yesterday for lunch", "2026-10-24T12:30:00-07:00"],
    ["last night at 11", "2026-10-24T23:00:00-07:00"],
    ["for breakfast", "2026-10-25T08:00:00-07:00"],
    ["at noon", "2026-10-25T12:00:00-07:00"],
    ["at 6", "2026-10-25T18:00:00-07:00"],
    ["at 20:15", "2026-10-25T20:15:00-07:00"],
    ["Friday dinner", "2026-10-23T19:00:00-07:00"],
    ["on sunday", "2026-10-25T21:00:00-07:00"],
    ["last sunday", "2026-10-18T21:00:00-07:00"],
  ])("%s", (phrase, expected) => {
    expect(resolve(phrase)).toBe(expected);
  });

  it("defaults to now when there is no phrase", () => {
    expect(resolve(null)).toBe("2026-10-25T21:00:00-07:00");
    expect(resolve("")).toBe("2026-10-25T21:00:00-07:00");
  });

  it("treats a bare number as a quantity, not a time", () => {
    expect(parseTimePhrase("2 eggs", SUNDAY_9PM, LA)).toBeNull();
    // ...but keeps looking for a real time later in the phrase.
    expect(resolve("2 of them at 7pm")).toBe("2026-10-25T19:00:00-07:00");
  });
});

describe("resolveConsumedAt: never in the future", () => {
  it("a clock time later today means yesterday", () => {
    expect(resolve("at 8 PM", SUNDAY_9AM)).toBe("2026-10-24T20:00:00-07:00");
    expect(resolve("for dinner", SUNDAY_9AM)).toBe("2026-10-24T19:00:00-07:00");
  });

  it("a meal a little ahead of now is early logging: use now", () => {
    expect(resolve("for lunch", new Date("2026-10-25T11:00:00-07:00"))).toBe("2026-10-25T11:00:00-07:00");
  });

  it("a later time on a day the user named is clamped to now", () => {
    expect(resolve("today at 8pm", SUNDAY_9AM)).toBe("2026-10-25T09:00:00-07:00");
    expect(resolve("this evening", SUNDAY_9AM)).toBe("2026-10-25T09:00:00-07:00");
  });
});

describe("resolveConsumedAt: time zones", () => {
  // Monday 2026-11-02, 10 AM PST (-08:00); DST ended Sunday 2026-11-01.
  const AFTER_DST = new Date("2026-11-02T10:00:00-08:00");

  it("uses the offset in effect on the resolved day", () => {
    expect(resolve("yesterday at 8pm", AFTER_DST)).toBe("2026-11-01T20:00:00-08:00");
    expect(resolve("last saturday at 8pm", AFTER_DST)).toBe("2026-10-31T20:00:00-07:00");
  });

  it("resolves days in the user's zone, not UTC", () => {
    // 05:00 UTC Monday is still Sunday evening in Los Angeles, but Monday afternoon in Tokyo.
    const now = new Date("2026-10-26T05:00:00Z");
    expect(resolve("yesterday at 8pm", now, LA)).toBe("2026-10-24T20:00:00-07:00");
    expect(resolve("yesterday at 8pm", now, "Asia/Tokyo")).toBe("2026-10-25T20:00:00+09:00");
  });
});

describe("resolveConsumedAt: the model's ISO timestamp as fallback", () => {
  it("is used, in the user's offset, when the phrase isn't one we parse", () => {
    expect(resolve("on October 3rd", SUNDAY_9PM, LA, "2026-10-03T19:00:00Z")).toBe("2026-10-03T12:00:00-07:00");
    expect(resolve(null, SUNDAY_9PM, LA, "2026-10-25T13:00:00-07:00")).toBe("2026-10-25T13:00:00-07:00");
  });

  it("loses to a phrase we do parse", () => {
    expect(resolve("last night", SUNDAY_9PM, LA, "2026-10-25T13:00:00-07:00")).toBe("2026-10-24T20:00:00-07:00");
  });

  it("is ignored when invalid, far in the future, or implausibly old", () => {
    expect(resolve(null, SUNDAY_9PM, LA, "yesterday")).toBe("2026-10-25T21:00:00-07:00");
    expect(resolve(null, SUNDAY_9PM, LA, "2026-10-25T21:00:00")).toBe("2026-10-25T21:00:00-07:00"); // no offset
    expect(resolve(null, SUNDAY_9PM, LA, "2026-10-26T09:00:00-07:00")).toBe("2026-10-25T21:00:00-07:00");
    expect(resolve(null, SUNDAY_9PM, LA, "2026-08-01T12:00:00-07:00")).toBe("2026-10-25T21:00:00-07:00");
  });

  it("a slightly-future model time is clamped to now", () => {
    expect(resolve(null, SUNDAY_9PM, LA, "2026-10-25T22:00:00-07:00")).toBe("2026-10-25T21:00:00-07:00");
  });
});
