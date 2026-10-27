"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { HistoryScreen } from "@/components/history/history-screen";
import { AppShell } from "@/components/shared/app-shell";
import { mockApi } from "@/mocks/server";
import { ThemePreview } from "./theme-preview";

export function HistoryPreview() {
  const client = useQueryClient();
  const [notice, setNotice] = useState("");
  function reset(count: number) {
    mockApi.reset(count);
    client.setQueryData(["meal-actions"], {});
    void client.resetQueries();
    setNotice(count ? "205 meals ready" : "Empty log ready");
  }
  return (
    <>
      <AppShell>
        <HistoryScreen />
      </AppShell>
      <details className="fixed right-2 top-1 z-40 max-w-[300px] rounded-lg border bg-background p-1 text-xs">
        <summary className="min-h-11 cursor-pointer p-3">
          History preview controls
        </summary>
        <ThemePreview />
        <div className="flex flex-wrap gap-2 p-2">
          <button className="min-h-11 px-2" onClick={() => reset(205)}>
            Reset 205 meals
          </button>
          <button className="min-h-11 px-2" onClick={() => reset(0)}>
            Empty log
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
        </div>
        <p role="status" className="p-2">
          {notice}
        </p>
      </details>
    </>
  );
}
