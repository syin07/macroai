"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiClientError, createSaveAction } from "@/lib/api";
import { useDaily, useSaveMeals, useMealActions } from "@/hooks/use-api";
import { MealActions } from "./meal-actions";
import type {
  ChatMessage,
  Meal,
  MealCard as MealCardData,
  MealProposal,
  SaveMealInput,
  MealSourceType,
} from "@/types/api";
import { useState } from "react";
import { MealCard } from "./meal-card";
import { MealEditor, type EditorTarget } from "./meal-editor";

type ProposalUi = {
  discarded?: boolean;
  proposal?: MealProposal;
  saved?: Meal;
};
type CardUi = {
  proposals: Record<string, ProposalUi>;
  action: ReturnType<typeof createSaveAction> | null;
  pending: boolean;
  error: string | null;
  canRevise: boolean;
  meals?: Record<string, Meal>;
};
const emptyUi: CardUi = {
  proposals: {},
  action: null,
  pending: false,
  error: null,
  canRevise: false,
};

export function MessageMealCards({
  message,
  onClarify,
  sourceType = message.had_image ? "photo" : "text",
  onLoadContext,
  loadingContext = false,
}: {
  message: ChatMessage;
  onClarify: () => void;
  sourceType?: MealSourceType | null;
  onLoadContext?: () => void;
  loadingContext?: boolean;
}) {
  const client = useQueryClient();
  const key = ["proposal-ui", message.id];
  // Browser-memory UI state only. Auth sign-out clears this with the private query cache.
  // The API has no discard endpoint; a full reload restores the server's proposal state.
  const ui = useQuery({
    queryKey: key,
    queryFn: () => emptyUi,
    initialData: emptyUi,
    enabled: false,
    gcTime: Infinity,
    staleTime: Infinity,
  }).data;
  const update = (change: (old: CardUi) => CardUi) =>
    client.setQueryData<CardUi>(key, (old) => change(old ?? emptyUi));
  const save = useSaveMeals();
  const daily = useDaily();
  const mealActions = useMealActions();
  const [editing, setEditing] = useState<{
    target: EditorTarget;
    item?: number;
  } | null>(null);
  const cards: MealCardData[] = message.cards
    .map<MealCardData>((card) => {
      if (card.kind !== "proposal") {
        const local = ui.meals?.[card.meal_id];
        return card.meal && local && local.version > card.meal.version
          ? { ...card, meal: local }
          : card;
      }
      const local = ui.proposals[card.proposal.proposal_id];
      if (local?.saved)
        return { kind: "meal", meal_id: local.saved.id, meal: local.saved };
      return {
        ...card,
        state: local?.discarded ? "discarded" : card.state,
        proposal: local?.proposal ?? card.proposal,
      };
    })
    .map((card) =>
      card.kind === "meal" &&
      mealActions[card.meal_id]?.meal !== undefined &&
      (mealActions[card.meal_id].meal === null ||
        !card.meal ||
        mealActions[card.meal_id].meal!.version >= card.meal.version)
        ? { ...card, meal: mealActions[card.meal_id].meal ?? null }
        : card,
    );
  const ready = [
    ...new Map(
      cards.flatMap((card) =>
        card.kind === "proposal" &&
        card.state === "unsaved" &&
        !card.proposal.needs_clarification
          ? [[card.proposal.proposal_id, card.proposal] as const]
          : [],
      ),
    ).values(),
  ];

  async function commit(proposals?: MealProposal[]) {
    const current = client.getQueryData<CardUi>(key) ?? emptyUi;
    if (current.pending || (!current.action && !sourceType)) return;
    const meals: SaveMealInput[] = (proposals ?? []).map((proposal) => ({
      proposal_id: proposal.proposal_id,
      name: proposal.name,
      consumed_at: proposal.consumed_at,
      source_type: sourceType ?? "text", // Only an existing retry may run without loaded context.
      items: proposal.items.map(({ id, ...item }) => {
        void id;
        return item;
      }),
    }));
    const action = current.action ?? createSaveAction({ meals });
    if (!action.body.meals.length) return;
    update((old) => ({
      ...old,
      action,
      pending: true,
      error: null,
      canRevise: false,
    }));
    try {
      const result = await save.mutateAsync(action);
      update((old) => {
        const next = { ...old.proposals };
        action.body.meals.forEach((input, index) => {
          if (input.proposal_id && result.meals[index])
            next[input.proposal_id] = {
              ...next[input.proposal_id],
              saved: result.meals[index],
            };
        });
        return {
          ...old,
          proposals: next,
          action: null,
          pending: false,
          error: null,
        };
      });
    } catch (error) {
      update((old) => ({
        ...old,
        pending: false,
        error:
          error instanceof Error
            ? error.message
            : "This meal couldn’t save. Retry to keep the same request.",
        canRevise:
          error instanceof ApiClientError && error.code === "validation_error",
      }));
    }
  }

  return (
    <div aria-label="Meal cards" className="meal-card-group">
      {cards.map((card) => (
        <MealCard
          key={
            card.kind === "proposal" ? card.proposal.proposal_id : card.meal_id
          }
          card={card}
          actions={
            card.kind === "meal" ? (
              <MealActions
                id={card.meal_id}
                disabled={ui.pending || !!ui.action}
              />
            ) : undefined
          }
          timezone={daily.data?.timezone}
          busy={ui.pending}
          locked={!!ui.action}
          saving={
            ui.pending &&
            card.kind === "proposal" &&
            !!ui.action?.body.meals.some(
              (meal) => meal.proposal_id === card.proposal.proposal_id,
            )
          }
          onSave={
            card.kind === "proposal" && sourceType
              ? () => void commit([card.proposal])
              : undefined
          }
          onEdit={
            card.kind === "proposal"
              ? sourceType
                ? () =>
                    setEditing({
                      target: {
                        kind: "proposal",
                        proposal: card.proposal,
                        sourceType,
                      },
                    })
                : undefined
              : card.meal
                ? () =>
                    setEditing({ target: { kind: "meal", meal: card.meal! } })
                : undefined
          }
          onEditItem={
            card.kind === "proposal" && !sourceType
              ? undefined
              : (item) => {
                  if (card.kind === "proposal")
                    setEditing({
                      target: {
                        kind: "proposal",
                        proposal: card.proposal,
                        sourceType,
                      },
                      item,
                    });
                  else if (card.meal)
                    setEditing({
                      target: { kind: "meal", meal: card.meal },
                      item,
                    });
                }
          }
          onDiscard={
            card.kind === "proposal"
              ? () =>
                  update((old) => ({
                    ...old,
                    proposals: {
                      ...old.proposals,
                      [card.proposal.proposal_id]: {
                        ...old.proposals[card.proposal.proposal_id],
                        discarded: true,
                      },
                    },
                  }))
              : undefined
          }
          onClarify={onClarify}
        />
      ))}
      {ready.length > 1 && (
        <button
          type="button"
          className="chat-text-button mt-2 w-full rounded-xl border border-[var(--app-line)] px-4 text-left"
          disabled={ui.pending || !!ui.action || !sourceType}
          onClick={() => void commit(ready)}
        >
          Save all ({ready.length})
        </button>
      )}
      {!sourceType && ready.length > 0 && !ui.action && (
        <div className="mt-2 text-sm text-muted-foreground">
          <p>
            {onLoadContext
              ? "Load the original message to keep this meal’s text or photo source."
              : "This proposal’s original message is unavailable. Describe it again in chat."}
          </p>
          <button
            type="button"
            className="chat-text-button"
            disabled={loadingContext}
            onClick={onLoadContext ?? onClarify}
          >
            {loadingContext
              ? "Loading original message…"
              : onLoadContext
                ? "Load original message"
                : "Describe in chat"}
          </button>
        </div>
      )}
      {ui.error && (
        <div
          role="alert"
          className="mt-2 rounded-xl border border-[var(--app-line)] p-3 text-sm"
        >
          <p>{ui.error}</p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              className="chat-text-button"
              disabled={ui.pending}
              onClick={() => void commit()}
            >
              Retry save
            </button>
            {ui.canRevise && (
              <button
                type="button"
                className="chat-text-button"
                onClick={() =>
                  update((old) => ({
                    ...old,
                    action: null,
                    error: null,
                    canRevise: false,
                  }))
                }
              >
                Review before saving
              </button>
            )}
          </div>
        </div>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {ui.pending ? "Saving meals…" : save.isSuccess ? "Meals saved." : ""}
      </p>
      {editing && (
        <MealEditor
          target={editing.target}
          initialItem={editing.item}
          onClose={() => setEditing(null)}
          onSaved={(meal) =>
            update((old) => {
              const proposals = Object.fromEntries(
                Object.entries(old.proposals).map(([id, state]) => [
                  id,
                  state.saved?.id === meal.id
                    ? { ...state, saved: meal }
                    : state,
                ]),
              );
              if (editing.target.kind === "proposal")
                proposals[editing.target.proposal.proposal_id] = {
                  ...proposals[editing.target.proposal.proposal_id],
                  saved: meal,
                };
              return {
                ...old,
                proposals,
                meals: { ...old.meals, [meal.id]: meal },
              };
            })
          }
        />
      )}
    </div>
  );
}
