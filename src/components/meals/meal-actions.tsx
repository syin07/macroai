"use client";

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useDeleteMeal,
  useMealActions,
  useUndoDelete,
  type MealActionState,
} from "@/hooks/use-api";

function useClock(deadline?: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!deadline) return;
    const tick = () => {
      const time = Date.now();
      setNow(time);
      if (time >= deadline) {
        clearInterval(timer);
        document.removeEventListener("visibilitychange", visibility);
      }
    };
    const timer = setInterval(tick, 250);
    const visibility = () => tick();
    document.addEventListener("visibilitychange", visibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [deadline]);
  return now;
}

export function MealActions({
  id,
  disabled = false,
  onDeleted,
}: {
  id: string;
  disabled?: boolean;
  onDeleted?: () => void;
}) {
  const state = useMealActions()[id];
  const remove = useDeleteMeal();
  const now = useClock(state?.autoUntil);
  const recent = !!state?.autoUntil && state.autoUntil > now;
  if (state?.meal === null) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {recent && <span className="text-xs text-muted-foreground">Saved ·</span>}
      <button
        type="button"
        className="chat-text-button"
        disabled={disabled || !!state?.busy || remove.isPending}
        onClick={async () => {
          try {
            await remove.mutateAsync(id);
            onDeleted?.();
          } catch {
            /* Error and retry remain beside the action. */
          }
        }}
      >
        {state?.busy === "delete"
          ? "Deleting…"
          : recent
            ? "Undo"
            : state?.error
              ? "Retry delete"
              : "Delete meal"}
      </button>
      {state?.error && (
        <p role="alert" className="w-full text-sm">
          {state.error}
        </p>
      )}
    </div>
  );
}

function UndoNotice({ id }: { id: string }) {
  const client = useQueryClient();
  const state = useMealActions()[id];
  const restore = useUndoDelete();
  const now = useClock(state?.undoUntil);
  if (!state?.undoUntil) return null;
  if (state.undoUntil <= now && !state.busy) {
    if (!state.error) return null;
    return (
      <div className="rounded-xl border border-[var(--app-line)] bg-background p-4 shadow-sm">
        <p role="alert" className="text-sm">
          The undo window ended. This meal remains deleted.
        </p>
        <button
          className="chat-text-button"
          onClick={() =>
            client.setQueryData<Record<string, MealActionState>>(
              ["meal-actions"],
              (old) => ({ ...old, [id]: { ...old?.[id], error: undefined } }),
            )
          }
        >
          Dismiss
        </button>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-[var(--app-line)] bg-background px-4 py-2 shadow-sm">
      <div className="flex items-center justify-between gap-4">
        <span className="text-sm" role="status">
          Meal deleted
        </span>
        <button
          type="button"
          className="chat-text-button"
          disabled={!!state.busy || state.undoUntil <= now}
          onClick={() => {
            void restore.mutateAsync(id).catch(() => {});
          }}
        >
          {state.busy === "undo"
            ? "Restoring…"
            : state.error
              ? "Retry undo"
              : "Undo"}
        </button>
      </div>
      {state.error && (
        <p role="alert" className="text-sm">
          {state.error}
        </p>
      )}
    </div>
  );
}

/** Kept above navigation so delete Undo survives route changes and stacked deletions. */
export function MealUndoNotices() {
  const actions = useMealActions();
  return (
    <aside
      aria-label="Meal deletion notifications"
      className="pointer-events-none fixed inset-x-4 bottom-[calc(88px+env(safe-area-inset-bottom))] z-[70] mx-auto max-h-[40dvh] max-w-sm overflow-y-auto md:bottom-6 md:left-auto md:right-6"
    >
      <div className="pointer-events-auto space-y-2">
        {Object.keys(actions).map((id) => (
          <UndoNotice key={id} id={id} />
        ))}
      </div>
    </aside>
  );
}
