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

describe("resolveConsumedAt: variants of the six phrasings", () => {
  it.each([
    ["Yesterday.", "2026-10-24T21:00:00-07:00"],
    ["for lunch yesterday", "2026-10-24T12:30:00-07:00"],
    ["yesterday at 8pm", "2026-10-24T20:00:00-07:00"],
    ["yesterday morning", "2026-10-24T08:00:00-07:00"],
    ["late last night", "2026-10-24T23:00:00-07:00"],
    ["last night around 11pm", "2026-10-24T23:00:00-07:00"],
    ["this morning at 7", "2026-10-25T07:00:00-07:00"],
    ["2 hours ago", "2026-10-25T19:00:00-07:00"],
    ["2 hrs ago", "2026-10-25T19:00:00-07:00"],
    ["2h ago", "2026-10-25T19:00:00-07:00"],
    ["a couple of hours ago", "2026-10-25T19:00:00-07:00"],
    ["an hour and a half ago", "2026-10-25T19:30:00-07:00"],
    ["two and a half hours ago", "2026-10-25T18:30:00-07:00"],
    ["30m ago", "2026-10-25T20:30:00-07:00"],
    ["tuesday", "2026-10-20T21:00:00-07:00"],
    ["on Tuesday", "2026-10-20T21:00:00-07:00"],
    ["last tues", "2026-10-20T21:00:00-07:00"],
    ["Tue", "2026-10-20T21:00:00-07:00"],
    ["last Tuesday for dinner", "2026-10-20T19:00:00-07:00"],
    ["last Tuesday at 8 PM", "2026-10-20T20:00:00-07:00"],
    ["at 8pm", "2026-10-25T20:00:00-07:00"],
    ["8 p.m.", "2026-10-25T20:00:00-07:00"],
    ["8 PM last night", "2026-10-24T20:00:00-07:00"],
    ["8 o’clock", "2026-10-25T20:00:00-07:00"],
  ])("%s", (phrase, expected) => {
    expect(resolve(phrase)).toBe(expected);
  });

  it("does not read weekday abbreviations into ordinary words", () => {
    expect(parseTimePhrase("sat down after the gym", SUNDAY_9PM, LA)).toBeNull();
    expect(parseTimePhrase("ate it in the sun", SUNDAY_9PM, LA)).toBeNull();
    expect(resolve("fri night")).toBe("2026-10-23T20:00:00-07:00");
  });
});

describe("resolveConsumedAt: ambiguous rules", () => {
  // Tuesday 2026-10-27 in Los Angeles.
  const TUESDAY_10AM = new Date("2026-10-27T10:00:00-07:00");

  it("'last <weekday>' on that weekday is a week ago; a bare weekday is today", () => {
    expect(resolve("last Tuesday", TUESDAY_10AM)).toBe("2026-10-20T10:00:00-07:00");
    expect(resolve("tuesday", TUESDAY_10AM)).toBe("2026-10-27T10:00:00-07:00");
    expect(resolve("tuesday for breakfast", TUESDAY_10AM)).toBe("2026-10-27T08:00:00-07:00");
  });

  it("a bare weekday that is today but a time still ahead means a week ago", () => {
    expect(resolve("tuesday at 8pm", TUESDAY_10AM)).toBe("2026-10-20T20:00:00-07:00");
  });

  it("'last <weekday>' the day after is yesterday", () => {
    expect(resolve("last Monday", TUESDAY_10AM)).toBe("2026-10-26T10:00:00-07:00");
  });

  it("a bare hour with no day is the most recent past one, AM or PM", () => {
    expect(resolve("around 8", SUNDAY_9PM)).toBe("2026-10-25T20:00:00-07:00");
    expect(resolve("around 8", SUNDAY_9AM)).toBe("2026-10-25T08:00:00-07:00");
    expect(resolve("at 10", SUNDAY_9PM)).toBe("2026-10-25T10:00:00-07:00"); // 10 PM hasn't happened
    expect(resolve("at 12", SUNDAY_9AM)).toBe("2026-10-25T00:00:00-07:00");
  });

  it("a bare hour on a named day: 1-6 is PM, 7-12 is AM", () => {
    expect(resolve("yesterday at 6")).toBe("2026-10-24T18:00:00-07:00");
    expect(resolve("yesterday at 7")).toBe("2026-10-24T07:00:00-07:00");
  });

  it("'last night' with a small hour is the early hours of today", () => {
    expect(resolve("last night at 1am")).toBe("2026-10-25T01:00:00-07:00");
    expect(resolve("last night at 1")).toBe("2026-10-25T01:00:00-07:00");
    expect(resolve("last night at midnight")).toBe("2026-10-25T00:00:00-07:00");
    expect(resolve("last night at 11")).toBe("2026-10-24T23:00:00-07:00");
  });
});

describe("resolveConsumedAt: just after local midnight", () => {
  // Tuesday 2026-10-27, 12:10 AM in Los Angeles.
  const AFTER_MIDNIGHT = new Date("2026-10-27T00:10:00-07:00");

  it("'yesterday' is still the calendar day before", () => {
    expect(resolve("yesterday", AFTER_MIDNIGHT)).toBe("2026-10-26T00:10:00-07:00");
    expect(resolve("yesterday for lunch", AFTER_MIDNIGHT)).toBe("2026-10-26T12:30:00-07:00");
  });

  it("'last night' is the evening that just ended", () => {
    expect(resolve("last night", AFTER_MIDNIGHT)).toBe("2026-10-26T20:00:00-07:00");
    expect(resolve("last night at 11pm", AFTER_MIDNIGHT)).toBe("2026-10-26T23:00:00-07:00");
  });

  it("'last night at 1am' before 1 AM is the night before", () => {
    expect(resolve("last night at 1am", AFTER_MIDNIGHT)).toBe("2026-10-26T01:00:00-07:00");
  });

  it("'tonight' and 'this morning' that haven't happened yet are the day that just ended", () => {
    expect(resolve("tonight", AFTER_MIDNIGHT)).toBe("2026-10-26T20:00:00-07:00");
    expect(resolve("this evening", AFTER_MIDNIGHT)).toBe("2026-10-26T19:00:00-07:00");
    expect(resolve("this morning", AFTER_MIDNIGHT)).toBe("2026-10-26T08:00:00-07:00");
  });

  it("'two hours ago' and 'at 8 PM' cross back into yesterday", () => {
    expect(resolve("two hours ago", AFTER_MIDNIGHT)).toBe("2026-10-26T22:10:00-07:00");
    expect(resolve("at 8 PM", AFTER_MIDNIGHT)).toBe("2026-10-26T20:00:00-07:00");
  });

  it("the night-owl rule stops at 4 AM", () => {
    const at5am = new Date("2026-10-27T05:00:00-07:00");
    expect(resolve("tonight", at5am)).toBe("2026-10-27T05:00:00-07:00");
  });
});

describe("resolveConsumedAt: 'at 8 PM' before 8 PM", () => {
  it("more than 2 hours before: yesterday at 8 PM", () => {
    expect(resolve("at 8 PM", new Date("2026-10-25T17:59:00-07:00"))).toBe("2026-10-24T20:00:00-07:00");
  });

  it("within 2 hours: early logging, so now", () => {
    expect(resolve("at 8 PM", new Date("2026-10-25T18:00:00-07:00"))).toBe("2026-10-25T18:00:00-07:00");
    expect(resolve("at 8 PM", new Date("2026-10-25T19:45:00-07:00"))).toBe("2026-10-25T19:45:00-07:00");
  });

  it("at exactly 8 PM: now", () => {
    expect(resolve("at 8 PM", new Date("2026-10-25T20:00:00-07:00"))).toBe("2026-10-25T20:00:00-07:00");
  });
});

describe("resolveConsumedAt: DST transitions", () => {
  // Los Angeles: spring forward Sunday 2026-03-08 at 2 AM (-08:00 → -07:00);
  // fall back Sunday 2026-11-01 at 2 AM (-07:00 → -08:00).
  const SPRING_DAY_10AM = new Date("2026-03-08T10:00:00-07:00");
  const FALL_DAY_10AM = new Date("2026-11-01T10:00:00-08:00");

  it("a day without a time keeps the local clock, not now minus 24 hours", () => {
    expect(resolve("yesterday", SPRING_DAY_10AM)).toBe("2026-03-07T10:00:00-08:00");
    expect(resolve("yesterday", FALL_DAY_10AM)).toBe("2026-10-31T10:00:00-07:00");
    expect(resolve("last Tuesday", FALL_DAY_10AM)).toBe("2026-10-27T10:00:00-07:00");
    expect(resolve("3 days ago", FALL_DAY_10AM)).toBe("2026-10-29T10:00:00-07:00");
  });

  it("'two hours ago' is elapsed time across the change", () => {
    // 3:30 AM PDT minus 2 h is 12:30 AM PST: only one wall-clock hour passed.
    expect(resolve("two hours ago", new Date("2026-03-08T03:30:00-07:00"))).toBe("2026-03-08T00:30:00-08:00");
    // 1:30 AM PST (the second 1:30) minus 2 h is 12:30 AM PDT.
    expect(resolve("two hours ago", new Date("2026-11-01T01:30:00-08:00"))).toBe("2026-11-01T00:30:00-07:00");
  });

  it("this morning on DST day uses that day's offset", () => {
    expect(resolve("this morning", SPRING_DAY_10AM)).toBe("2026-03-08T08:00:00-07:00");
    expect(resolve("this morning", FALL_DAY_10AM)).toBe("2026-11-01T08:00:00-08:00");
    expect(resolve("last night", FALL_DAY_10AM)).toBe("2026-10-31T20:00:00-07:00");
  });

  it("a time in the spring-forward gap moves forward", () => {
    expect(resolve("at 2:30am", SPRING_DAY_10AM)).toBe("2026-03-08T03:30:00-07:00");
  });

  it("a repeated time on fall-back day takes the first occurrence", () => {
    expect(resolve("at 1:30am", FALL_DAY_10AM)).toBe("2026-11-01T01:30:00-07:00");
  });

  it("works in other zones (London falls back 2026-10-25)", () => {
    const london = "Europe/London";
    const now = new Date("2026-10-25T09:00:00Z"); // 9 AM GMT
    expect(resolve("yesterday", now, london)).toBe("2026-10-24T09:00:00+01:00");
    expect(resolve("last night", now, london)).toBe("2026-10-24T20:00:00+01:00");
    expect(resolve("this morning", now, london)).toBe("2026-10-25T08:00:00Z");
  });
});

describe("resolveConsumedAt: never returns the future", () => {
  const phrases = [
    "yesterday", "last night", "this morning", "two hours ago", "2 hours ago", "last Tuesday", "at 8 PM",
    "tonight", "this evening", "today at 11pm", "for dinner", "at 11:59pm", "tuesday at 11pm", "around 11",
    "last night at 4am", "sunday", "monday", "saturday for lunch", "late last night", "for brunch",
  ];
  const nows = [
    new Date("2026-10-25T00:01:00-07:00"),
    new Date("2026-10-25T03:59:00-07:00"),
    new Date("2026-10-25T09:00:00-07:00"),
    new Date("2026-10-27T12:00:00-07:00"),
    new Date("2026-10-27T23:59:00-07:00"),
    new Date("2026-03-08T02:59:00-08:00"),
    new Date("2026-11-01T01:30:00-08:00"),
  ];

  it.each(nows.map((now) => [now.toISOString(), now] as const))("now = %s", (_, now) => {
    for (const phrase of phrases) {
      for (const timezone of [LA, "Asia/Tokyo", "Europe/London"]) {
        const resolved = parseTimePhrase(phrase, now, timezone);
        expect(resolved, `${phrase} in ${timezone}`).not.toBeNull();
        expect(resolved!.getTime(), `${phrase} in ${timezone}`).toBeLessThanOrEqual(now.getTime());
      }
    }
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

describe("parseTimePhrase: clockFrom (corrections keep the meal's own time)", () => {
  const lunch = new Date("2026-10-25T12:10:00-07:00");
  const at = (phrase: string, now: Date, clockFrom: Date) => parseTimePhrase(phrase, now, LA, { clockFrom })!.toISOString();

  it.each([
    ["yesterday", "2026-10-24T12:10:00-07:00"],
    ["2 days ago", "2026-10-23T12:10:00-07:00"],
    ["last Tuesday", "2026-10-20T12:10:00-07:00"],
    ["today", "2026-10-25T12:10:00-07:00"],
  ])("%s keeps 12:10", (phrase, expected) => {
    expect(at(phrase, SUNDAY_9PM, lunch)).toBe(new Date(expected).toISOString());
  });

  it("a named time still wins, and the kept time never lands in the future", () => {
    expect(at("lunch yesterday", SUNDAY_9PM, lunch)).toBe(new Date("2026-10-24T12:30:00-07:00").toISOString());
    expect(at("today", SUNDAY_9AM, new Date("2026-10-24T19:00:00-07:00"))).toBe(SUNDAY_9AM.toISOString());
  });
});
