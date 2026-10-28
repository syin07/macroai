"use client";
import { usePathname } from "next/navigation";
import { AppShell } from "./app-shell";
import { PageFrame } from "./page-frame";
import { LoadingSkeleton } from "./loading-skeleton";

export function AppLoadingScreen() {
  const path = usePathname();
  const title =
    path === "/history"
      ? "History"
      : path === "/insights"
        ? "Insights"
        : path === "/settings"
          ? "Settings"
          : path === "/onboarding"
            ? "Make it yours"
            : "Chat";
  return (
    <AppShell>
      <PageFrame title={title}>
        <LoadingSkeleton
          label="Getting your account ready…"
          kind={
            title === "Chat"
              ? "chat"
              : title === "Insights" || title === "History"
                ? "rows"
                : "form"
          }
          rows={title === "Insights" ? 7 : 3}
          className="mt-8 min-h-80"
        />
      </PageFrame>
    </AppShell>
  );
}
