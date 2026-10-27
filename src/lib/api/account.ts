import type {
  ExportFormat,
  ExportScope,
  Me,
  MemoriesResponse,
  Memory,
  NutritionGoals,
  PatchMemoryRequest,
  PatchPreferencesRequest,
  Preferences,
  PutGoalsRequest,
  SuggestGoalsRequest,
  SuggestGoalsResponse,
} from "@/types/api";
import { request, queryString, type RequestOptions } from "./client";

export const getMe = (options?: RequestOptions) =>
  request<Me>("GET", "/api/me", undefined, options);
export const getGoals = (options?: RequestOptions) =>
  request<NutritionGoals | null>("GET", "/api/goals", undefined, options);
export const putGoals = (body: PutGoalsRequest, options?: RequestOptions) =>
  request<NutritionGoals>("PUT", "/api/goals", body, options);
export const suggestGoals = (
  body: SuggestGoalsRequest,
  options?: RequestOptions,
) => request<SuggestGoalsResponse>("POST", "/api/goals/suggest", body, options);
export const getPreferences = (options?: RequestOptions) =>
  request<Preferences>("GET", "/api/preferences", undefined, options);
export const patchPreferences = (
  body: PatchPreferencesRequest,
  options?: RequestOptions,
) => request<Preferences>("PATCH", "/api/preferences", body, options);
export const completeOnboarding = (options?: RequestOptions) =>
  request<Me>("POST", "/api/onboarding/complete", undefined, options);
export const getMemories = (options?: RequestOptions) =>
  request<MemoriesResponse>("GET", "/api/memories", undefined, options);
export const patchMemory = (
  id: string,
  body: PatchMemoryRequest,
  options?: RequestOptions,
) =>
  request<Memory>(
    "PATCH",
    `/api/memories/${encodeURIComponent(id)}`,
    body,
    options,
  );
export const deleteMemory = (id: string, options?: RequestOptions) =>
  request<void>(
    "DELETE",
    `/api/memories/${encodeURIComponent(id)}`,
    undefined,
    options,
  );
export const exportData = (
  format: ExportFormat,
  scope: ExportScope = "nutrition",
  options?: RequestOptions,
) =>
  request<Blob>(
    "GET",
    `/api/export${queryString({ format, scope })}`,
    undefined,
    { ...options, responseType: "blob" },
  );
export const deleteAccount = (options?: RequestOptions) =>
  request<void>("DELETE", "/api/account", { confirm: "DELETE" }, options);
