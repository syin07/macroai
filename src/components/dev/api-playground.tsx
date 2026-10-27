"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import * as api from "@/lib/api";
import { useDaily, useMeals, useMessages } from "@/hooks/use-api";
import { createFixtures, errorFixtures } from "@/mocks/fixtures";
import { mockApi } from "@/mocks/server";
import type { ErrorCode, Meal } from "@/types/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

type Operation = { label: string; action: () => Promise<unknown> };

export function ApiPlayground({
  fixtures,
}: {
  fixtures: ReturnType<typeof createFixtures>;
}) {
  const client = useQueryClient();
  const daily = useDaily();
  const meals = useMeals();
  const messages = useMessages();
  const [text, setText] = useState("2 eggs and toast");
  const [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [result, setResult] = useState(
    "Choose an endpoint to inspect its response.",
  );
  const [failed, setFailed] = useState(false);
  const [selected, setSelected] = useState<Meal | null>(null);

  async function run(label: string, action: () => Promise<unknown>) {
    setOperation({ label, action });
    setBusy(true);
    setFailed(false);
    try {
      const value = await action();
      setResult(
        value instanceof Blob
          ? await value.text()
          : JSON.stringify(value ?? "204 No content", null, 2),
      );
      await client.invalidateQueries();
    } catch (error) {
      setFailed(true);
      setResult(
        error instanceof api.ApiClientError
          ? JSON.stringify(
              {
                code: error.code,
                message: error.message,
                retryable: error.retryable,
                fields: error.fields,
              },
              null,
              2,
            )
          : String(error),
      );
    } finally {
      setBusy(false);
    }
  }
  function send(scenario: string, photo = false) {
    const draft = api.createChatDraft({
      text: scenario,
      ...(photo
        ? { image: new Blob(["mock image bytes"], { type: "image/jpeg" }) }
        : {}),
    });
    void run("Send chat", () => api.sendChat(draft));
  }
  function save(all = false, manual = false) {
    const proposals = all ? fixtures.three : [fixtures.single];
    const action = api.createSaveAction({
      meals: proposals.map((proposal) => ({
        ...proposal,
        consumed_at: new Date().toISOString(),
        proposal_id: manual ? null : proposal.proposal_id,
        source_type: manual ? "manual" : "text",
      })),
    });
    void run("Save meals", async () => {
      const response = await api.saveMeals(action);
      setSelected(response.meals[0]);
      return response;
    });
  }
  function button(
    label: string,
    action: () => Promise<unknown>,
    disabled = false,
  ) {
    return (
      <Button
        key={label}
        variant="outline"
        disabled={busy || disabled}
        onClick={() => void run(label, action)}
      >
        {label}
      </Button>
    );
  }
  const allMessages = messages.data?.messages ?? [];
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <h1 className="text-2xl font-semibold">API playground</h1>
      <p>
        Development only · in-memory mock data · reload resets everything. No
        network or AI calls. Mutations and account deletion here affect only
        this tab&apos;s mock store.
      </p>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Chat fixtures</h2>
        <label htmlFor="mock-text">
          Meal description (kept when an action fails)
        </label>
        <Textarea
          id="mock-text"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => send(text)}>
            Send draft
          </Button>
          <Button disabled={busy} onClick={() => send("three meals")}>
            Three proposals
          </Button>
          <Button disabled={busy} onClick={() => send("some chicken")}>
            Clarification
          </Button>
          <Button disabled={busy} onClick={() => send(text, true)}>
            Photo with inferred oil
          </Button>
          {button("Auto-save mode", () =>
            api.patchPreferences({ save_mode: "auto" }),
          )}
          {button("Confirm mode", () =>
            api.patchPreferences({ save_mode: "confirm" }),
          )}
          {button("Get messages", () => api.getMessages())}
          {button(
            "Delete latest message",
            () => api.deleteMessage(allMessages.at(-1)!.id),
            !allMessages.length,
          )}
        </div>
        <details>
          <summary>
            Card fixtures (includes deleted and auto-saved states)
          </summary>
          <pre className="max-h-64 overflow-auto text-xs">
            {JSON.stringify(fixtures, null, 2)}
          </pre>
        </details>
      </section>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Meals and daily totals</h2>
        <div className="flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => save()}>
            Save proposal
          </Button>
          <Button disabled={busy} onClick={() => save(true)}>
            Save all
          </Button>
          <Button disabled={busy} onClick={() => save(false, true)}>
            Manual save
          </Button>
          {button("Get meals", () => api.getMeals())}
          {button("Search eggs", () => api.getMeals({ q: "eggs" }))}
          {button("Get daily", () => api.getDaily())}
          {button(
            "Read selected meal",
            () => api.getMeal(selected!.id),
            !selected,
          )}
          {button(
            "Update selected meal",
            async () => {
              const response = await api.updateMeal(selected!.id, {
                version: selected!.version,
                name: "Edited mock meal",
              });
              setSelected(response.meal);
              return response;
            },
            !selected,
          )}
          {button(
            "Delete selected meal",
            () => api.deleteMeal(selected!.id),
            !selected,
          )}
          {button(
            "Undo deletion (10s)",
            () => api.undoDelete(selected!.id),
            !selected,
          )}
        </div>
        <p className="text-sm">
          Save a meal to select it. Hooks:{" "}
          {daily.data?.consumed.calories ?? "…"} kcal today ·{" "}
          {meals.data?.pages.flatMap((page) => page.meals).length ?? 0} loaded
          meals · {allMessages.length} loaded messages.
        </p>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={!meals.hasNextPage || meals.isFetchingNextPage}
            onClick={() => void meals.fetchNextPage()}
          >
            Load more meals
          </Button>
          <Button
            variant="outline"
            disabled={!messages.hasNextPage || messages.isFetchingNextPage}
            onClick={() => void messages.fetchNextPage()}
          >
            Load earlier messages
          </Button>
        </div>
      </section>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">
          Account, goals, preferences, memories, export
        </h2>
        <div className="flex flex-wrap gap-2">
          {button("Get me", () => api.getMe())}
          {button("Get goals", () => api.getGoals())}
          {button("Save goals", () =>
            api.putGoals({
              calories: 2400,
              protein_g: 160,
              carbs_g: 260,
              fat_g: 70,
            }),
          )}
          {button("Suggest goals", () =>
            api.suggestGoals({
              age: 25,
              height_cm: 175,
              weight_kg: 75,
              sex: "male",
              activity: "moderate",
              goal: "maintain",
            }),
          )}
          {button("Get preferences", () => api.getPreferences())}
          {button("Patch preferences", () =>
            api.patchPreferences({ assistant_style: "detailed" }),
          )}
          {button("Complete onboarding", () => api.completeOnboarding())}
          {button("Get memories", () => api.getMemories())}
          {button("Patch first memory", async () => {
            const { memories } = await api.getMemories();
            if (!memories[0])
              throw new Error("Reset mocks to restore the memory.");
            return api.patchMemory(memories[0].id, {
              content: "Usual shake: updated mock preference",
            });
          })}
          {button("Delete first memory", async () => {
            const { memories } = await api.getMemories();
            if (!memories[0]) throw new Error("No mock memories remain.");
            return api.deleteMemory(memories[0].id);
          })}
          {button("Export CSV", () => api.exportData("csv"))}
          {button("Export nutrition JSON", () => api.exportData("json"))}
          {button("Export account JSON", () =>
            api.exportData("json", "account"),
          )}
          {button("Delete mock account", () =>
            api.deleteAccount({ redirectOnAuthError: false }),
          )}
        </div>
      </section>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Errors and retry</h2>
        <div className="flex flex-wrap gap-2">
          {(Object.keys(errorFixtures) as ErrorCode[]).map((code) => (
            <Button
              key={code}
              variant="outline"
              disabled={busy}
              onClick={() => {
                mockApi.failNext(code);
                void run(code, () => api.getMe({ redirectOnAuthError: false }));
              }}
            >
              {code}
            </Button>
          ))}
        </div>
        <div className="flex gap-2">
          <Button
            disabled={busy || !operation || !failed}
            onClick={() => {
              if (operation) void run(operation.label, operation.action);
            }}
          >
            Retry last action
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              mockApi.reset();
              client.clear();
              setSelected(null);
              setOperation(null);
              setFailed(false);
              setResult("Mocks reset.");
            }}
          >
            Reset mock database
          </Button>
        </div>
      </section>
      <section aria-live="polite" aria-busy={busy} className="space-y-2">
        <h2 className="text-lg font-semibold">
          {busy ? "Loading…" : (operation?.label ?? "Response")}
        </h2>
        <pre
          className="max-h-96 overflow-auto rounded-lg border p-4 text-xs"
          role={failed ? "alert" : undefined}
        >
          {result}
        </pre>
      </section>
    </main>
  );
}
