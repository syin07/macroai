import type { SupabaseClient } from "@supabase/supabase-js";
import type { NutritionGoals, PutGoalsRequest } from "@/types/api";

// nutrition_goals keeps history: each row applies from `effective_from` (inclusive) to `effective_to`
// (exclusive, null = still in effect). Dates are calendar days in the user's time zone.

const GOAL_COLUMNS = "calorie_target, protein_target_g, carbs_target_g, fat_target_g, effective_from, effective_to";

interface GoalRow {
  calorie_target: number | string;
  protein_target_g: number | string;
  carbs_target_g: number | string;
  fat_target_g: number | string;
  effective_from: string;
  effective_to: string | null;
}

function toGoals(row: GoalRow): NutritionGoals {
  return {
    calories: Number(row.calorie_target),
    protein_g: Number(row.protein_target_g),
    carbs_g: Number(row.carbs_target_g),
    fat_g: Number(row.fat_target_g),
    effective_from: row.effective_from,
  };
}

// The goals in effect on `date` (YYYY-MM-DD), or null if none were set by then.
export async function getGoalsOn(supabase: SupabaseClient, userId: string, date: string): Promise<NutritionGoals | null> {
  const { data, error } = await supabase
    .from("nutrition_goals")
    .select(GOAL_COLUMNS)
    .eq("user_id", userId)
    .lte("effective_from", date)
    .or(`effective_to.is.null,effective_to.gt.${date}`)
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`nutrition_goals select failed: ${error.message}`);
  return data ? toGoals(data as GoalRow) : null;
}

// Saves new targets effective from `today` and closes whatever was in effect before, so past days keep
// the targets they had. A second save on the same day overwrites today's row (unique on
// user_id + effective_from). Rows dated after `today` can only exist if the user moved to a time zone
// behind their old one; they were saved earlier than this, so this save replaces them.
//
// Three statements, not a transaction. The order keeps reads correct if a later step fails: today's
// row is written before older rows are closed, and getGoalsOn() picks the newest row in effect.
export async function saveGoals(
  supabase: SupabaseClient,
  userId: string,
  today: string,
  goals: PutGoalsRequest,
): Promise<NutritionGoals> {
  const { error: deleteError } = await supabase
    .from("nutrition_goals")
    .delete()
    .eq("user_id", userId)
    .gt("effective_from", today);
  if (deleteError) throw new Error(`nutrition_goals delete failed: ${deleteError.message}`);

  const { data, error } = await supabase
    .from("nutrition_goals")
    .upsert(
      {
        user_id: userId,
        calorie_target: goals.calories,
        protein_target_g: goals.protein_g,
        carbs_target_g: goals.carbs_g,
        fat_target_g: goals.fat_g,
        effective_from: today,
        effective_to: null,
      },
      { onConflict: "user_id,effective_from" },
    )
    .select(GOAL_COLUMNS)
    .single();
  if (error) throw new Error(`nutrition_goals upsert failed: ${error.message}`);

  const { error: closeError } = await supabase
    .from("nutrition_goals")
    .update({ effective_to: today })
    .eq("user_id", userId)
    .lt("effective_from", today)
    .or(`effective_to.is.null,effective_to.gt.${today}`);
  if (closeError) throw new Error(`nutrition_goals close failed: ${closeError.message}`);

  return toGoals(data as GoalRow);
}
