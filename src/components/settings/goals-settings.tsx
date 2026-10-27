"use client";
import { useState } from "react";
import { useGoals, usePutGoals } from "@/hooks/use-api";
import { putGoalsRequestSchema } from "@/lib/validation/goals";
import { GoalCalculator } from "@/components/goals/goal-calculator";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  action,
  control,
  QueryNotice,
  SettingsSection,
} from "./settings-shared";
const fields = [
  ["Calories (kcal)", "calories", 800, 10000],
  ["Protein (g)", "protein_g", 0, 1000],
  ["Carbs (g)", "carbs_g", 0, 2000],
  ["Fat (g)", "fat_g", 0, 1000],
] as const;

export function GoalsSettings() {
  const goals = useGoals();
  const save = usePutGoals();
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [calculator, setCalculator] = useState(false);
  const [notice, setNotice] = useState("");
  const values =
    draft ??
    Object.fromEntries(
      fields.map(([, key]) => [key, goals.data ? String(goals.data[key]) : ""]),
    );
  return (
    <SettingsSection
      title="Goals"
      description="Daily targets are optional. You can enter your own or calculate an estimate."
    >
      {goals.isPending || (goals.isError && goals.data === undefined) ? (
        <QueryNotice
          pending={goals.isPending}
          error={goals.isError}
          retry={() => void goals.refetch()}
        />
      ) : (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (save.isPending) return;
            const checked = putGoalsRequestSchema.safeParse(
              Object.fromEntries(
                fields.map(([, key]) => [
                  key,
                  values[key]?.trim() ? Number(values[key]) : NaN,
                ]),
              ),
            );
            if (!checked.success) {
              setNotice("Enter valid daily targets in all four fields.");
              return;
            }
            try {
              await save.mutateAsync(checked.data);
              setDraft(null);
              setNotice("Goals saved.");
            } catch {
              /* Keep all target inputs. */
            }
          }}
        >
          <fieldset disabled={save.isPending}>
            <div className="grid grid-cols-2 gap-3">
              {fields.map(([label, key, min, max]) => (
                <label key={key} className="min-w-0 text-sm">
                  {label}
                  <input
                    aria-label={label}
                    type="number"
                    min={min}
                    max={max}
                    step={key === "calories" ? "1" : "0.1"}
                    required
                    className={`${control} mt-2`}
                    value={values[key]}
                    onChange={(event) => {
                      setDraft({ ...values, [key]: event.target.value });
                      setNotice("");
                      save.reset();
                    }}
                  />
                </label>
              ))}
            </div>
            <div className="mt-4 flex flex-wrap gap-3">
              <button type="submit" className={action}>
                {save.isPending
                  ? "Saving goals…"
                  : save.isError
                    ? "Retry goals"
                    : "Save goals"}
              </button>
              <button
                type="button"
                className="chat-text-button"
                onClick={() => setCalculator(true)}
              >
                Recalculate
              </button>
              {draft && (
                <button
                  type="button"
                  className="chat-text-button"
                  onClick={() => {
                    setDraft(null);
                    setNotice("");
                    save.reset();
                  }}
                >
                  Cancel targets
                </button>
              )}
            </div>
          </fieldset>
          {(notice || save.isError) && (
            <p
              role={save.isError ? "alert" : "status"}
              className="mt-3 text-sm"
            >
              {save.error?.message || notice}
            </p>
          )}
          {goals.isError && (
            <button
              type="button"
              className="chat-text-button"
              onClick={() => void goals.refetch()}
            >
              Refresh saved goals
            </button>
          )}
        </form>
      )}
      <Dialog open={calculator} onOpenChange={setCalculator}>
        <DialogContent className="max-h-[85dvh] overflow-y-auto">
          <DialogTitle>Recalculate goals</DialogTitle>
          <DialogDescription>
            Estimate, review, then save your daily targets.
          </DialogDescription>
          <GoalCalculator
            onChoose={(macros) => {
              setDraft(
                Object.fromEntries(
                  Object.entries(macros).map(([key, value]) => [
                    key,
                    String(value),
                  ]),
                ),
              );
              setNotice(
                "Suggested targets are ready to review. Tap Save goals to apply them.",
              );
              save.reset();
              setCalculator(false);
            }}
          />
        </DialogContent>
      </Dialog>
    </SettingsSection>
  );
}
