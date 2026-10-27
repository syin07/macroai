"use client";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/shared/app-shell";
import { OnboardingScreen } from "@/components/onboarding/onboarding-screen";
import { ThemePreview } from "./theme-preview";
import { mockApi } from "@/mocks/server";

export function OnboardingPreview() {
  const client = useQueryClient();
  const [finished, setFinished] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [notice, setNotice] = useState("");
  return (
    <>
      <AppShell>
        {finished ? (
          <div role="status" className="p-8">
            Setup complete. The app now opens Chat.
          </div>
        ) : (
          <OnboardingScreen
            key={generation}
            onFinished={() => setFinished(true)}
          />
        )}
      </AppShell>
      <details className="fixed right-2 top-1 z-40 max-w-[280px] rounded-lg border bg-background p-1 text-xs">
        <summary className="min-h-11 cursor-pointer p-3">
          Onboarding preview controls
        </summary>
        <ThemePreview />
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
          onClick={async () => {
            await client.cancelQueries();
            client.clear();
            mockApi.reset();
            setFinished(false);
            setGeneration((value) => value + 1);
            setNotice("Mock setup reset");
          }}
        >
          Reset setup
        </button>
        <p role="status" className="p-2">
          {notice}
        </p>
      </details>
    </>
  );
}
