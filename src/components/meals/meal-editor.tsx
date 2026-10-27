"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { X, Plus, Trash2 } from "lucide-react";
import type {
  Meal,
  MealProposal,
  MealSourceType,
  UpdateMealRequest,
} from "@/types/api";
import { ApiClientError, createSaveAction, getMeal } from "@/lib/api";
import { queryKeys, useSaveMeals, useUpdateMeal } from "@/hooks/use-api";
import { round1 } from "@/lib/nutrition/calc";
import {
  saveMealsRequestSchema,
  updateMealRequestSchema,
} from "@/lib/validation/meal";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Input } from "@/components/ui/input";
import { MealActions } from "./meal-actions";
import {
  buildItem,
  buildValue,
  changePortion,
  macroFields,
  macroStrings,
  makeDraft,
  newItemDraft,
  type ItemDraft,
} from "./editor-draft";

export type EditorTarget =
  | {
      kind: "proposal";
      proposal: MealProposal;
      sourceType: MealSourceType | null;
    }
  | { kind: "meal"; meal: Meal };

export function MealEditor({
  target,
  initialItem,
  onSaved,
  onClose,
}: {
  target: EditorTarget;
  initialItem?: number;
  onSaved: (meal: Meal) => void;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const save = useSaveMeals();
  const update = useUpdateMeal();
  const [base, setBase] = useState(
    target.kind === "proposal" ? target.proposal : target.meal,
  );
  const [draft, setDraft] = useState(() => makeDraft(base));
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [latest, setLatest] = useState<Meal | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const [notice, setNotice] = useState("");
  const [mobile, setMobile] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 767px)").matches,
  );
  const [viewport, setViewport] = useState({ height: 0, bottom: 0 });
  const focus = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const request = useRef<{
    save?: ReturnType<typeof createSaveAction>;
    update?: { id: string; body: UpdateMealRequest };
  } | null>(null);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const change = () => setMobile(media.matches);
    media.addEventListener("change", change);
    const visual = window.visualViewport;
    const resize = () => {
      if (visual)
        setViewport({
          height: visual.height,
          bottom: Math.max(
            0,
            window.innerHeight - visual.height - visual.offsetTop,
          ),
        });
    };
    resize();
    visual?.addEventListener("resize", resize);
    visual?.addEventListener("scroll", resize);
    return () => {
      media.removeEventListener("change", change);
      visual?.removeEventListener("resize", resize);
      visual?.removeEventListener("scroll", resize);
    };
  }, []);

  let preview: ReturnType<typeof buildValue> | null = null;
  let previewError = "";
  try {
    preview = buildValue(draft, base);
  } catch (cause) {
    previewError =
      cause instanceof Error ? cause.message : "Review the meal details.";
  }
  const needsConfirmation =
    target.kind === "proposal" && target.proposal.needs_clarification;
  const disabled = busy || locked || conflict;
  const patchRow = (key: string, change: (row: ItemDraft) => ItemDraft) =>
    setDraft((old) => ({
      ...old,
      items: old.items.map((row) => (row.key === key ? change(row) : row)),
    }));
  async function refreshLatest() {
    if (target.kind !== "meal") return;
    setRefreshing(true);
    setRefreshError("");
    try {
      await client.cancelQueries({
        queryKey: queryKeys.meal(target.meal.id),
        exact: true,
      });
      const meal = await client.fetchQuery({
        queryKey: queryKeys.meal(target.meal.id),
        queryFn: ({ signal }) => getMeal(target.meal.id, { signal }),
        staleTime: 0,
      });
      setLatest(meal);
      void client.invalidateQueries({ queryKey: queryKeys.messages });
    } catch (cause) {
      setRefreshError(
        cause instanceof Error
          ? cause.message
          : "The latest meal couldn’t load.",
      );
    } finally {
      setRefreshing(false);
    }
  }
  async function submit() {
    if (inFlight.current || conflict) return;
    setError("");
    try {
      if (needsConfirmation && !confirmed)
        throw new Error("Confirm the portions before saving this proposal.");
      const value = buildValue(draft, base);
      if (!request.current) {
        if (target.kind === "proposal") {
          if (!target.sourceType)
            throw new Error(
              "Load the original chat message before saving this proposal.",
            );
          const body = saveMealsRequestSchema.parse({
            meals: [
              {
                proposal_id: target.proposal.proposal_id,
                name: value.name,
                consumed_at: value.consumed_at,
                source_type: target.sourceType,
                items: value.items.map(({ id, ...item }) => {
                  void id;
                  return item;
                }),
              },
            ],
          });
          request.current = { save: createSaveAction(body) };
        } else {
          const body = updateMealRequestSchema.parse({
            version: (base as Meal).version,
            name: value.name,
            consumed_at: value.consumed_at,
            items: value.items,
          });
          request.current = { update: { id: target.meal.id, body } };
        }
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Review the highlighted fields.",
      );
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      const action = request.current!;
      const meal = action.save
        ? (await save.mutateAsync(action.save)).meals[0]
        : (await update.mutateAsync(action.update!)).meal;
      onSaved(meal);
      onClose();
    } catch (cause) {
      if (
        cause instanceof ApiClientError &&
        cause.code === "version_conflict" &&
        target.kind === "meal"
      ) {
        setConflict(true);
        setLocked(false);
        request.current = null;
        await refreshLatest();
      } else {
        setError(
          cause instanceof Error
            ? cause.message
            : "Your changes couldn’t save.",
        );
        const canRevise =
          cause instanceof ApiClientError && cause.code === "validation_error";
        setLocked(!canRevise);
        if (canRevise) request.current = null;
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const Title = mobile ? DrawerTitle : DialogTitle;
  const Description = mobile ? DrawerDescription : DialogDescription;
  const content = (
    <>
      <div className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--app-line)] px-5 py-4">
        <div>
          <Title>Edit meal</Title>
          <Description className="mt-1 text-xs">
            Adjust portions and review the totals before saving.
          </Description>
        </div>
        <button
          type="button"
          className="editor-icon-button"
          aria-label="Close meal editor"
          disabled={busy}
          onClick={onClose}
        >
          <X size={20} aria-hidden="true" />
        </button>
      </div>
      <form
        noValidate
        className="flex min-h-0 flex-1 flex-col"
        onChange={() => {
          if (!locked && !busy) {
            request.current = null;
            setError("");
            setNotice("");
          }
        }}
        onSubmit={(event) => {
          event.preventDefault();
          if (!preview)
            event.currentTarget
              .querySelector<HTMLInputElement>("input:invalid")
              ?.focus();
          void submit();
        }}
      >
        <fieldset
          disabled={disabled}
          className="min-h-0 min-w-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-5 py-4"
        >
          <label className="block space-y-2">
            <span className="text-sm font-medium">Meal name</span>
            <Input
              ref={initialItem === undefined ? focus : undefined}
              value={draft.name}
              onChange={(event) =>
                setDraft({ ...draft, name: event.target.value })
              }
              required
              maxLength={120}
              className="min-h-11 text-base"
            />
          </label>
          <label className="block space-y-2">
            <span className="text-sm font-medium">Consumed at</span>
            <Input
              type="datetime-local"
              aria-label="Consumed at"
              value={draft.date}
              onChange={(event) =>
                setDraft({ ...draft, date: event.target.value })
              }
              required
              className="min-h-11 text-base"
            />
            <span className="block text-xs text-muted-foreground">
              Date and time use this device’s time zone.
            </span>
          </label>
          {draft.items.map((row, index) => (
            <fieldset
              key={row.key}
              className="min-w-0 space-y-3 rounded-xl border border-[var(--app-line)] p-3"
              aria-label={`Item ${index + 1}`}
            >
              <legend className="max-w-full truncate px-1 text-sm font-medium">
                {row.name || `New item ${index + 1}`}
              </legend>
              {(row.added || row.mode === "manual") && (
                <label className="block space-y-1">
                  <span className="text-xs text-muted-foreground">
                    Food name
                  </span>
                  <Input
                    aria-label={`Item ${index + 1} food name`}
                    value={row.name}
                    required
                    maxLength={200}
                    onChange={(event) =>
                      patchRow(row.key, (old) => ({
                        ...old,
                        name: event.target.value,
                        edited: true,
                      }))
                    }
                    className="min-h-11 text-base"
                  />
                </label>
              )}
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    ["quantity", "Quantity"],
                    ["unit", "Unit"],
                    ["grams", "Grams"],
                  ] as const
                ).map(([field, label]) => (
                  <label key={field} className="block min-w-0 space-y-1">
                    <span className="text-xs text-muted-foreground">
                      {label}
                    </span>
                    <Input
                      ref={
                        field === "grams" && initialItem === index
                          ? focus
                          : undefined
                      }
                      type={field === "unit" ? "text" : "number"}
                      min={field === "quantity" ? "0.001" : "0"}
                      max={field === "unit" ? undefined : "10000"}
                      maxLength={field === "unit" ? 32 : undefined}
                      step="any"
                      required={
                        field !== "grams" ||
                        row.mode === "label" ||
                        (row.mode === "original" &&
                          !!row.original.basis_per_100g)
                      }
                      aria-label={`Item ${index + 1} ${label.toLowerCase()}`}
                      value={row[field]}
                      onChange={(event) =>
                        patchRow(row.key, (old) =>
                          changePortion(old, field, event.target.value),
                        )
                      }
                      className="min-h-11 min-w-0 text-base"
                    />
                  </label>
                ))}
              </div>
              {row.portionNote && (
                <p className="text-xs leading-5 text-muted-foreground">
                  {row.portionNote}
                </p>
              )}
              {!row.added ? (
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={row.mode === "manual"}
                    disabled={
                      row.original.nutrition_source === "manual" &&
                      !row.original.basis_per_100g
                    }
                    onChange={(event) =>
                      patchRow(row.key, (old) => {
                        let macros = old.original.macros;
                        try {
                          macros = buildItem(old).macros;
                        } catch {
                          /* Keep last known values while incomplete. */
                        }
                        return {
                          ...old,
                          mode: event.target.checked ? "manual" : "original",
                          name: event.target.checked
                            ? old.name
                            : old.original.food_name,
                          values: macroStrings(macros),
                          edited: true,
                        };
                      })
                    }
                  />
                  Manual macros{" "}
                  <span className="text-xs text-muted-foreground">
                    for this portion
                  </span>
                </label>
              ) : (
                <label className="block space-y-1">
                  <span className="text-xs text-muted-foreground">
                    Nutrition entered as
                  </span>
                  <select
                    aria-label={`Item ${index + 1} nutrition basis`}
                    value={row.mode}
                    onChange={(event) =>
                      patchRow(row.key, (old) => ({
                        ...old,
                        mode: event.target.value as "manual" | "label",
                        edited: true,
                      }))
                    }
                    className="min-h-11 w-full rounded-lg border bg-background px-2"
                  >
                    <option value="manual">Totals for this portion</option>
                    <option value="label">Label values per 100 g</option>
                  </select>
                </label>
              )}
              {row.mode !== "original" ? (
                <div className="grid grid-cols-2 gap-3">
                  {macroFields.map(([key, label]) => (
                    <label key={key} className="block space-y-1">
                      <span className="text-xs text-muted-foreground">
                        {label}
                      </span>
                      <Input
                        type="number"
                        min="0"
                        max={key === "calories" ? "50000" : "5000"}
                        step="any"
                        required
                        aria-label={`Item ${index + 1} ${label}`}
                        value={row.values[key]}
                        onChange={(event) =>
                          patchRow(row.key, (old) => ({
                            ...old,
                            values: {
                              ...old.values,
                              [key]: event.target.value,
                            },
                            edited: true,
                          }))
                        }
                        className="min-h-11 text-base"
                      />
                    </label>
                  ))}
                </div>
              ) : (
                <p className="text-xs leading-5 text-muted-foreground">
                  {row.original.basis_per_100g
                    ? "Nutrition follows grams using this food’s existing database values."
                    : row.original.nutrition_source === "manual"
                      ? "These are manual totals. Change the macro values to adjust nutrition."
                      : "Nutrition scales from the existing estimate; it remains an estimate."}
                </p>
              )}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  className="chat-text-button inline-flex items-center gap-1"
                  disabled={draft.items.length >= 50}
                  onClick={() =>
                    setDraft((old) => ({
                      ...old,
                      items: [
                        ...old.items,
                        {
                          ...structuredClone(row),
                          key: crypto.randomUUID(),
                          original: { ...row.original, id: null },
                          edited: true,
                        },
                      ],
                    }))
                  }
                >
                  <Plus size={15} aria-hidden="true" />
                  Add another portion
                </button>
                <button
                  type="button"
                  className="editor-icon-button text-muted-foreground"
                  aria-label={`Remove item ${index + 1}`}
                  disabled={draft.items.length <= 1}
                  onClick={() =>
                    setDraft((old) => ({
                      ...old,
                      items: old.items.filter((item) => item.key !== row.key),
                    }))
                  }
                >
                  <Trash2 size={18} aria-hidden="true" />
                </button>
              </div>
            </fieldset>
          ))}
          <button
            type="button"
            className="chat-text-button inline-flex items-center gap-2"
            disabled={draft.items.length >= 50}
            onClick={() =>
              setDraft((old) => ({
                ...old,
                items: [...old.items, newItemDraft(crypto.randomUUID())],
              }))
            }
          >
            <Plus size={18} aria-hidden="true" />
            Add food item
          </button>
          <p className="text-xs leading-5 text-muted-foreground">
            For a new food, enter its portion totals or its label values per 100
            g. A name and weight alone don’t determine nutrition.
          </p>
          {needsConfirmation && (
            <label className="flex min-h-11 items-start gap-2 text-sm">
              <input
                className="mt-1"
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              I’ve reviewed and confirmed these portions.
            </label>
          )}
        </fieldset>
        <div className="editor-footer shrink-0 space-y-3 border-t border-[var(--app-line)] bg-background px-5 py-4">
          {conflict && (
            <div role="alert" className="space-y-2 text-sm">
              <p className="font-medium">
                This meal changed — review and save again.
              </p>
              {refreshing ? (
                <p role="status">Loading latest meal…</p>
              ) : latest ? (
                <>
                  <p className="text-muted-foreground">
                    Latest: {latest.name} · {round1(latest.totals.calories)}{" "}
                    kcal. Loading it replaces your unsaved edits.
                  </p>
                  <button
                    type="button"
                    className="chat-text-button"
                    onClick={() => {
                      setBase(latest);
                      setDraft(makeDraft(latest));
                      setConflict(false);
                      setLatest(null);
                      setNotice(
                        "Latest version loaded. Review it before saving.",
                      );
                    }}
                  >
                    Load latest meal
                  </button>
                </>
              ) : (
                <>
                  <p>{refreshError}</p>
                  <button
                    type="button"
                    className="chat-text-button"
                    onClick={() => void refreshLatest()}
                  >
                    Retry loading latest
                  </button>
                </>
              )}
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm">
              {error}
              {locked && " Retry this save before making more changes."}
            </p>
          )}
          {notice && (
            <p role="status" className="text-sm">
              {notice}
            </p>
          )}
          <div
            aria-label="Nutrition preview"
            aria-live="polite"
            className="tabular-nums"
          >
            {preview ? (
              <>
                <p>
                  <strong className="text-xl font-semibold">
                    {round1(preview.totals.calories)}
                  </strong>{" "}
                  <span className="text-sm text-muted-foreground">
                    kcal preview
                  </span>
                </p>
                <p className="text-xs text-muted-foreground">
                  P {round1(preview.totals.protein_g)} g · C{" "}
                  {round1(preview.totals.carbs_g)} g · F{" "}
                  {round1(preview.totals.fat_g)} g
                </p>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">{previewError}</p>
            )}
          </div>
          <div className="flex gap-3">
            <button
              type="button"
              disabled={busy}
              onClick={onClose}
              className="min-h-11 rounded-lg border px-4 text-sm"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={
                busy ||
                conflict ||
                (target.kind === "proposal" && !target.sourceType)
              }
              className="min-h-11 flex-1 rounded-lg bg-[var(--app-accent)] px-4 text-sm font-medium text-background"
            >
              {busy
                ? "Saving…"
                : locked
                  ? "Retry save"
                  : target.kind === "proposal"
                    ? "Save meal"
                    : "Save changes"}
            </button>
          </div>
          {target.kind === "meal" && (
            <MealActions
              id={target.meal.id}
              disabled={busy || locked}
              onDeleted={onClose}
            />
          )}
        </div>
      </form>
    </>
  );
  const openChange = (open: boolean) => {
    if (!open && !busy) onClose();
  };
  const style = {
    "--editor-height": viewport.height
      ? `calc(${viewport.height}px - max(16px, env(safe-area-inset-top)))`
      : "calc(100dvh - max(16px, env(safe-area-inset-top)))",
    ...(mobile ? { bottom: viewport.bottom } : {}),
  } as CSSProperties;
  return mobile ? (
    <Drawer open onOpenChange={openChange}>
      <DrawerContent
        initialFocus={focus}
        className="meal-editor max-h-[var(--editor-height)] [--drawer-content-max-height:var(--editor-height)]"
        style={style}
      >
        {content}
      </DrawerContent>
    </Drawer>
  ) : (
    <Dialog open onOpenChange={openChange}>
      <DialogContent
        initialFocus={focus}
        showCloseButton={false}
        className="meal-editor flex max-h-[min(90dvh,var(--editor-height))] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl"
        style={style}
      >
        {content}
      </DialogContent>
    </Dialog>
  );
}
