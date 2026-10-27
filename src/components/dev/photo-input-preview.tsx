"use client";
import { useQueryClient } from "@tanstack/react-query";
import { ChatScreen } from "@/components/chat/chat-screen";
import { AppShell } from "@/components/shared/app-shell";
import { mockApi } from "@/mocks/server";
import { ThemePreview } from "./theme-preview";

export function PhotoInputPreview() {
  const client = useQueryClient();
  return (
    <>
      <AppShell>
        <ChatScreen />
      </AppShell>
      <details
        aria-label="Photo preview controls"
        className="fixed right-2 top-1 z-50 max-w-[300px] rounded-lg border bg-background p-1 text-xs"
      >
        <summary className="min-h-11 cursor-pointer p-3">
          Photo preview controls
        </summary>
        <ThemePreview />
        <button
          className="min-h-11 px-2"
          onClick={() => mockApi.failNext("ai_unavailable")}
        >
          Fail next send
        </button>
        <button
          className="min-h-11 px-2"
          onClick={() => {
            mockApi.reset(0);
            void client.resetQueries();
          }}
        >
          Reset preview
        </button>
      </details>
    </>
  );
}
