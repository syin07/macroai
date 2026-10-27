import { readdirSync, readFileSync } from "node:fs";
import { createUsdaClient, type NutritionLookup } from "../usda";

// Test helper: serves recorded FoodData Central responses (see usda/README.md) through the real client.

const DIR = new URL("./usda/", import.meta.url);

export function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`${name}.json`, DIR), "utf8"));
}

// food-<fdcId>-<label>.json → fdcId
const FOOD_FILES = new Map(
  readdirSync(DIR)
    .flatMap((file) => {
      const match = /^food-(\d+)-.*\.json$/.exec(file);
      return match ? [[Number(match[1]), file.replace(/\.json$/, "")] as const] : [];
    }),
);

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: { query: string; dataType: string[]; pageSize: number } | null;
}

// Searches are answered by query text (`searches` maps query → fixture name; unknown queries get no hits);
// GET /food/:id is answered from food-<id>-*.json, or 404.
export function fixtureFetch(searches: Record<string, string>, requests: RecordedRequest[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    requests.push({ url, method: init?.method ?? "GET", headers: new Headers(init?.headers), body });

    if (url.endsWith("/foods/search")) {
      const name = searches[body?.query];
      return Response.json(name ? loadFixture(name) : { totalHits: 0, foods: [] });
    }
    const id = /\/food\/(\d+)$/.exec(url)?.[1];
    const file = id ? FOOD_FILES.get(Number(id)) : undefined;
    return file ? Response.json(loadFixture(file)) : new Response("Not found", { status: 404 });
  }) as typeof fetch;
}

export function fixtureLookup(searches: Record<string, string>): { lookup: NutritionLookup; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  return { lookup: createUsdaClient({ apiKey: "TEST_KEY", fetch: fixtureFetch(searches, requests) }), requests };
}
