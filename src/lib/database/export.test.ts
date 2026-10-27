import { describe, expect, it } from "vitest";
import { memoriesResponseSchema, mealSchema } from "@/lib/validation";
import { createFakeQueryClient } from "./__fixtures__/fake-query";
import { exportTables, USER_A, USER_B } from "./__fixtures__/export-rows";
import { loadExport, loadExportMeals } from "./export";

const NOW = new Date("2026-10-26T21:00:00Z");
const user = { id: USER_A, email: "sandy@example.com" };

describe("loadExport", () => {
  it("nutrition scope: the user's active meals, nested items in order, nothing else", async () => {
    const { client } = createFakeQueryClient(exportTables());
    const data = await loadExport(client, user, "nutrition", NOW);

    expect(Object.keys(data).sort()).toEqual(["exported_at", "format_version", "meals", "scope", "timezone"]);
    expect(data).toMatchObject({
      format_version: 1,
      scope: "nutrition",
      exported_at: "2026-10-26T21:00:00.000Z",
      timezone: "America/Los_Angeles",
    });
    expect(data.meals.map((m) => m.name)).toEqual(["Breakfast", "@SUM(1+1)"]);
    for (const meal of data.meals) mealSchema.parse(meal);

    const [breakfast] = data.meals;
    expect(breakfast!.items.map((i) => i.food_name)).toEqual(["Banana", '=HYPERLINK("http://evil.example","x")']);
    expect(breakfast!.items[0]).toEqual({
      id: "a1000000-0000-4000-8000-000000000001",
      food_name: "Banana",
      quantity: 1,
      unit: "piece",
      grams: 118,
      basis_per_100g: { calories: 89, protein_g: 1.09, carbs_g: 22.84, fat_g: 0.33 },
      macros: { calories: 105.02, protein_g: 1.286, carbs_g: 26.951, fat_g: 0.389 },
      nutrition_source: "usda",
      source_reference: "173944",
      inferred: false,
      confidence: null,
      edited_by_user: false,
      assumptions: null,
    });
    expect(breakfast!.totals).toEqual({ calories: 210.04, protein_g: 2.572, carbs_g: 53.902, fat_g: 0.778 });
  });

  it("account scope adds messages, memories, goals and preferences", async () => {
    const { client } = createFakeQueryClient(exportTables());
    const data = await loadExport(client, user, "account", NOW);
    if (data.scope !== "account") throw new Error("expected account scope");

    expect(Object.keys(data).sort()).toEqual(
      ["account", "exported_at", "format_version", "meals", "memories", "messages", "scope", "timezone"].sort(),
    );
    expect(data.meals).toHaveLength(2);
    expect(data.account).toEqual({
      user_id: USER_A,
      email: "sandy@example.com",
      display_name: "Sandy",
      preferences: { theme: "dark", save_mode: "confirm", timezone: "America/Los_Angeles", assistant_style: "casual" },
      goals: [{ calories: 2000, protein_g: 150, carbs_g: 200, fat_g: 60, effective_from: "2026-01-01", effective_to: null }],
    });

    // Tool rows and deleted messages are left out.
    expect(data.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "a banana"],
      ["assistant", "Logged a banana."],
    ]);
    expect(data.messages[1]).toEqual({
      id: "a2000000-0000-4000-8000-000000000003",
      conversation_id: "a3000000-0000-4000-8000-000000000001",
      client_message_id: null,
      role: "assistant",
      text: "Logged a banana.",
      cards: [{ kind: "meal", meal_id: "a0000000-0000-4000-8000-000000000001", meal: null }],
      had_image: false,
      status: "sent",
      related_meal_id: "a0000000-0000-4000-8000-000000000001",
      created_at: "2026-10-26T05:30:02+00:00",
    });

    // Deleted memories are left out; the rest match the Memory contract exactly.
    memoriesResponseSchema.strict().parse({ memories: data.memories });
    expect(data.memories.map((m) => m.content)).toEqual(["banana most mornings"]);
    expect(Object.keys(data.memories[0]!).sort()).toEqual(["category", "content", "created_at", "id", "updated_at"]);
  });

  it("never includes another user's rows, and filters every query by the session user", async () => {
    const { client, calls } = createFakeQueryClient(exportTables());
    const json = JSON.stringify(await loadExport(client, user, "account", NOW));
    for (const leak of [USER_B, "Ken", "Egg", "two eggs", "eggs are large", "2500"]) expect(json).not.toContain(leak);

    const tables = new Set(calls.map((c) => c.table));
    for (const table of tables) {
      const column = table === "profiles" ? "id" : "user_id";
      expect(calls, table).toContainEqual({ table, op: "eq", args: [column, USER_A] });
    }
    expect(calls).toContainEqual({ table: "meals", op: "eq", args: ["status", "active"] });
  });

  it("falls back to UTC and null preferences when the profile rows are missing", async () => {
    const { client } = createFakeQueryClient({ ...exportTables(), profiles: [], account_preferences: [] });
    const data = await loadExport(client, user, "account", NOW);
    if (data.scope !== "account") throw new Error("expected account scope");
    expect(data.timezone).toBe("UTC");
    expect(data.account.preferences).toBeNull();
    expect(data.account.display_name).toBeNull();
  });

  it("throws (without the rows) when a query fails", async () => {
    const { client } = createFakeQueryClient(exportTables(), { failOn: "messages" });
    await expect(loadExport(client, user, "account", NOW)).rejects.toThrow("messages select failed: boom");
  });
});

describe("loadExportMeals", () => {
  it("pages past PostgREST's row limit", async () => {
    const tables = exportTables();
    const template = tables.meals[1]!;
    const meals = Array.from({ length: 1203 }, (_, i) => ({
      ...template,
      id: `a0000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    }));
    const { client, calls } = createFakeQueryClient({ meals });
    expect(await loadExportMeals(client, USER_A)).toHaveLength(1203);
    expect(calls.filter((c) => c.op === "range").map((c) => c.args)).toEqual([
      [0, 499],
      [500, 999],
      [1000, 1499],
    ]);
  });
});
