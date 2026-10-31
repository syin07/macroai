"use client";
import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useMe } from "@/hooks/use-api";
import { action } from "@/components/settings/settings-shared";
import { AppLoadingScreen } from "@/components/shared/app-loading-screen";

/** Runs only inside authenticated app routes, never public auth/preview pages. */
export function OnboardingGate({ children }: { children: ReactNode }) {
  const me = useMe();
  const path = usePathname();
  const router = useRouter();
  const destination = me.data
    ? !me.data.onboarding_complete && path !== "/onboarding"
      ? "/onboarding"
      : me.data.onboarding_complete && path === "/onboarding"
        ? "/today"
        : null
    : null;
  useEffect(() => {
    if (destination) router.replace(destination);
  }, [destination, router]);
  if ((!me.data && !me.isError) || destination) return <AppLoadingScreen />;
  if (!me.data)
    return (
      <main className="mx-auto max-w-lg px-5 py-16">
        {me.isError && !me.data ? (
          <div role="alert">
            <p className="mb-4">
              Your account couldn’t load. Please try again.
            </p>
            <button className={action} onClick={() => void me.refetch()}>
              Retry account
            </button>
          </div>
        ) : null}
      </main>
    );
  return children;
}
