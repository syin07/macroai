import { describe, expect, it } from "vitest";
import { photoExtractionText } from "./photo";

describe("photoExtractionText", () => {
  it("uses the model's description when the photo has no caption", () => {
    expect(photoExtractionText(undefined, "the meal in the photo")).toBe("the meal in the photo");
    expect(photoExtractionText("  ", undefined)).toBeUndefined();
  });

  it("uses the caption alone when the description adds nothing", () => {
    expect(photoExtractionText("Fried, with ranch", "fried,   with ranch")).toBe("Fried, with ranch");
    expect(photoExtractionText("fried chicken with ranch", "fried chicken")).toBe("fried chicken with ranch");
    expect(photoExtractionText("lunch", undefined)).toBe("lunch");
  });

  it("uses the description alone when it already quotes the caption", () => {
    expect(photoExtractionText("with ranch", "chicken tenders with ranch")).toBe("chicken tenders with ranch");
  });

  it("keeps the user's caption word for word when the model paraphrased it", () => {
    expect(photoExtractionText("fried, with ranch", "chicken tenders and a dip")).toBe("fried, with ranch\nchicken tenders and a dip");
  });
});
