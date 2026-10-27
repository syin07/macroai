import type {
  DailySummary,
  DeleteMealResponse,
  Meal,
  MealsPage,
  SaveMealsRequest,
  SaveMealsResponse,
  UndoDeleteResponse,
  UpdateMealRequest,
  UpdateMealResponse,
} from "@/types/api";
import { request, queryString, type RequestOptions } from "./client";

export interface MealFilters {
  from?: string;
  to?: string;
  q?: string;
  cursor?: string;
  limit?: number;
}
// Construct once per save action and retain it for retries (including save-all/manual).
export function createSaveAction(body: SaveMealsRequest) {
  return {
    body,
    idempotencyKey:
      body.meals.length === 1 && body.meals[0].proposal_id
        ? body.meals[0].proposal_id
        : crypto.randomUUID(),
  };
}
export function saveMeals(
  action: ReturnType<typeof createSaveAction>,
  options?: RequestOptions,
) {
  const headers = new Headers(options?.headers);
  headers.set("Idempotency-Key", action.idempotencyKey);
  return request<SaveMealsResponse>("POST", "/api/meals", action.body, {
    ...options,
    headers,
  });
}
export function getMeals(filters: MealFilters = {}, options?: RequestOptions) {
  return request<MealsPage>(
    "GET",
    `/api/meals${queryString({ ...filters })}`,
    undefined,
    options,
  );
}
export function getMeal(id: string, options?: RequestOptions) {
  return request<Meal>(
    "GET",
    `/api/meals/${encodeURIComponent(id)}`,
    undefined,
    options,
  );
}
export function updateMeal(
  id: string,
  body: UpdateMealRequest,
  options?: RequestOptions,
) {
  return request<UpdateMealResponse>(
    "PATCH",
    `/api/meals/${encodeURIComponent(id)}`,
    body,
    options,
  );
}
export function deleteMeal(id: string, options?: RequestOptions) {
  return request<DeleteMealResponse>(
    "DELETE",
    `/api/meals/${encodeURIComponent(id)}`,
    undefined,
    options,
  );
}
export function undoDelete(id: string, options?: RequestOptions) {
  return request<UndoDeleteResponse>(
    "POST",
    `/api/meals/${encodeURIComponent(id)}/undo`,
    undefined,
    options,
  );
}
export function getDaily(date?: string, options?: RequestOptions) {
  return request<DailySummary>(
    "GET",
    `/api/nutrition/daily${queryString({ date })}`,
    undefined,
    options,
  );
}
