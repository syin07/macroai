"use client";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { deleteMemory, patchMemory } from "@/lib/api";
import { queryKeys, useMemories } from "@/hooks/use-api";
import { patchMemoryRequestSchema } from "@/lib/validation/account";
import type { Memory, MemoriesResponse } from "@/types/api";
import {
  action,
  control,
  QueryNotice,
  SettingsSection,
} from "./settings-shared";

function MemoryRow({ memory }: { memory: Memory }) {
  const client = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [text, setText] = useState(memory.content);
  const [validation, setValidation] = useState("");
  const change = useMutation({
    mutationFn: (content: string) => patchMemory(memory.id, { content }),
    onSuccess: (result) => {
      client.setQueryData<MemoriesResponse>(queryKeys.memories, (old) => ({
        memories: (old?.memories ?? []).map((item) =>
          item.id === result.id ? result : item,
        ),
      }));
      setEditing(false);
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteMemory(memory.id),
    onSuccess: () =>
      client.setQueryData<MemoriesResponse>(queryKeys.memories, (old) => ({
        memories: (old?.memories ?? []).filter((item) => item.id !== memory.id),
      })),
  });
  const busy = change.isPending || remove.isPending;
  return (
    <li className="rounded-xl border border-[var(--app-line)] p-4">
      <p className="mb-2 text-xs capitalize text-muted-foreground">
        {memory.category.replaceAll("_", " ")}
      </p>
      {editing ? (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy) return;
            const checked = patchMemoryRequestSchema.safeParse({
              content: text,
            });
            if (!checked.success) {
              setValidation("Enter a memory between 1 and 500 characters.");
              return;
            }
            try {
              await change.mutateAsync(checked.data.content);
            } catch {
              /* Preserve edit. */
            }
          }}
        >
          <fieldset disabled={busy}>
            <label className="text-sm">
              Memory
              <textarea
                aria-label="Memory content"
                value={text}
                maxLength={500}
                required
                rows={3}
                onChange={(event) => {
                  setText(event.target.value);
                  setValidation("");
                  change.reset();
                }}
                className={`${control} mt-2 py-3`}
              />
            </label>
            <div className="mt-2 flex gap-3">
              <button className={action} type="submit">
                {change.isPending
                  ? "Saving memory…"
                  : change.isError
                    ? "Retry memory"
                    : "Save memory"}
              </button>
              <button
                type="button"
                className="chat-text-button"
                onClick={() => {
                  setEditing(false);
                  change.reset();
                }}
              >
                Cancel edit
              </button>
            </div>
          </fieldset>
        </form>
      ) : (
        <p className="whitespace-pre-wrap break-words text-sm leading-6">
          {memory.content}
        </p>
      )}
      {!editing && (
        <div className="mt-2 flex flex-wrap gap-4">
          <button
            disabled={busy}
            className="chat-text-button"
            onClick={() => {
              setText(memory.content);
              setEditing(true);
              setConfirming(false);
              setValidation("");
              remove.reset();
            }}
          >
            Edit memory
          </button>
          <button
            disabled={busy}
            className="chat-text-button"
            onClick={() => {
              setConfirming(true);
              remove.reset();
            }}
          >
            Delete memory
          </button>
        </div>
      )}
      {confirming && (
        <div className="mt-2 text-sm">
          <p>
            Delete this memory? It will stop being used for personalization.
            Chats and meals stay.
          </p>
          <div className="mt-2 flex gap-3">
            <button
              disabled={busy}
              className={action}
              onClick={() => {
                void remove.mutateAsync().catch(() => {});
              }}
            >
              {remove.isPending
                ? "Deleting memory…"
                : remove.isError
                  ? "Retry delete memory"
                  : "Confirm delete memory"}
            </button>
            <button
              disabled={busy}
              className="chat-text-button"
              onClick={() => {
                setConfirming(false);
                remove.reset();
              }}
            >
              Keep memory
            </button>
          </div>
        </div>
      )}
      {(validation || change.isError || remove.isError) && (
        <p role="alert" className="mt-3 text-sm">
          {validation || change.error?.message || remove.error?.message}
        </p>
      )}
    </li>
  );
}

export function MemoriesSettings() {
  const memories = useMemories();
  return (
    <SettingsSection
      title="Memories"
      description="These details help personalize future replies. Deleting a memory does not delete chats or meals. Deleting a chat does not delete its separately saved memories."
    >
      {!memories.data ? (
        <QueryNotice
          pending={memories.isPending}
          error={memories.isError}
          retry={() => void memories.refetch()}
        />
      ) : (
        <>
          {memories.isError && (
            <p role="alert">
              Showing the last saved memories.{" "}
              <button
                className="chat-text-button"
                onClick={() => void memories.refetch()}
              >
                Refresh memories
              </button>
            </p>
          )}
          {memories.data.memories.length ? (
            <ul className="space-y-3">
              {memories.data.memories.map((memory) => (
                <MemoryRow key={memory.id} memory={memory} />
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              No saved memories yet.
            </p>
          )}
        </>
      )}
    </SettingsSection>
  );
}
