// Live smoke check for the chat route: real model (paid), real USDA, real route handler, local Supabase.
// Opt-in, because it costs money (about a cent with Haiku) and needs `supabase start`:
//
//   LIVE_SMOKE=1 npx vitest run tests/live/chat-smoke.test.ts
//
// Keys: ANTHROPIC_API_KEY and USDA_API_KEY from .env.local; Supabase keys from `supabase status -o env`.
// It refuses to run against anything but a local stack. It creates one throwaway approved user in
// auto-save mode, sends three turns (text meal, a preference, a photo), lets B13's memory second pass
// run, prints what happened, and deletes the user (cascade) and the approved_emails row.
//
// Covers the B8 "done when" ("2 eggs and toast" saved, totals returned), the B13 memory smoke test,
// and the B9 photo path at the API level. A phone photo through the real UI is still a manual check.

import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createServerClient } from "@supabase/ssr";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ChatResponse } from "@/types/api";

const ENABLED = process.env.LIVE_SMOKE === "1";
const PHOTO = process.env.LIVE_SMOKE_PHOTO; // path to a jpeg/webp food photo; the photo turn is skipped without it
const OUT = process.env.LIVE_SMOKE_OUT; // optional file; every [live-smoke] line is appended there too

function log(line: string) {
  console.log(`[live-smoke] ${line}`);
  if (OUT) appendFileSync(OUT, `${line}\n`);
}

// Keys first, local Supabase second (overrides the hosted URL in .env.local), route import last.
for (const file of [".env.local", ".env"]) if (existsSync(file)) process.loadEnvFile(file);

function localEnv(): { url: string; anonKey: string; serviceKey: string } {
  const status = execSync("supabase status -o env", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const value = (name: string) => status.match(new RegExp(`^${name}="?([^"\\n]*)"?$`, "m"))?.[1];
  const url = value("API_URL");
  const anonKey = value("ANON_KEY");
  const serviceKey = value("SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceKey) throw new Error("Local Supabase keys not found: run `supabase start`.");
  if (!["127.0.0.1", "localhost"].includes(new URL(url).hostname)) {
    throw new Error(`Refusing to run against ${url}: the live smoke test only runs against a local stack.`);
  }
  return { url, anonKey, serviceKey };
}

const cookies = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [...cookies].map(([name, value]) => ({ name, value })),
    get: (name: string) => (cookies.has(name) ? { name, value: cookies.get(name)! } : undefined),
    set: (name: string, value: string) => (value ? cookies.set(name, value) : cookies.delete(name)),
  }),
}));
// Run the after-response work (the memory second pass) and let the test wait for it.
const pending: Promise<unknown>[] = [];
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  after: (task: () => unknown) => {
    pending.push(Promise.resolve().then(task));
  },
}));
async function settle() {
  while (pending.length) await pending.splice(0).reduce((p, q) => p.then(() => q), Promise.resolve());
}

describe.skipIf(!ENABLED)("live chat smoke (LIVE_SMOKE=1)", () => {
  let admin: SupabaseClient;
  let userId: string;
  let chat: typeof import("@/app/api/ai/chat/route");
  const email = `live-smoke-${randomUUID().slice(0, 8)}@smoke.test`;
  const password = `live-${randomUUID()}`;

  beforeAll(async () => {
    const env = localEnv();
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", env.url);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", env.anonKey);
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", env.serviceKey);
    if (!process.env.AI_PROVIDER) vi.stubEnv("AI_PROVIDER", "anthropic");
    if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY missing");
    if (!process.env.USDA_API_KEY) throw new Error("USDA_API_KEY missing");
    admin = createClient(env.url, env.serviceKey, { auth: { persistSession: false } });

    const approve = await admin.from("approved_emails").insert({ email });
    if (approve.error) throw new Error(approve.error.message);
    const made = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (made.error || !made.data.user) throw new Error(made.error?.message);
    userId = made.data.user.id;
    const client = createServerClient(env.url, env.anonKey, {
      cookies: {
        getAll: () => [...cookies].map(([name, value]) => ({ name, value })),
        setAll: (list) => list.forEach(({ name, value }) => (value ? cookies.set(name, value) : cookies.delete(name))),
      },
    });
    const signIn = await client.auth.signInWithPassword({ email, password });
    if (signIn.error) throw new Error(signIn.error.message);
    await new Promise((r) => setTimeout(r, 50));
    const prefs = await admin.from("account_preferences").upsert({ user_id: userId, save_mode: "auto" });
    if (prefs.error) throw new Error(prefs.error.message);

    chat = await import("@/app/api/ai/chat/route");
  }, 60_000);

  afterAll(async () => {
    await settle();
    const usage = await admin.from("ai_usage").select("endpoint, model, input_tokens, output_tokens, estimated_cost_usd").eq("user_id", userId);
    const rows = usage.data ?? [];
    const cost = rows.reduce((sum, r) => sum + Number(r.estimated_cost_usd), 0);
    log(`model calls: ${rows.length}, estimated spend: $${cost.toFixed(5)}`);
    for (const r of rows) log(`  ${r.endpoint} ${r.model} in=${r.input_tokens} out=${r.output_tokens} $${Number(r.estimated_cost_usd).toFixed(6)}`);
    if (userId) await admin.auth.admin.deleteUser(userId);
    await admin.from("approved_emails").delete().eq("email", email);
    vi.unstubAllEnvs();
  }, 60_000);

  async function send(form: { text?: string; image?: Blob }): Promise<ChatResponse> {
    const body = new FormData();
    body.set("client_message_id", randomUUID());
    body.set("timezone", "America/Los_Angeles");
    if (form.text !== undefined) body.set("text", form.text);
    if (form.image) body.set("image", form.image, "meal.jpg");
    const res = await chat.POST(new Request("http://localhost/api/ai/chat", { method: "POST", body }));
    const json = (await res.json()) as ChatResponse & { error?: unknown };
    if (res.status !== 200) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
    return json;
  }

  it("logs '2 eggs and toast' end to end and returns the day's totals", async () => {
    const r = await send({ text: "2 eggs and toast" });
    log(`reply: ${r.assistant_message.text}`);
    log(`cards: ${JSON.stringify(r.assistant_message.cards?.map((c) => ({ kind: c.kind, name: (c as { meal?: { name?: string } }).meal?.name })))}`);
    log(`daily_summary: ${JSON.stringify(r.daily_summary)}`);
    expect(r.assistant_message.text.length).toBeGreaterThan(0);
    await settle();
    // Auto mode only saves when FR-03 doesn't ask. If it asked, answer once; the save must follow.
    let final = r;
    const first = r.assistant_message.cards[0];
    if (first?.kind === "proposal") {
      log(`FR-03 asked: needs_clarification=${first.proposal.needs_clarification} q=${JSON.stringify(first.proposal.clarification_question)}`);
      final = await send({ text: "Two large fried eggs and one regular slice of white toast with a little butter. Save it." });
      log(`follow-up reply: ${final.assistant_message.text}`);
      log(`follow-up cards: ${JSON.stringify(final.assistant_message.cards.map((c) => c.kind))}`);
      log(`follow-up daily_summary: ${JSON.stringify(final.daily_summary)}`);
      await settle();
    }
    const meals = await admin.from("meals").select("id, name, status, version").eq("user_id", userId);
    log(`meals saved: ${JSON.stringify(meals.data)}`);
    expect((meals.data ?? []).length).toBeGreaterThanOrEqual(1);
    expect(final.daily_summary?.consumed.calories ?? 0).toBeGreaterThan(0);
  }, 120_000);

  it("saves an explicit preference as a memory (B13 second pass or tool)", async () => {
    const r = await send({ text: "Just so you know, my usual breakfast is 2 eggs and toast with butter." });
    log(`reply: ${r.assistant_message.text}`);
    await settle();
    const mem = await admin.from("user_memories").select("category, content").eq("user_id", userId).is("deleted_at", null);
    log(`memories: ${JSON.stringify(mem.data)}`);
    expect((mem.data ?? []).length).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it.skipIf(!PHOTO)("accepts a food photo through the chat route", async () => {
    const bytes = readFileSync(PHOTO!);
    const r = await send({ image: new Blob([bytes], { type: "image/jpeg" }), text: "" });
    log(`photo reply: ${r.assistant_message.text}`);
    log(`photo cards: ${JSON.stringify(r.assistant_message.cards?.map((c) => ({ kind: c.kind, name: (c as { meal?: { name?: string } }).meal?.name })))}`);
    expect(r.assistant_message.text.length).toBeGreaterThan(0);
    await settle();
  }, 180_000);
});
