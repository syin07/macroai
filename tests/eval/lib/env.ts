import { existsSync } from "node:fs";

// Scripts run outside Next.js, so load .env.local / .env ourselves (Node ≥ 20.12). Variables already
// set in the environment win.
export function loadEnv() {
  for (const file of [".env.local", ".env"]) {
    if (existsSync(file)) process.loadEnvFile(file);
  }
}
