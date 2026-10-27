"use client";

import { useId, useState } from "react";
import { Check, ChevronDown, ExternalLink } from "lucide-react";
import type {
  Macros,
  MealCard as MealCardData,
  NutritionSource,
} from "@/types/api";

const sources: Record<NutritionSource, string> = {
  usda: "USDA",
  open_food_facts: "Open Food Facts",
  label: "Label",
  web: "Web",
  ai: "AI estimate",
  manual: "Manual",
};
function sourceUrl(reference: string | null) {
  if (!reference) return null;
  try {
    const url = new URL(reference);
    return ["https:", "http:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
const number = (value: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 }).format(value);
function MacroLine({ macros }: { macros: Macros }) {
  return (
    <p className="text-sm tabular-nums text-muted-foreground">
      P {number(macros.protein_g)} g · C {number(macros.carbs_g)} g · F{" "}
      {number(macros.fat_g)} g
    </p>
  );
}

export function MealCard({
  card,
  timezone = "UTC",
  busy = false,
  locked = false,
  saving = false,
  onSave,
  onEdit,
  onDiscard,
  onClarify,
}: {
  card: MealCardData;
  timezone?: string;
  busy?: boolean;
  locked?: boolean;
  saving?: boolean;
  onSave?: () => void;
  onEdit?: () => void;
  onDiscard?: () => void;
  onClarify?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  if (
    card.kind === "meal" &&
    (!card.meal || card.meal.status === "pending_deletion")
  )
    return (
      <p className="mt-3 rounded-xl border border-[var(--app-line)] px-4 py-3 text-sm text-muted-foreground">
        This meal was deleted.
      </p>
    );
  if (card.kind === "proposal" && card.state === "discarded")
    return (
      <p className="mt-3 rounded-xl bg-[var(--app-surface)] px-4 py-3 text-sm text-muted-foreground">
        Discarded · {card.proposal.name}
      </p>
    );
  const meal = card.kind === "proposal" ? card.proposal : card.meal!;
  const unsaved = card.kind === "proposal";
  const clarification = unsaved && card.proposal.needs_clarification;
  const estimated = meal.items.some(
    (item) => item.nutrition_source === "ai" || item.inferred,
  );
  let consumedAt: string;
  try {
    consumedAt = new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone,
    }).format(new Date(meal.consumed_at));
  } catch {
    consumedAt = meal.consumed_at;
  }
  return (
    <section
      aria-label={meal.name}
      className={`meal-card mt-3 overflow-hidden rounded-2xl border bg-[var(--app-surface)] ${unsaved ? "border-dashed border-[var(--app-accent)]/40" : "border-[var(--app-line)]"}`}
    >
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={expanded ? detailsId : undefined}
        aria-label={`${expanded ? "Collapse" : "Expand"} ${meal.name}`}
        className="block w-full p-4 text-left"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-start justify-between gap-3">
          <h3 className="min-w-0 break-words font-medium">{meal.name}</h3>
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            {unsaved ? (
              "Not saved"
            ) : (
              <>
                <Check size={14} aria-hidden="true" />
                <span>Saved</span>
              </>
            )}
            <ChevronDown
              size={16}
              aria-hidden="true"
              className={expanded ? "rotate-180" : ""}
            />
          </span>
        </div>
        <div className="mt-3 flex items-baseline gap-2 tabular-nums">
          <strong className="text-[28px] leading-tight font-semibold tracking-tight">
            {number(meal.totals.calories)}
          </strong>
          <span className="text-sm text-muted-foreground">kcal</span>
          {estimated && (
            <span className="ml-auto text-xs text-muted-foreground">
              Estimated
            </span>
          )}
        </div>
        <div className="mt-1">
          <MacroLine macros={meal.totals} />
        </div>
      </button>
      {expanded && (
        <div
          id={detailsId}
          className="border-t border-[var(--app-line)] px-4 pb-4"
        >
          <p className="py-4 text-xs text-muted-foreground">
            Consumed <time dateTime={meal.consumed_at}>{consumedAt}</time> ·{" "}
            {timezone}
          </p>
          <ul className="space-y-4">
            {meal.items.map((item, index) => {
              const url = sourceUrl(item.source_reference);
              return (
                <li
                  key={item.id ?? index}
                  className="border-b border-[var(--app-line)] pb-4 last:border-0 last:pb-0"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p
                      className={`min-w-0 break-words text-sm font-medium ${item.inferred ? "text-muted-foreground" : ""}`}
                    >
                      {item.food_name}
                      {item.inferred && (
                        <span className="ml-2 text-xs font-normal">
                          Assumed
                        </span>
                      )}
                    </p>
                    <p className="shrink-0 text-sm tabular-nums">
                      {number(item.macros.calories)} kcal
                    </p>
                  </div>
                  <p className="mt-1 flex flex-wrap items-center gap-1 text-sm tabular-nums text-muted-foreground">
                    {number(item.quantity)} {item.unit}
                    {item.grams !== null && ` · ${number(item.grams)} g`}
                    {item.confidence === "low" && (
                      <span className="inline-flex items-center gap-1 text-xs">
                        <span
                          aria-hidden="true"
                          className="ml-1 size-1.5 rounded-full bg-current"
                        />
                        Portion uncertain
                      </span>
                    )}
                  </p>
                  <div className="mt-1">
                    <MacroLine macros={item.macros} />
                  </div>
                  {url ? (
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="app-text-link inline-flex min-h-11 items-center gap-1 text-xs"
                      aria-label={`${sources[item.nutrition_source]} source for ${item.food_name} (opens in new tab)`}
                    >
                      {sources[item.nutrition_source]}
                      <ExternalLink size={12} aria-hidden="true" />
                    </a>
                  ) : (
                    <span className="mt-2 inline-block rounded-md border border-[var(--app-line)] px-2 py-1 text-xs text-muted-foreground">
                      {sources[item.nutrition_source]}
                    </span>
                  )}
                  {item.assumptions && (
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {item.assumptions}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="mt-4 border-t border-[var(--app-line)] pt-3">
            <p className="mb-1 text-sm font-medium tabular-nums">
              Total · {number(meal.totals.calories)} kcal
            </p>
            <MacroLine macros={meal.totals} />
          </div>
        </div>
      )}
      {unsaved && (
        <div className="border-t border-[var(--app-line)] px-4 py-2">
          {clarification && (
            <button
              type="button"
              className="app-text-link mb-1 min-h-11 w-full py-2 text-left text-sm"
              disabled={busy || locked}
              onClick={onClarify}
            >
              {card.proposal.clarification_question ||
                "Tell me a little more about this meal."}
              <span className="mt-1 block text-xs text-muted-foreground">
                Reply in chat
              </span>
            </button>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onSave}
              disabled={busy || locked || clarification || !onSave}
              className="min-h-11 rounded-lg bg-[var(--app-accent)] px-4 text-sm font-medium text-background"
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={onEdit}
              disabled={busy || locked || !onEdit}
              className="chat-text-button px-3"
            >
              Edit
            </button>
            <button
              type="button"
              onClick={onDiscard}
              disabled={busy || locked || !onDiscard}
              className="ml-auto min-h-11 px-2 text-sm text-muted-foreground"
            >
              Discard
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
