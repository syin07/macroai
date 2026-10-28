import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { MealItem } from "@/types/api";
import * as account from "@/app/api/account/route";
import * as analyzeMeal from "@/app/api/ai/analyze-meal/route";
import * as chat from "@/app/api/ai/chat/route";
import * as purge from "@/app/api/cron/purge/route";
import * as exportRoute from "@/app/api/export/route";
import * as goals from "@/app/api/goals/route";
import * as suggest from "@/app/api/goals/suggest/route";
import * as me from "@/app/api/me/route";
import * as mealById from "@/app/api/meals/[id]/route";
import * as undo from "@/app/api/meals/[id]/undo/route";
import * as meals from "@/app/api/meals/route";
import * as memoryById from "@/app/api/memories/[id]/route";
import * as memories from "@/app/api/memories/route";
import * as messageById from "@/app/api/messages/[id]/route";
import * as messages from "@/app/api/messages/route";
import * as daily from "@/app/api/nutrition/daily/route";
import * as onboarding from "@/app/api/onboarding/complete/route";
import * as preferences from "@/app/api/preferences/route";

// Every API route handler, called the way Next.js calls it, for the B15 security tests (PRD §16.4).
// Import this from a test file *after* its vi.mock() calls (vitest hoists them, so a plain import works).
//
// When a route is added under src/app/api/, add it to `api` and to `userRoutes()` (or `cronRoutes`).
// tests/security/routes.test.ts fails until you do, so every route gets the 401/403/error checks.

const BASE = "http://localhost";

function request(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}): Request {
  const init: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  return new Request(`${BASE}${path}`, init);
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

export interface ChatForm {
  client_message_id?: string;
  text?: string;
  timezone?: string;
  image?: Blob;
  // Extra form fields (e.g. a smuggled user_id).
  extra?: Record<string, string>;
}

// POST /api/ai/chat takes multipart/form-data.
function chatRequest({ client_message_id = randomUUID(), text, timezone = "UTC", image, extra = {} }: ChatForm): Request {
  const form = new FormData();
  form.set("client_message_id", client_message_id);
  form.set("timezone", timezone);
  if (text !== undefined) form.set("text", text);
  if (image) form.set("image", image, "meal.jpg");
  for (const [name, value] of Object.entries(extra)) form.set(name, value);
  return new Request(`${BASE}/api/ai/chat`, { method: "POST", body: form });
}

export const api = {
  me: () => me.GET(),
  listMeals: (query = "") => meals.GET(request(`/api/meals${query}`)),
  saveMeals: (body: unknown, key: string = randomUUID()) =>
    meals.POST(request("/api/meals", "POST", body, { "Idempotency-Key": key })),
  getMeal: (id: string) => mealById.GET(request(`/api/meals/${id}`), ctx(id)),
  patchMeal: (id: string, body: unknown) => mealById.PATCH(request(`/api/meals/${id}`, "PATCH", body), ctx(id)),
  deleteMeal: (id: string) => mealById.DELETE(request(`/api/meals/${id}`, "DELETE"), ctx(id)),
  undoDelete: (id: string) => undo.POST(request(`/api/meals/${id}/undo`, "POST"), ctx(id)),
  daily: (query = "") => daily.GET(request(`/api/nutrition/daily${query}`)),
  getGoals: () => goals.GET(),
  putGoals: (body: unknown) => goals.PUT(request("/api/goals", "PUT", body)),
  suggestGoals: (body: unknown) => suggest.POST(request("/api/goals/suggest", "POST", body)),
  getPreferences: () => preferences.GET(),
  patchPreferences: (body: unknown) => preferences.PATCH(request("/api/preferences", "PATCH", body)),
  completeOnboarding: () => onboarding.POST(),
  listMemories: () => memories.GET(),
  patchMemory: (id: string, body: unknown) => memoryById.PATCH(request(`/api/memories/${id}`, "PATCH", body), ctx(id)),
  deleteMemory: (id: string) => memoryById.DELETE(request(`/api/memories/${id}`, "DELETE"), ctx(id)),
  exportData: (query: string) => exportRoute.GET(request(`/api/export${query}`)),
  deleteAccount: (body: unknown) => account.DELETE(request("/api/account", "DELETE", body)),
  analyzeMeal: (body: unknown) => analyzeMeal.POST(request("/api/ai/analyze-meal", "POST", body)),
  chat: (form: ChatForm) => chat.POST(chatRequest(form)),
  listMessages: (query = "") => messages.GET(request(`/api/messages${query}`)),
  deleteMessage: (id: string) => messageById.DELETE(request(`/api/messages/${id}`, "DELETE"), ctx(id)),
  purge: (headers: Record<string, string> = {}) => purge.GET(request("/api/cron/purge", "GET", undefined, headers)),
};

// --- Valid inputs (so a request gets past validation and reaches the database) -----------------

export const chickenItem = (overrides: Partial<MealItem> = {}): Omit<MealItem, "id"> => ({
  food_name: "grilled chicken breast",
  quantity: 150,
  unit: "g",
  grams: 150,
  basis_per_100g: { calories: 165, protein_g: 31, carbs_g: 0, fat_g: 3.6 },
  macros: { calories: 247.5, protein_g: 46.5, carbs_g: 0, fat_g: 5.4 },
  nutrition_source: "usda",
  source_reference: "171534",
  inferred: false,
  confidence: null,
  edited_by_user: false,
  assumptions: null,
  ...overrides,
});

export const valid = {
  saveMeals: (name = "Chicken lunch", consumed_at = "2026-10-26T12:30:00-07:00") => ({
    meals: [{ proposal_id: null, name, consumed_at, source_type: "text", items: [chickenItem()] }],
  }),
  patchMeal: { version: 1, name: "Renamed" },
  goals: { calories: 2100, protein_g: 150, carbs_g: 210, fat_g: 70 },
  suggest: { age: 35, height_cm: 170, weight_kg: 70, sex: "female", activity: "moderate", goal: "maintain" },
  preferences: { theme: "dark" },
  memory: { content: "Usual coffee: oat latte" },
  account: { confirm: "DELETE" },
  analyze: { text: "2 eggs and toast", timezone: "UTC" },
  chat: { text: "2 eggs and toast", timezone: "UTC" },
};

export type RouteCall = readonly [key: string, call: () => Promise<Response>];

// One call per user-facing route and method, with valid input. `id` is used for every path id.
export function userRoutes(id: string): RouteCall[] {
  return [
    ["GET /api/me", () => api.me()],
    ["GET /api/meals", () => api.listMeals()],
    ["POST /api/meals", () => api.saveMeals(valid.saveMeals())],
    ["GET /api/meals/[id]", () => api.getMeal(id)],
    ["PATCH /api/meals/[id]", () => api.patchMeal(id, valid.patchMeal)],
    ["DELETE /api/meals/[id]", () => api.deleteMeal(id)],
    ["POST /api/meals/[id]/undo", () => api.undoDelete(id)],
    ["GET /api/nutrition/daily", () => api.daily()],
    ["GET /api/goals", () => api.getGoals()],
    ["PUT /api/goals", () => api.putGoals(valid.goals)],
    ["POST /api/goals/suggest", () => api.suggestGoals(valid.suggest)],
    ["GET /api/preferences", () => api.getPreferences()],
    ["PATCH /api/preferences", () => api.patchPreferences(valid.preferences)],
    ["POST /api/onboarding/complete", () => api.completeOnboarding()],
    ["GET /api/memories", () => api.listMemories()],
    ["PATCH /api/memories/[id]", () => api.patchMemory(id, valid.memory)],
    ["DELETE /api/memories/[id]", () => api.deleteMemory(id)],
    ["GET /api/export", () => api.exportData("?format=json&scope=account")],
    ["DELETE /api/account", () => api.deleteAccount(valid.account)],
    ["POST /api/ai/analyze-meal", () => api.analyzeMeal(valid.analyze)],
    ["POST /api/ai/chat", () => api.chat(valid.chat)],
    ["GET /api/messages", () => api.listMessages()],
    ["DELETE /api/messages/[id]", () => api.deleteMessage(id)],
  ];
}

// Routes that authenticate with a shared secret instead of a user session.
export const cronRoutes = ["GET /api/cron/purge"];

// --- Discovery: every exported handler under src/app/api ------------------------------------------

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const API_DIR = join(process.cwd(), "src", "app", "api");

function routeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name.startsWith("_") ? [] : routeFiles(path);
    return entry.name === "route.ts" ? [path] : [];
  });
}

// "GET /api/meals/[id]" for every exported HTTP method of every route.ts.
export async function discoverRoutes(): Promise<string[]> {
  const keys: string[] = [];
  for (const file of routeFiles(API_DIR)) {
    const segments = relative(API_DIR, file).split(sep).slice(0, -1);
    const path = ["/api", ...segments].join("/");
    const mod = (await import(file)) as Record<string, unknown>;
    for (const method of METHODS) if (typeof mod[method] === "function") keys.push(`${method} ${path}`);
  }
  return keys.sort();
}
