"use client";

import { useState } from "react";
import { useIsMutating, useQueryClient } from "@tanstack/react-query";
import { MessageMealCards } from "@/components/meals/message-meal-cards";
import { useDaily } from "@/hooks/use-api";
import { mockApi } from "@/mocks/server";
import { createFixtures } from "@/mocks/fixtures";
import type { ChatMessage, MealCard } from "@/types/api";
import { ThemePreview } from "./theme-preview";

export function MealCardGallery({
  fixtures,
}: {
  fixtures: ReturnType<typeof createFixtures>;
}) {
  const client = useQueryClient();
  const daily = useDaily();
  const busy = useIsMutating() > 0;
  const [notice, setNotice] = useState("");
  const [reply, setReply] = useState("");
  const scenarios: Array<{
    id: string;
    label: string;
    cards: MealCard[];
    photo?: boolean;
  }> = [
    {
      id: "single",
      label: "Single proposal",
      cards: [
        { kind: "proposal", state: "unsaved", proposal: fixtures.single },
      ],
    },
    {
      id: "three",
      label: "Three proposals",
      cards: fixtures.three.map((proposal) => ({
        kind: "proposal",
        state: "unsaved",
        proposal,
      })),
    },
    {
      id: "photo",
      label: "Photo with assumptions",
      photo: true,
      cards: [{ kind: "proposal", state: "unsaved", proposal: fixtures.photo }],
    },
    {
      id: "clarify",
      label: "Clarification",
      cards: [
        {
          kind: "proposal",
          state: "unsaved",
          proposal: fixtures.clarification,
        },
      ],
    },
    {
      id: "saved",
      label: "Auto-saved",
      cards: [
        {
          kind: "meal",
          meal_id: fixtures.autoSaved.id,
          meal: fixtures.autoSaved,
        },
      ],
    },
    { id: "deleted", label: "Deleted", cards: fixtures.deletedMessage.cards },
    {
      id: "discarded",
      label: "Discarded",
      cards: [
        { kind: "proposal", state: "discarded", proposal: fixtures.single },
      ],
    },
  ];
  return (
    <div className="mx-auto max-w-2xl space-y-7 px-5 py-8 sm:px-8">
      <h1 className="text-2xl font-semibold">Meal card preview</h1>
      <p className="text-sm text-muted-foreground">
        Development only. In-memory fixtures; no real meals or AI calls. Discard
        and unsaved edits stay in this browser session until reload.
      </p>
      <ThemePreview />
      <p className="text-sm tabular-nums" role="status">
        Today: {daily.data?.consumed.calories ?? "…"} kcal
      </p>
      <div className="flex flex-wrap gap-3">
        <button
          className="chat-text-button rounded-lg border px-3"
          disabled={daily.isPending || busy}
          onClick={() => {
            mockApi.failNext("internal");
            setNotice("The next request will fail. Save a card, then retry.");
          }}
        >
          Fail next save
        </button>
        <button
          className="chat-text-button rounded-lg border px-3"
          disabled={busy}
          onClick={() => {
            mockApi.reset();
            void client.resetQueries({ queryKey: ["proposal-ui"] });
            void client.invalidateQueries();
            setNotice("Preview reset.");
          }}
        >
          Reset preview
        </button>
      </div>
      <p role="status" className="text-sm">
        {notice}
      </p>
      {scenarios.map((scenario) => {
        const message: ChatMessage = {
          id: `gallery-${scenario.id}`,
          client_message_id: null,
          role: "assistant",
          text: "",
          cards: scenario.cards,
          had_image: false,
          status: "sent",
          created_at: fixtures.single.consumed_at,
        };
        return (
          <section key={scenario.id} aria-label={scenario.label}>
            <h2 className="text-sm font-medium text-muted-foreground">
              {scenario.label}
            </h2>
            <MessageMealCards
              message={message}
              sourceType={scenario.photo ? "photo" : "text"}
              onClarify={() =>
                document.getElementById("gallery-reply")?.focus()
              }
            />
          </section>
        );
      })}
      <label className="block space-y-2">
        <span className="text-sm">Reply to clarification</span>
        <textarea
          id="gallery-reply"
          value={reply}
          onChange={(event) => setReply(event.target.value)}
          rows={2}
          className="w-full rounded-xl border p-3"
        />
      </label>
    </div>
  );
}
