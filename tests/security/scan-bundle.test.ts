import { describe, expect, it } from "vitest";
import { scanText, type Env } from "./scan-bundle";

// The bundle scanner must catch secrets and stay quiet on ordinary minified code and public keys.

const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const jwt = (role: string) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: "supabase", role, exp: 1983812996 })}.c2lnbmF0dXJlLXBhcnQ`;

const kinds = (text: string, env: Env = {}) => scanText("chunk.js", text, env).map((hit) => hit.kind);

describe("scanText", () => {
  it.each([
    ["an Anthropic key", `const k="sk-ant-api03-${"x".repeat(40)}"`, "Anthropic API key (sk-ant-)"],
    ["an OpenAI key", `fetch(u,{headers:{Authorization:"Bearer sk-proj-${"a1".repeat(20)}"}})`, "OpenAI-style secret key (sk-)"],
    ["a Google key", `key:"AIza${"B".repeat(35)}"`, "Google API key (AIza)"],
    ["a Supabase secret key", `"sb_secret_N7UND0UgjKTVK-Uodkm0Hg_xSvEMPvz"`, "Supabase secret key (sb_secret_)"],
    ["a service-role JWT", `createClient(u,"${jwt("service_role")}")`, 'JWT with role "service_role"'],
    ["a server-only env name", `process.env.SUPABASE_SERVICE_ROLE_KEY`, "server-only env name SUPABASE_SERVICE_ROLE_KEY"],
    ["the CRON_SECRET name", `x.CRON_SECRET`, "server-only env name CRON_SECRET"],
  ])("flags %s", (_case, text, kind) => {
    expect(kinds(text)).toContain(kind);
  });

  it("flags the literal value of a server-only env var", () => {
    expect(kinds(`var a="dummy-cron-secret-1234";`, { CRON_SECRET: "dummy-cron-secret-1234" })).toEqual(["value of CRON_SECRET"]);
    expect(kinds(`["sandy@example.com"]`, { APPROVED_EMAILS: "sandy@example.com, ken@example.com" })).toEqual([
      "value of APPROVED_EMAILS",
    ]);
  });

  it.each([
    ["the anon JWT", `createBrowserClient(u,"${jwt("anon")}")`],
    ["a publishable key", `"sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH"`],
    ["words ending in sk-", `className:"task-list-item desk-lamp risk-assessment-panel-wrapper-xyz"`],
    ["NEXT_PUBLIC_ vars", `process.env.NEXT_PUBLIC_SUPABASE_URL`],
    ["short env values", `a="1"`],
  ])("ignores %s", (_case, text) => {
    expect(kinds(text, { AI_DAILY_CALL_CAP: "150", CRON_SECRET: "1" })).toEqual([]);
  });

  it("never prints a whole secret", () => {
    const secret = `sk-ant-api03-${"z".repeat(60)}`;
    const [hit] = scanText("chunk.js", secret);
    expect(hit!.sample).not.toBe(secret);
    expect(hit!.sample.length).toBeLessThan(30);
  });
});
