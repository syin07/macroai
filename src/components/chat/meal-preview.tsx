import type { MealCard } from "@/types/api";

// A5's read-only content; save/edit/discard controls belong to A6/A7.
export function MealPreview({ card }: { card: MealCard }) {
  if (card.kind === "meal" && !card.meal)
    return (
      <p className="text-sm text-muted-foreground">This meal was deleted.</p>
    );
  if (card.kind === "proposal" && card.state === "discarded")
    return <p className="text-sm text-muted-foreground">Discarded</p>;
  const meal = card.kind === "proposal" ? card.proposal : card.meal!;
  return (
    <section
      className="mt-3 rounded-2xl border border-[var(--app-line)] bg-[var(--app-surface)] p-4"
      aria-label={meal.name}
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-medium">{meal.name}</h3>
        <span className="shrink-0 text-xs text-muted-foreground">
          {card.kind === "meal" ? "Saved" : "Not saved"}
        </span>
      </div>
      <p className="mt-3 tabular-nums">
        <strong className="text-2xl font-semibold tracking-tight">
          {Math.round(meal.totals.calories)}
        </strong>{" "}
        <span className="text-sm text-muted-foreground">kcal</span>
      </p>
      <p className="mt-1 text-sm tabular-nums text-muted-foreground">
        P {meal.totals.protein_g} g · C {meal.totals.carbs_g} g · F{" "}
        {meal.totals.fat_g} g
      </p>
      {card.kind === "proposal" && card.proposal.clarification_question && (
        <p className="mt-3 text-sm">{card.proposal.clarification_question}</p>
      )}
    </section>
  );
}
