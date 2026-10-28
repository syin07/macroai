"use client";
import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { usePatchPreferences, usePreferences } from "@/hooks/use-api";
import { patchPreferencesRequestSchema } from "@/lib/validation/preferences";
import type { PatchPreferencesRequest } from "@/types/api";
import {
  action,
  control,
  QueryNotice,
  SettingsSection,
} from "./settings-shared";

export function PreferencesSettings() {
  const preferences = usePreferences();
  const save = usePatchPreferences();
  const { setTheme } = useTheme();
  const [draft, setDraft] = useState<PatchPreferencesRequest | null>(null);
  const [notice, setNotice] = useState("");
  const [detected] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
  );
  const values = { ...preferences.data, ...draft };
  useEffect(() => {
    if (preferences.data) setTheme(preferences.data.theme);
  }, [preferences.data, setTheme]);
  const zones = [
    ...new Set([
      values.timezone || detected,
      detected,
      "UTC",
      ...(typeof Intl.supportedValuesOf === "function"
        ? Intl.supportedValuesOf("timeZone")
        : []),
    ]),
  ].sort();
  function change(patch: PatchPreferencesRequest) {
    setDraft((old) => ({ ...old, ...patch }));
    setNotice("");
    save.reset();
  }
  if (!preferences.data)
    return (
      <SettingsSection title="Preferences">
        <QueryNotice
          pending={preferences.isPending}
          error={preferences.isError}
          retry={() => void preferences.refetch()}
        />
      </SettingsSection>
    );
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        if (save.isPending || !draft) return;
        const checked = patchPreferencesRequestSchema.safeParse(draft);
        if (!checked.success) {
          setNotice("Choose valid preferences and a time zone.");
          return;
        }
        try {
          const result = await save.mutateAsync(checked.data);
          setTheme(result.theme);
          setDraft(null);
          setNotice("Preferences saved.");
        } catch {
          /* Keep selections for retry. */
        }
      }}
    >
      <fieldset disabled={save.isPending}>
        <SettingsSection
          title="Appearance"
          description="Follow your device or choose a theme."
        >
          <label className="block text-sm">
            Theme
            <select
              aria-label="Theme"
              className={`${control} mt-2`}
              value={values.theme}
              onChange={(event) =>
                change({
                  theme: event.target.value as "system" | "light" | "dark",
                })
              }
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
        </SettingsSection>
        <SettingsSection
          title="Logging"
          description="Choose when new meal estimates become saved records."
        >
          <label className="block text-sm">
            Save mode
            <select
              aria-label="Save mode"
              className={`${control} mt-2`}
              value={values.save_mode}
              onChange={(event) =>
                change({ save_mode: event.target.value as "confirm" | "auto" })
              }
            >
              <option value="confirm">Confirm before saving</option>
              <option value="auto">Auto-save</option>
            </select>
          </label>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {values.save_mode === "auto"
              ? "Estimates save immediately. A short Undo option lets you remove a new meal."
              : "Review a meal and tap Save before it counts toward your day."}
          </p>
        </SettingsSection>
        <SettingsSection
          title="Time zone"
          description="Meal dates and daily totals follow this time zone."
        >
          <label className="block text-sm">
            Time zone
            <select
              aria-label="Time zone"
              className={`${control} mt-2`}
              value={values.timezone || detected}
              onChange={(event) => change({ timezone: event.target.value })}
            >
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="chat-text-button mt-2"
            onClick={() => change({ timezone: detected })}
          >
            Use detected: {detected}
          </button>
        </SettingsSection>
        <div className="flex flex-wrap items-center gap-3 py-4">
          <button type="submit" className={action} disabled={!draft}>
            {save.isPending
              ? "Saving preferences…"
              : save.isError
                ? "Retry preferences"
                : "Save preferences"}
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
              Cancel changes
            </button>
          )}
        </div>
      </fieldset>
      {(notice || save.isError) && (
        <p role={save.isError ? "alert" : "status"} className="pb-3 text-sm">
          {save.error?.message || notice}
        </p>
      )}
      {preferences.isError && (
        <p role="alert" className="text-sm">
          Showing your last saved preferences.{" "}
          <button
            className="chat-text-button"
            onClick={() => void preferences.refetch()}
          >
            Refresh preferences
          </button>
        </p>
      )}
    </form>
  );
}
