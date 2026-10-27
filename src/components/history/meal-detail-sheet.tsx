"use client";

import { useEffect, useState, type RefObject } from "react";
import { ApiClientError } from "@/lib/api";
import { useMeal, useMealActions } from "@/hooks/use-api";
import { MealCard } from "@/components/meals/meal-card";
import { MealActions } from "@/components/meals/meal-actions";
import { MealEditor } from "@/components/meals/meal-editor";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { X } from "lucide-react";

export function MealDetailSheet({
  id,
  timezone,
  onClose,
  returnFocus,
}: {
  id: string;
  timezone: string;
  onClose: () => void;
  returnFocus: RefObject<HTMLElement | null>;
}) {
  const detail = useMeal(id);
  const action = useMealActions()[id];
  const [editing, setEditing] = useState<number | "meal" | null>(null);
  const [mobile, setMobile] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 767px)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => setMobile(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const serverMeal = detail.data;
  const meal =
    action?.meal === null
      ? null
      : action?.meal &&
          (!serverMeal || action.meal.version >= serverMeal.version)
        ? action.meal
        : serverMeal;
  const missing =
    meal === null ||
    meal?.status === "pending_deletion" ||
    (detail.error instanceof ApiClientError &&
      detail.error.code === "not_found");
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && editing === null && !action?.busy) onClose();
      }}
    >
      <SheetContent
        side={mobile ? "bottom" : "right"}
        showCloseButton={false}
        finalFocus={() =>
          returnFocus.current?.isConnected
            ? returnFocus.current
            : document.querySelector<HTMLElement>(
                ".history-screen button[aria-label^='View '], .history-screen a",
              )
        }
        className="meal-card-group max-h-[90dvh] rounded-t-2xl px-5 pb-[max(20px,env(safe-area-inset-bottom))] pt-5 data-[side=right]:w-full data-[side=right]:max-w-lg data-[side=right]:rounded-none data-[side=right]:max-h-dvh"
      >
        <div className="flex shrink-0 items-start justify-between gap-3">
          <div>
            <SheetTitle>Meal details</SheetTitle>
            <SheetDescription>
              Saved portions, nutrition, and sources.
            </SheetDescription>
          </div>
          <button
            type="button"
            aria-label="Close meal details"
            disabled={!!action?.busy || editing !== null}
            onClick={onClose}
            className="editor-icon-button"
          >
            <X size={18} />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto overscroll-contain">
          {missing ? (
            <p role="status" className="py-6 text-sm">
              This meal is no longer available.
            </p>
          ) : detail.isPending && !meal ? (
            <p
              role="status"
              className="min-h-56 py-6 text-sm text-muted-foreground"
            >
              Loading meal…
            </p>
          ) : detail.isError && !meal ? (
            <div role="alert" className="py-6">
              <p>This meal couldn’t load.</p>
              <button
                className="chat-text-button"
                onClick={() => void detail.refetch()}
              >
                Retry meal
              </button>
            </div>
          ) : meal ? (
            <>
              {detail.isError && (
                <p role="alert" className="text-sm">
                  Showing the last saved meal.{" "}
                  <button
                    className="chat-text-button"
                    onClick={() => void detail.refetch()}
                  >
                    Retry meal
                  </button>
                </p>
              )}
              <MealCard
                key={meal.id}
                card={{ kind: "meal", meal_id: id, meal }}
                timezone={timezone}
                defaultExpanded
                onEdit={() => setEditing("meal")}
                onEditItem={setEditing}
                busy={!!action?.busy}
                actions={<MealActions id={id} onDeleted={onClose} />}
              />
            </>
          ) : null}
        </div>
        {editing !== null && meal && (
          <MealEditor
            target={{ kind: "meal", meal }}
            initialItem={typeof editing === "number" ? editing : undefined}
            onSaved={() => {}}
            onClose={() => setEditing(null)}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}
