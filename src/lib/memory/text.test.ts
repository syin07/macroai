import { describe, expect, it } from "vitest";
import { compareMemoryText, containsQuote, dice, keywords, normalizeMemoryText } from "./text";

describe("keywords", () => {
  it("lowercases, folds plurals and accents, drops stopwords and single characters", () => {
    expect([...keywords("I had my usual Shake and 2 Jalapeños, 26 g")].sort()).toEqual(
      ["26", "jalapeno", "shake", "usual"].sort(),
    );
  });

  it("keeps product sizes like 26g", () => {
    expect(keywords("Fairlife Core Power 26g").has("26g")).toBe(true);
  });
});

describe("normalizeMemoryText", () => {
  it("ignores case, punctuation, and plurals", () => {
    expect(normalizeMemoryText("Usual shake: Fairlife Core-Power 26g, 1 bottle!")).toBe(
      normalizeMemoryText("usual shakes fairlife core power 26g 1 bottles"),
    );
  });
});

describe("dice", () => {
  it("is 1 for equal sets and 0 for disjoint ones", () => {
    expect(dice(new Set(["a", "b"]), new Set(["a", "b"]))).toBe(1);
    expect(dice(new Set(["a"]), new Set(["b"]))).toBe(0);
  });
});

describe("compareMemoryText", () => {
  const shake = "Usual shake: Fairlife Core Power 26g, 1 bottle";

  it.each([
    ["exact repeat", shake],
    ["punctuation and case", "usual shake - fairlife core power 26G, 1 bottle"],
    ["light rewording", "Usual shake is Fairlife Core Power 26g, 1 bottle"],
  ])("same: %s", (_, text) => {
    expect(compareMemoryText(text, shake)).toBe("same");
  });

  it.each([
    ["new product size", "Usual shake: Fairlife Core Power 42g, 1 bottle"],
    ["new count", "Usual shake: Fairlife Core Power 26g, 2 bottles"],
  ])("revised: %s", (_, text) => {
    expect(compareMemoryText(text, shake)).toBe("revised");
  });

  it.each([
    ["another food", "Usual breakfast: 2 eggs and sourdough toast"],
    ["shares one word", "Usual shake: Premier Protein chocolate"],
    ["empty", ""],
  ])("different: %s", (_, text) => {
    expect(compareMemoryText(text, shake)).toBe("different");
  });
});

describe("containsQuote", () => {
  const message = "From now on, my usual shake is the Fairlife Core Power 26g.";

  it("finds the user's words regardless of case and punctuation", () => {
    expect(containsQuote(message, "my usual shake is the fairlife core power 26g")).toBe(true);
  });

  it("rejects words the user didn't say, partial words, and empty quotes", () => {
    expect(containsQuote(message, "my usual shake is Premier Protein")).toBe(false);
    expect(containsQuote(message, "ower 26g")).toBe(false);
    expect(containsQuote(message, "  ")).toBe(false);
  });
});
