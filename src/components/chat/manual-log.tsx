"use client";

import { useRef, useState } from "react";
import { createSaveAction } from "@/lib/api";
import { useSaveMeals } from "@/hooks/use-api";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

// Minimal working manual entry for the A5 cap-reached path; A10 adds its full composer menu.
export function ManualLog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const save = useSaveMeals();
  const action = useRef<ReturnType<typeof createSaveAction> | null>(null);
  const [validation, setValidation] = useState("");
  const [date] = useState(() =>
    new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16),
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!save.isPending) {
          if (!next) {
            action.current = null;
            save.reset();
          }
          onOpenChange(next);
        }
      }}
    >
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogTitle>Log manually</DialogTitle>
        <DialogDescription>
          Enter the nutrition from a label or your own estimate.
        </DialogDescription>
        <form
          onChange={() => {
            action.current = null;
            save.reset();
            setValidation("");
          }}
          onSubmit={async (event) => {
            event.preventDefault();
            if (save.isPending) return;
            const data = new FormData(event.currentTarget);
            const name = String(data.get("name")).trim();
            const date = new Date(String(data.get("date")));
            if (!name || !Number.isFinite(date.getTime())) {
              setValidation("Enter a meal name and valid date.");
              return;
            }
            const macros = {
              calories: Number(data.get("calories")),
              protein_g: Number(data.get("protein_g")),
              carbs_g: Number(data.get("carbs_g")),
              fat_g: Number(data.get("fat_g")),
            };
            action.current ??= createSaveAction({
              meals: [
                {
                  proposal_id: null,
                  name,
                  consumed_at: date.toISOString(),
                  source_type: "manual",
                  items: [
                    {
                      food_name: name,
                      quantity: 1,
                      unit: "serving",
                      grams: null,
                      basis_per_100g: null,
                      macros,
                      nutrition_source: "manual",
                      source_reference: null,
                      inferred: false,
                      confidence: null,
                      edited_by_user: true,
                      assumptions: null,
                    },
                  ],
                },
              ],
            });
            try {
              await save.mutateAsync(action.current);
              action.current = null;
              onOpenChange(false);
            } catch {
              /* Keep form and action for retry. */
            }
          }}
          className="space-y-4"
        >
          <fieldset disabled={save.isPending} className="space-y-4">
            <label className="block space-y-2">
              <span>Meal name</span>
              <Input
                name="name"
                required
                maxLength={200}
                className="min-h-11"
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              {(
                [
                  ["Calories (kcal)", "calories"],
                  ["Protein (g)", "protein_g"],
                  ["Carbs (g)", "carbs_g"],
                  ["Fat (g)", "fat_g"],
                ] as const
              ).map(([label, name]) => (
                <label key={name} className="block space-y-2">
                  <span>{label}</span>
                  <Input
                    name={name}
                    type="number"
                    min="0"
                    max="100000"
                    step="0.1"
                    required
                    className="min-h-11"
                  />
                </label>
              ))}
            </div>
            <label className="block space-y-2">
              <span>Date and time</span>
              <Input
                name="date"
                type="datetime-local"
                required
                defaultValue={date}
                className="min-h-11"
              />
            </label>
            {(validation || save.isError) && (
              <p role="alert">{validation || save.error?.message}</p>
            )}
            <Button type="submit" className="min-h-11 w-full">
              {save.isPending
                ? "Saving…"
                : save.isError
                  ? "Retry save"
                  : "Save meal"}
            </Button>
          </fieldset>
        </form>
      </DialogContent>
    </Dialog>
  );
}
