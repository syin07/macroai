"use client";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { AppShell } from "@/components/shared/app-shell";
import { SettingsScreen } from "@/components/settings/settings-screen";
import { mockApi } from "@/mocks/server";

export function SettingsPreview() {
  const client = useQueryClient();
  const [notice, setNotice] = useState("");
  return (
    <>
      <AppShell>
        <SettingsScreen />
      </AppShell>
      <details className="fixed right-2 top-1 z-40 max-w-[280px] rounded-lg border bg-background p-1 text-xs">
        <summary className="min-h-11 cursor-pointer p-3">
          Settings preview controls
        </summary>
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
          className="min-h-11 px-2"
          onClick={() => {
            mockApi.reset(205);
            void client.resetQueries();
            setNotice("Mock account reset");
          }}
        >
          Reset mock account
        </button>
        <p role="status" className="p-2">
          {notice}
        </p>
      </details>
    </>
  );
}
