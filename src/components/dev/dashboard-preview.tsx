"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChatScreen } from "@/components/chat/chat-screen";
import { AppShell } from "@/components/shared/app-shell";
import { getDaily, patchPreferences, putGoals } from "@/lib/api";
import { applyDailySummaries } from "@/hooks/use-api";
import { mockApi } from "@/mocks/server";
import { ThemePreview } from "./theme-preview";

export function DashboardPreview() {
  const client = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  async function configure(change: () => Promise<unknown>, message: string) {
    setBusy(true);
    try {
      await change();
      applyDailySummaries(client, [await getDaily()]);
      setNotice(message);
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Preview change failed. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <AppShell>
        <ChatScreen />
      </AppShell>
      <details className="fixed right-2 top-1 z-50 max-w-[300px] rounded-lg border bg-background p-1 text-xs">
        <summary className="min-h-11 cursor-pointer p-3">
          Dashboard preview controls
        </summary>
        <ThemePreview />
        <div className="flex flex-wrap gap-2 p-2">
          <button
            disabled={busy}
            className="min-h-11 px-2"
            onClick={() =>
              void configure(
                () => patchPreferences({ save_mode: "auto" }),
                "Auto-save enabled",
              )
            }
          >
            Auto-save mode
          </button>
          <button
            disabled={busy}
            className="min-h-11 px-2"
            onClick={() =>
              void configure(
                () => patchPreferences({ save_mode: "confirm" }),
                "Confirm mode enabled",
              )
            }
          >
            Confirm mode
          </button>
          <button
            disabled={busy}
            className="min-h-11 px-2"
            onClick={() =>
              void configure(async () => {
                const daily = await getDaily();
                if (daily.consumed.calories < 920)
                  throw new Error(
                    "Log at least 920 kcal before using this example.",
                  );
                await putGoals({
                  calories: Math.max(0, daily.consumed.calories - 120),
                  protein_g: 50,
                  carbs_g: 100,
                  fat_g: 40,
                });
              }, "Over-target example ready")
            }
          >
            Over-target example
          </button>
          <button
            className="min-h-11 px-2"
            onClick={() => {
              mockApi.failNext("internal");
              setNotice("Next API action will fail");
            }}
          >
            Fail next action
          </button>
          <button
            disabled={busy}
            className="min-h-11 px-2"
            onClick={() => {
              mockApi.reset(0);
              client.removeQueries({ queryKey: ["manual-messages"] });
              client.removeQueries({ queryKey: ["received-turn"] });
              client.setQueryData(["meal-actions"], {});
              void client.resetQueries();
              setNotice("Empty preview reset");
            }}
          >
            Reset empty preview
          </button>
        </div>
        <p role="status" className="p-2">
          {busy ? "Updating preview…" : notice}
        </p>
      </details>
    </>
  );
}
