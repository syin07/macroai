// Scans the built client bundle for secrets (B15, PRD §16.4: "API keys are never present in
// browser-delivered code"). Run after `npm run build`:
//
//   npx tsx tests/security/scan-bundle.ts [dir]     (default: .next/static)
//
// Looks for secret key shapes (Anthropic, OpenAI, Google, Supabase secret keys, and any Supabase JWT
// whose role isn't "anon"), the names of server-only env vars, and, when those vars are set in the
// environment that runs the scan, their literal values. Exits 1 on any hit, 2 if there is nothing to
// scan. The anon key and sb_publishable_ keys are public by design and are allowed.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

// Server-only env vars (.env.example). Only NEXT_PUBLIC_* may reach the browser.
export const SERVER_ENV_NAMES = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "CRON_SECRET",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "USDA_API_KEY",
  "APPROVED_EMAILS",
  "SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET",
];

const KEY_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "Anthropic API key (sk-ant-)", pattern: /sk-ant-[A-Za-z0-9_-]{8,}/g },
  // OpenAI keys: sk-…, sk-proj-…. Must start a token, so "task-…" or "disk-…" don't match.
  { name: "OpenAI-style secret key (sk-)", pattern: /(?<![A-Za-z0-9_-])sk-(?!ant-)[A-Za-z0-9_-]{20,}/g },
  { name: "Google API key (AIza)", pattern: /AIza[0-9A-Za-z_-]{35}/g },
  { name: "Supabase secret key (sb_secret_)", pattern: /sb_secret_[A-Za-z0-9_-]{8,}/g },
];

// Any JWT; flagged unless its payload says role "anon" (the public anon key).
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g;

const TEXT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".css", ".json", ".map", ".html", ".txt", ".svg", ".rsc"]);

export type Env = Record<string, string | undefined>;

export interface Hit {
  file: string;
  kind: string;
  sample: string;
}

function jwtRole(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as { role?: unknown };
    return typeof payload.role === "string" ? payload.role : null;
  } catch {
    return null;
  }
}

// Shows where a hit is without printing a whole secret.
function redact(match: string): string {
  return match.length <= 12 ? match : `${match.slice(0, 10)}…(${match.length} chars)`;
}

export function scanText(file: string, text: string, env: Env = {}): Hit[] {
  const hits: Hit[] = [];
  for (const { name, pattern } of KEY_PATTERNS) {
    for (const match of text.matchAll(pattern)) hits.push({ file, kind: name, sample: redact(match[0]) });
  }
  for (const match of text.matchAll(JWT)) {
    const role = jwtRole(match[0]);
    if (role !== "anon") hits.push({ file, kind: `JWT with role ${JSON.stringify(role)}`, sample: redact(match[0]) });
  }
  for (const name of SERVER_ENV_NAMES) {
    if (text.includes(name)) hits.push({ file, kind: `server-only env name ${name}`, sample: name });
    const value = env[name];
    // Short values ("1", "true") would match by chance; real secrets are long.
    if (value && value.length >= 8) {
      for (const part of name === "APPROVED_EMAILS" ? value.split(",").map((v) => v.trim()) : [value]) {
        if (part.length >= 6 && text.includes(part)) hits.push({ file, kind: `value of ${name}`, sample: redact(part) });
      }
    }
  }
  return hits;
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return TEXT_EXTENSIONS.has(extname(entry.name)) ? [path] : [];
  });
}

export function scanDir(dir: string, env: Env = process.env): { scanned: number; hits: Hit[] } {
  const list = files(dir);
  const hits = list.flatMap((file) => scanText(relative(process.cwd(), file), readFileSync(file, "utf8"), env));
  return { scanned: list.length, hits };
}

function main() {
  const dir = process.argv[2] ?? join(process.cwd(), ".next", "static");
  let isDir = false;
  try {
    isDir = statSync(dir).isDirectory();
  } catch {
    // reported below
  }
  if (!isDir) {
    console.error(`scan-bundle: ${dir} not found. Run \`npm run build\` first.`);
    process.exit(2);
  }
  const { scanned, hits } = scanDir(dir);
  if (scanned === 0) {
    console.error(`scan-bundle: no files to scan in ${dir}.`);
    process.exit(2);
  }
  if (hits.length > 0) {
    console.error(`scan-bundle: ${hits.length} possible secret(s) in the client bundle:`);
    for (const hit of hits) console.error(`  ${hit.file}: ${hit.kind}: ${hit.sample}`);
    process.exit(1);
  }
  console.log(`scan-bundle: OK, ${scanned} files in ${relative(process.cwd(), dir) || dir}, no secrets found.`);
}

// Run as a script (npx tsx tests/security/scan-bundle.ts), not when imported by its test.
if (process.argv[1] && /scan-bundle\.ts$/.test(process.argv[1])) main();
