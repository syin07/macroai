"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { completeOnboarding } from "@/lib/api";
import {
  useGoals,
  usePreferences,
  usePatchPreferences,
  usePutGoals,
  queryKeys,
} from "@/hooks/use-api";
import { putGoalsRequestSchema } from "@/lib/validation/goals";
import { patchPreferencesRequestSchema } from "@/lib/validation/preferences";
import { GoalCalculator } from "@/components/goals/goal-calculator";
import { PageFrame } from "@/components/shared/page-frame";
import { LoadingSkeleton } from "@/components/shared/loading-skeleton";
import { action, control } from "@/components/settings/settings-shared";
import type { Macros, Preferences } from "@/types/api";

const steps = ["Time zone", "Goal calculator", "Daily targets", "Save mode"];
const fields = [
  ["Calories (kcal)", "calories", 800, 10000],
  ["Protein (g)", "protein_g", 0, 1000],
  ["Carbs (g)", "carbs_g", 0, 2000],
  ["Fat (g)", "fat_g", 0, 1000],
] as const;
type Targets = Record<keyof Macros, string>;
const toTargets = (macros: Macros | null): Targets =>
  Object.fromEntries(
    fields.map(([, key]) => [key, macros ? String(macros[key]) : ""]),
  ) as Targets;

export function OnboardingScreen({ onFinished }: { onFinished?: () => void }) {
  const preferences = usePreferences();
  const goals = useGoals();
  const ready = preferences.data && goals.data !== undefined;
  return (
    <PageFrame
      title="Make it yours"
      description="A few small choices to get started. You can change them in Settings."
    >
      <div className="mt-8">
        {ready ? (
          <OnboardingFlow
            preferences={preferences.data!}
            goals={goals.data!}
            onFinished={onFinished}
          />
        ) : preferences.isError || goals.isError ? (
          <div role="alert" className="space-y-4 text-sm">
            <p>Your saved setup couldn’t load. Please try again.</p>
            <button
              className={action}
              onClick={() => {
                void preferences.refetch();
                void goals.refetch();
              }}
            >
              Retry setup
            </button>
          </div>
        ) : (
          <LoadingSkeleton
            label="Loading your setup…"
            className="mx-auto max-w-lg"
          />
        )}
      </div>
    </PageFrame>
  );
}

function OnboardingFlow({
  preferences,
  goals,
  onFinished,
}: {
  preferences: Preferences;
  goals: Macros | null;
  onFinished?: () => void;
}) {
  const router = useRouter();
  const client = useQueryClient();
  const patch = usePatchPreferences();
  const putGoals = usePutGoals();
  const [step, setStep] = useState(0);
  const [timezone, setTimezone] = useState(
    () =>
      Intl.DateTimeFormat().resolvedOptions().timeZone || preferences.timezone,
  );
  const [targets, setTargets] = useState(() => toTargets(goals));
  const [mode, setMode] = useState(preferences.save_mode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [suggested, setSuggested] = useState(false);
  const inFlight = useRef(false);
  const savedMode = useRef<Preferences["save_mode"] | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [step]);
  const zones = [
    ...new Set([
      timezone,
      preferences.timezone,
      "UTC",
      ...(typeof Intl.supportedValuesOf === "function"
        ? Intl.supportedValuesOf("timeZone")
        : []),
    ]),
  ].sort();
  function move(next: number) {
    setError("");
    setStep(next);
  }
  async function run(work: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch {
      setError(
        "That didn’t save. Your choices are still here. Please try again.",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <section
      className="mx-auto max-w-lg pb-8"
      aria-label="Account setup"
      aria-busy={busy}
    >
      <ol aria-label="Setup progress" className="mb-8 flex gap-3">
        {steps.map((label, index) => (
          <li key={label} aria-current={step === index ? "step" : undefined}>
            <span
              aria-hidden="true"
              className={`mb-2 block h-2.5 w-2.5 rounded-full ${index <= step ? "bg-[var(--app-accent)]" : "bg-muted"}`}
            />
            <span className="sr-only">
              Step {index + 1}: {label}
              {index < step ? ", visited" : ""}
            </span>
          </li>
        ))}
      </ol>
      <p className="mb-2 text-xs text-muted-foreground">
        Step {step + 1} of 4{step === 1 || step === 2 ? " · Optional" : ""}
      </p>
      <h2
        ref={heading}
        tabIndex={-1}
        className="mb-5 text-xl font-semibold outline-none"
      >
        {steps[step]}
      </h2>
      {step === 0 && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const checked = patchPreferencesRequestSchema.safeParse({
              timezone,
            });
            if (!checked.success) {
              setError("Choose a valid time zone.");
              return;
            }
            void run(async () => {
              await patch.mutateAsync(checked.data);
              move(1);
            });
          }}
        >
          <fieldset disabled={busy} className="space-y-4">
            <p className="text-sm leading-6 text-muted-foreground">
              We’ve filled in your device’s time zone. Meal dates and daily
              totals will follow this choice.
            </p>
            <label className="block text-sm">
              Time zone
              <select
                aria-label="Time zone"
                className={`${control} mt-2`}
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
              >
                {zones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone.replaceAll("_", " ")}
                  </option>
                ))}
              </select>
            </label>
            <button className={action} type="submit">
              {busy ? "Saving time zone…" : "Save time zone & continue"}
            </button>
          </fieldset>
        </form>
      )}
      {/* Private calculator inputs stay in component memory for Back, never browser storage. */}
      <div hidden={step !== 1}>
        <GoalCalculator
          onChoose={(macros) => {
            setTargets(toTargets(macros));
            setSuggested(true);
            move(2);
          }}
        />
        <button
          type="button"
          className="chat-text-button mt-3"
          onClick={() => move(2)}
        >
          Skip calculator
        </button>
      </div>
      {step === 2 && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const checked = putGoalsRequestSchema.safeParse(
              Object.fromEntries(
                fields.map(([, key]) => [
                  key,
                  targets[key].trim() ? Number(targets[key]) : NaN,
                ]),
              ),
            );
            if (!checked.success) {
              setError(
                "Enter valid daily targets in all four fields, or skip targets.",
              );
              return;
            }
            void run(async () => {
              await putGoals.mutateAsync(checked.data);
              move(3);
            });
          }}
        >
          <fieldset disabled={busy} className="space-y-4">
            <p className="text-sm leading-6 text-muted-foreground">
              {suggested
                ? "Review and edit your suggested targets before saving."
                : "Enter your own daily targets, or skip them for now."}{" "}
              Targets are estimates, not medical advice.
            </p>
            <div className="grid grid-cols-2 gap-3">
              {fields.map(([label, key, min, max]) => (
                <label key={key} className="min-w-0 text-sm">
                  {label}
                  <input
                    aria-label={label}
                    type="number"
                    required
                    min={min}
                    max={max}
                    step={key === "calories" ? "1" : "0.1"}
                    className={`${control} mt-2`}
                    value={targets[key]}
                    onChange={(event) =>
                      setTargets({ ...targets, [key]: event.target.value })
                    }
                  />
                </label>
              ))}
            </div>
            <button className={action} type="submit">
              {busy ? "Saving targets…" : "Save targets & continue"}
            </button>
            <button
              className="chat-text-button ml-3"
              type="button"
              onClick={() => move(3)}
            >
              Skip targets
            </button>
          </fieldset>
          <p className="mt-3 text-xs text-muted-foreground">
            Skipping keeps any previously saved targets.
          </p>
        </form>
      )}
      {step === 3 && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run(async () => {
              if (savedMode.current !== mode) {
                await patch.mutateAsync({ save_mode: mode });
                savedMode.current = mode;
              }
              const me = await completeOnboarding();
              if (!me.onboarding_complete) throw new Error("Setup incomplete");
              await client.cancelQueries({ queryKey: queryKeys.me });
              client.setQueryData(queryKeys.me, me);
              if (onFinished) onFinished();
              else router.replace("/today");
            });
          }}
        >
          <fieldset disabled={busy} className="space-y-3">
            <legend className="mb-4 text-sm text-muted-foreground">
              Choose how new meal estimates are saved.
            </legend>
            {(
              [
                [
                  "confirm",
                  "Confirm before saving",
                  "Review a meal and tap Save before it counts toward your day.",
                ],
                [
                  "auto",
                  "Auto-save",
                  "Estimates save immediately, with a short Undo option for new meals.",
                ],
              ] as const
            ).map(([value, label, description]) => (
              <label
                key={value}
                className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-[var(--app-line)] p-4"
              >
                <input
                  type="radio"
                  name="save-mode"
                  value={value}
                  checked={mode === value}
                  onChange={() => setMode(value)}
                  className="mt-1 accent-[var(--app-accent)]"
                />
                <span>
                  <span className="block text-sm font-medium">{label}</span>
                  <span className="mt-1 block text-sm leading-6 text-muted-foreground">
                    {description}
                  </span>
                </span>
              </label>
            ))}
            <button
              className={`${action} mt-3 w-full bg-[var(--app-accent)] text-background`}
              type="submit"
            >
              {busy ? "Finishing setup…" : "Finish setup"}
            </button>
          </fieldset>
        </form>
      )}
      {error && (
        <p role="alert" className="mt-4 text-sm">
          {error}
        </p>
      )}
      {step > 0 && (
        <button
          type="button"
          disabled={busy}
          className="chat-text-button mt-5"
          onClick={() => move(step - 1)}
        >
          Back
        </button>
      )}
    </section>
  );
}
