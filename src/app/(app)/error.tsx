"use client";
import { PageFrame } from "@/components/shared/page-frame";
import { action } from "@/components/settings/settings-shared";

export default function AppError({ reset }: { reset: () => void }) {
  return (
    <PageFrame title="Let’s try that again">
      <div role="alert" className="mt-8 space-y-4 text-sm">
        <p>This page couldn’t open. Check your connection, then try again.</p>
        <button className={action} onClick={reset}>
          Retry page
        </button>
      </div>
    </PageFrame>
  );
}
