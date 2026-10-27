"use client";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { InsightsScreen } from "@/components/insights/insights-screen";
import { AppShell } from "@/components/shared/app-shell";
import { mockApi } from "@/mocks/server";
import { ThemePreview } from "./theme-preview";

export function InsightsPreview() {
  const client = useQueryClient();
  const [notice, setNotice] = useState("");
  return (
    <>
      <AppShell>
        <InsightsScreen />
      </AppShell>
      <details className="fixed right-2 top-1 z-40 max-w-[300px] rounded-lg border bg-background p-1 text-xs">
        <summary className="min-h-11 cursor-pointer p-3">
          Insights preview controls
        </summary>
        <ThemePreview />
        {[
          [205, "Reset 205 meals"],
          [0, "Empty log"],
          [1, "One recorded day"],
        ].map(([count, label]) => (
          <button
            key={label}
            className="min-h-11 px-2"
            onClick={async () => {
              await client.cancelQueries();
              mockApi.reset(Number(count));
              client.setQueryData(["meal-actions"], {});
              await client.resetQueries();
              setNotice(String(label));
            }}
          >
            {label}
          </button>
        ))}
        <button
          className="min-h-11 px-2"
          onClick={async () => {
            await client.cancelQueries();
            mockApi.failNext("validation_error");
            void client.refetchQueries({ queryKey: ["meals"] });
            setNotice("Refreshing recorded days with a simulated failure");
          }}
        >
          Fail recorded-day refresh
        </button>
        <button
          className="min-h-11 px-2"
          onClick={async () => {
            await client.cancelQueries();
            mockApi.failNext("validation_error");
            void client.refetchQueries({ queryKey: ["daily"] });
            setNotice("Refreshing daily totals with a simulated failure");
          }}
        >
          Fail daily-total refresh
        </button>
        <p role="status" className="p-2">
          {notice}
        </p>
      </details>
    </>
  );
}
