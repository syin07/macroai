import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import type { Memory } from "@/types/api";
import { createAppDb } from "@/lib/database/__fixtures__/memory-supabase";
import { memoryLoader, rankMemories, retrieveMemories, MAX_RELEVANT_MEMORIES } from "./retrieve";

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

let seq = 0;
function memory(content: string, fields: Partial<Memory> = {}): Memory {
  seq++;
  const at = `2026-10-${String(10 + (seq % 15)).padStart(2, "0")}T08:00:00+00:00`;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    category: "frequent_food",
    content,
    created_at: at,
    updated_at: at,
    ...fields,
  };
}

describe("rankMemories", () => {
  it("orders by shared keywords, then most recently updated", () => {
    const shake = memory("Usual shake: Fairlife Core Power 26g, 1 bottle", { updated_at: "2026-10-01T00:00:00Z" });
    const powerBar = memory("Snack: Power Crunch bar", { updated_at: "2026-10-20T00:00:00Z" });
    const oldPower = memory("Pre-workout: Power gel", { updated_at: "2026-09-01T00:00:00Z" });
    const eggs = memory("Usual breakfast: 2 eggs", { updated_at: "2026-10-10T00:00:00Z" });

    const ranked = rankMemories([eggs, oldPower, powerBar, shake], "log my usual fairlife power shake");
    expect(ranked.map((m) => m.content)).toEqual([
      shake.content,      // usual, shake, fairlife, power
      powerBar.content,   // one keyword (power), updated Oct 20
      eggs.content,       // one keyword (usual), updated Oct 10
      oldPower.content,   // one keyword (power), updated Sep 1
    ]);
  });

  it("leaves out memories that share no keyword with the message, and stopwords don't count", () => {
    const eggs = memory("Usual breakfast: 2 eggs");
    expect(rankMemories([eggs], "what is in my lunch")).toEqual([]);
  });

  it(`keeps the top ${MAX_RELEVANT_MEMORIES} by overlap`, () => {
    const many = Array.from({ length: 12 }, (_, i) => memory(`Rice dish ${i}${i < 3 ? " chicken" : ""}`));
    const ranked = rankMemories(many, "chicken and rice");
    expect(ranked).toHaveLength(MAX_RELEVANT_MEMORIES);
    expect(ranked.slice(0, 3).every((m) => m.content.includes("chicken"))).toBe(true);
  });

  it("always includes every response_style memory, on top of the 8, even with no overlap", () => {
    const styles = [
      memory("Keep replies short", { category: "response_style", created_at: "2026-10-02T00:00:00Z" }),
      memory("No emojis", { category: "response_style", created_at: "2026-10-01T00:00:00Z" }),
    ];
    const rice = Array.from({ length: 10 }, (_, i) => memory(`Rice ${i}`));
    const ranked = rankMemories([...rice, ...styles], "rice");
    expect(ranked).toHaveLength(MAX_RELEVANT_MEMORIES + 2);
    expect(ranked.slice(0, 2).map((m) => m.content)).toEqual(["No emojis", "Keep replies short"]);
    expect(rankMemories(styles, "")).toHaveLength(2);
  });
});

describe("retrieveMemories", () => {
  const at = "2026-10-20T08:00:00+00:00";
  const row = (id: string, user_id: string, content: string, extra: Record<string, unknown> = {}) => ({
    id,
    user_id,
    category: "frequent_food",
    content,
    source_message_id: null,
    created_at: at,
    updated_at: at,
    deleted_at: null,
    ...extra,
  });

  function setup() {
    const db = createAppDb({
      user_memories: [
        row("a1", ME, "Usual shake: Fairlife Core Power 26g, 1 bottle"),
        row("a2", ME, "Usual shake: Premier Protein vanilla", { deleted_at: "2026-10-21T00:00:00Z" }),
        row("a3", ME, "Keep replies short", { category: "response_style" }),
        row("b1", OTHER, "Usual shake: Huel black, 1 bottle"),
        row("b2", OTHER, "Answer in French", { category: "response_style" }),
      ],
    });
    return { db, client: db as unknown as SupabaseClient };
  }

  it("returns only the user's own live memories, as Memory objects", async () => {
    const { client } = setup();
    const found = await retrieveMemories(client, ME, "my usual shake");
    expect(found).toEqual([
      { id: "a3", category: "response_style", content: "Keep replies short", created_at: at, updated_at: at },
      { id: "a1", category: "frequent_food", content: "Usual shake: Fairlife Core Power 26g, 1 bottle", created_at: at, updated_at: at },
    ]);
  });

  it("filters by user_id and deleted_at in the query itself (a second guard under RLS)", async () => {
    const { db, client } = setup();
    await retrieveMemories(client, ME, "shake");
    const builder = db.from.mock.results[0]!.value;
    expect(builder.eq).toHaveBeenCalledWith("user_id", ME);
    expect(builder.is).toHaveBeenCalledWith("deleted_at", null);
  });

  it("memoryLoader hands analyzeMeal the retrieved text, and style memories for a captionless photo", async () => {
    const { client } = setup();
    const load = memoryLoader(client);
    expect(await load(ME, "usual shake")).toEqual(["Keep replies short", "Usual shake: Fairlife Core Power 26g, 1 bottle"]);
    expect(await load(ME, undefined)).toEqual(["Keep replies short"]);
    expect(await load(OTHER, "usual shake")).toEqual(["Answer in French", "Usual shake: Huel black, 1 bottle"]);
  });
});
