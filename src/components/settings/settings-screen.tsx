"use client";
import { HeaderLink, PageFrame } from "@/components/shared/page-frame";
import { PreferencesSettings } from "./preferences-settings";
import { GoalsSettings } from "./goals-settings";
import { MemoriesSettings } from "./memories-settings";
import { DataSettings, AccountSettings } from "./data-account-settings";

export function SettingsScreen() {
  return (
    <PageFrame
      title="Settings"
      description="Your preferences, goals, and account."
      action={<HeaderLink href="/chat">Open chat</HeaderLink>}
    >
      <div className="mt-2 [&_button:focus-visible]:outline-2 [&_button:focus-visible]:outline-[var(--app-accent)]">
        <PreferencesSettings />
        <GoalsSettings />
        <MemoriesSettings />
        <DataSettings />
        <AccountSettings />
      </div>
    </PageFrame>
  );
}
