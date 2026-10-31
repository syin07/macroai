import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

describe("PWA manifest", () => {
  it("opens the Today page and provides installable icons", () => {
    const app = manifest();
    expect(app.start_url).toBe("/today");
    expect(app.display).toBe("standalone");
    expect(app.icons?.map((icon) => icon.sizes)).toEqual([
      "192x192",
      "512x512",
      "512x512",
    ]);
    for (const icon of app.icons ?? []) {
      expect(existsSync(resolve("public", `.${icon.src}`))).toBe(true);
    }
  });
});

describe("backend test runtime", () => {
  it("supports Zod 4 and Node web APIs used by Sandy's contracts", async () => {
    const schema = z.object({ id: z.uuid(), at: z.iso.datetime() });
    const data = schema.parse({
      id: "550e8400-e29b-41d4-a716-446655440000",
      at: "2026-10-26T12:00:00Z",
    });
    const response = Response.json(data);
    expect(await response.json()).toEqual(data);
    expect(await new Blob(["meal"]).text()).toBe("meal");
    expect(typeof window).toBe("undefined");
  });
});
