"use client";
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { suggestGoals } from "@/lib/api";
import { suggestGoalsRequestSchema } from "@/lib/validation/goals";
import type { Macros, SuggestGoalsRequest } from "@/types/api";
import { action, control } from "@/components/settings/settings-shared";

/** Reusable goal step for Settings and onboarding. Suggestions never save targets. */
export function GoalCalculator({
  onChoose,
}: {
  onChoose: (macros: Macros) => void;
}) {
  const suggest = useMutation({
    gcTime: 0,
    mutationFn: (body: SuggestGoalsRequest) => suggestGoals(body),
  });
  const [heightUnit, setHeightUnit] = useState("cm");
  const [weightUnit, setWeightUnit] = useState("kg");
  const [error, setError] = useState("");
  return (
    <form
      className="space-y-4"
      onChange={() => {
        suggest.reset();
        setError("");
      }}
      onSubmit={async (event) => {
        event.preventDefault();
        if (suggest.isPending) return;
        const data = new FormData(event.currentTarget);
        const checked = suggestGoalsRequestSchema.safeParse({
          age: Number(data.get("age")),
          height_cm:
            heightUnit === "cm"
              ? Number(data.get("height_cm"))
              : (Number(data.get("feet")) * 12 + Number(data.get("inches"))) *
                2.54,
          weight_kg:
            Number(data.get("weight")) * (weightUnit === "lb" ? 0.45359237 : 1),
          sex: data.get("sex"),
          activity: data.get("activity"),
          goal: data.get("goal"),
        });
        if (!checked.success) {
          setError("Check your age, height, weight, and selections.");
          return;
        }
        try {
          await suggest.mutateAsync(checked.data);
        } catch {
          /* Retain the inputs for retry. */
        }
      }}
    >
      <p className="text-sm leading-6 text-muted-foreground">
        These details are optional and used to calculate a suggestion. Targets
        save only after you review and save them.
      </p>
      <fieldset disabled={suggest.isPending} className="space-y-4">
        <label className="block text-sm">
          Age
          <input
            name="age"
            aria-label="Age"
            type="number"
            min="13"
            max="120"
            required
            className={`${control} mt-2`}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-sm">
            Height units
            <select
              aria-label="Height units"
              value={heightUnit}
              onChange={(event) => setHeightUnit(event.target.value)}
              className={`${control} mt-2`}
            >
              <option value="cm">cm</option>
              <option value="ft">ft / in</option>
            </select>
          </label>
          <label className="text-sm">
            Weight units
            <select
              aria-label="Weight units"
              value={weightUnit}
              onChange={(event) => setWeightUnit(event.target.value)}
              className={`${control} mt-2`}
            >
              <option value="kg">kg</option>
              <option value="lb">lb</option>
            </select>
          </label>
        </div>
        {heightUnit === "cm" ? (
          <label className="block text-sm">
            Height (cm)
            <input
              name="height_cm"
              aria-label="Height (cm)"
              type="number"
              min="100"
              max="250"
              step="0.1"
              required
              className={`${control} mt-2`}
            />
          </label>
        ) : (
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm">
              Feet
              <input
                name="feet"
                aria-label="Height feet"
                type="number"
                min="3"
                max="8"
                required
                className={`${control} mt-2`}
              />
            </label>
            <label className="text-sm">
              Inches
              <input
                name="inches"
                aria-label="Height inches"
                type="number"
                min="0"
                max="11.99"
                step="0.1"
                required
                className={`${control} mt-2`}
              />
            </label>
          </div>
        )}
        <label className="block text-sm">
          Weight ({weightUnit})
          <input
            key={weightUnit}
            name="weight"
            aria-label="Weight"
            type="number"
            min="1"
            step="0.1"
            required
            className={`${control} mt-2`}
          />
        </label>
        <label className="block text-sm">
          Sex used by the equation
          <select
            name="sex"
            aria-label="Sex used by the equation"
            required
            defaultValue=""
            className={`${control} mt-2`}
          >
            <option value="" disabled>
              Choose an option
            </option>
            <option value="male">Male</option>
            <option value="female">Female</option>
          </select>
        </label>
        <p className="text-xs leading-5 text-muted-foreground">
          The energy estimate uses a sex-based equation. You can skip this
          calculator and enter your own targets.
        </p>
        <label className="block text-sm">
          Activity
          <select
            name="activity"
            aria-label="Activity"
            defaultValue="moderate"
            className={`${control} mt-2`}
          >
            {["sedentary", "light", "moderate", "active", "very_active"].map(
              (value) => (
                <option key={value} value={value}>
                  {value.replaceAll("_", " ")}
                </option>
              ),
            )}
          </select>
        </label>
        <label className="block text-sm">
          Goal
          <select
            name="goal"
            aria-label="Goal"
            defaultValue="maintain"
            className={`${control} mt-2`}
          >
            <option value="lose">Lose weight</option>
            <option value="maintain">Maintain weight</option>
            <option value="gain">Gain weight</option>
          </select>
        </label>
        <button type="submit" className={action}>
          {suggest.isPending
            ? "Calculating…"
            : suggest.isError
              ? "Retry calculation"
              : "Calculate targets"}
        </button>
      </fieldset>
      {(error || suggest.isError) && (
        <p role="alert" className="text-sm">
          {error || suggest.error?.message}
        </p>
      )}
      {suggest.data && (
        <div className="rounded-xl border border-[var(--app-line)] p-4 text-sm">
          <p className="font-medium">Suggested daily targets</p>
          <p className="mt-2 tabular-nums">
            {suggest.data.suggested.calories} kcal · P{" "}
            {suggest.data.suggested.protein_g} g · C{" "}
            {suggest.data.suggested.carbs_g} g · F{" "}
            {suggest.data.suggested.fat_g} g
          </p>
          <p className="my-3 leading-6 text-muted-foreground">
            {suggest.data.explanation}
          </p>
          <button
            type="button"
            className={action}
            onClick={() => onChoose(suggest.data!.suggested)}
          >
            Review these targets
          </button>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Targets are estimates, not medical advice.
      </p>
    </form>
  );
}
