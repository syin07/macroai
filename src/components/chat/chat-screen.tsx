"use client";
import dynamic from "next/dynamic";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { ArrowDown, ArrowUp, Camera, Plus } from "lucide-react";
import { ApiClientError, createChatDraft, type ChatDraft } from "@/lib/api";
import { useMessages, useSendChat, useManualMessages } from "@/hooks/use-api";
import type { ChatMessage } from "@/types/api";
import { Brand } from "@/components/shared/brand";
import { LoadingSkeleton } from "@/components/shared/loading-skeleton";
import { HeaderLink } from "@/components/shared/page-frame";
import { MessageMealCards } from "@/components/meals/message-meal-cards";
import { PhotoInput } from "./photo-input";
import { DailyStrip } from "./daily-strip";
const ManualLog = dynamic(
  () => import("./manual-log").then((module) => module.ManualLog),
  {
    loading: () => (
      <LoadingSkeleton label="Opening manual entry…" className="p-5" />
    ),
  },
);
import { nearBottom } from "./scroll-position";
import { messageSource } from "./message-source";

const prompts = [
  "2 eggs and toast",
  "Chicken bowl with double rice",
  "How much protein do I have left?",
];

export function ChatScreen() {
  const history = useMessages();
  const manualMessages = useManualMessages();
  const send = useSendChat();
  const [text, setText] = useState("");
  const [image, setImage] = useState<Blob | undefined>();
  const [preparingPhoto, setPreparingPhoto] = useState(false);
  const [local, setLocal] = useState<{
    draft: ChatDraft;
    message: ChatMessage;
  } | null>(null);
  const [manual, setManual] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const [viewport, setViewport] = useState({
    height: 0,
    top: 0,
    keyboard: false,
  });
  const list = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const follows = useRef(true);
  const prepend = useRef<{ height: number; top: number } | null>(null);
  const loadingEarlier = useRef(false);
  const sending = useRef(false);
  const initialScroll = useRef(false);
  const serverMessages = history.data?.messages ?? [];
  const linked = new Set(
    serverMessages.flatMap((message) =>
      message.cards.flatMap((card) =>
        card.kind === "meal" ? [card.meal_id] : [],
      ),
    ),
  );
  const messages = [
    ...serverMessages,
    ...manualMessages.flatMap((message) => {
      const cards = message.cards.filter(
        (card) => card.kind === "meal" && !linked.has(card.meal_id),
      );
      return cards.length ? [{ ...message, cards }] : [];
    }),
  ];
  const historyUnavailable = history.isError && !history.data;
  const shownLocal =
    local &&
    !messages.some(
      (message) => message.client_message_id === local.draft.client_message_id,
    )
      ? local.message
      : null;

  useEffect(() => {
    const visual = window.visualViewport;
    if (!visual) return;
    const update = () =>
      setViewport({
        height: visual.height,
        top: visual.offsetTop,
        keyboard:
          window.innerWidth < 768 && window.innerHeight - visual.height > 120,
      });
    update();
    visual.addEventListener("resize", update);
    visual.addEventListener("scroll", update);
    return () => {
      visual.removeEventListener("resize", update);
      visual.removeEventListener("scroll", update);
    };
  }, []);
  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 120)}px`;
  }, [text]);
  useLayoutEffect(() => {
    const element = list.current;
    if (!element || !history.data) return;
    if (prepend.current) {
      element.scrollTop =
        prepend.current.top + element.scrollHeight - prepend.current.height;
      prepend.current = null;
    } else if (!initialScroll.current || follows.current) {
      element.scrollTop = element.scrollHeight;
      initialScroll.current = true;
    }
  }, [history.data, shownLocal, send.isPending, viewport.height]);
  useEffect(() => {
    const element = list.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (follows.current && initialScroll.current && !prepend.current)
        element.scrollTop = element.scrollHeight;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  async function earlier(retry = false) {
    const element = list.current;
    if (
      !element ||
      loadingEarlier.current ||
      !history.hasNextPage ||
      (history.isFetchNextPageError && !retry)
    )
      return;
    loadingEarlier.current = true;
    prepend.current = { height: element.scrollHeight, top: element.scrollTop };
    try {
      const result = await history.fetchNextPage();
      if (result.isError) prepend.current = null;
    } finally {
      loadingEarlier.current = false;
    }
  }
  function changeDraft() {
    if (send.isError) {
      setLocal(null);
      send.reset();
    }
  }
  async function submit(retry = false) {
    if (
      sending.current ||
      preparingPhoto ||
      history.isPending ||
      historyUnavailable ||
      (!text.trim() && !image)
    )
      return;
    sending.current = true;
    const draft =
      retry && local
        ? local.draft
        : createChatDraft({ text: text.trim() || undefined, image });
    const message: ChatMessage = {
      id: draft.client_message_id,
      client_message_id: draft.client_message_id,
      role: "user",
      text: draft.text ?? "",
      cards: [],
      had_image: !!draft.image,
      status: "pending",
      created_at: new Date().toISOString(),
    };
    setLocal({ draft, message });
    try {
      await send.mutateAsync(draft);
      setText("");
      setImage(undefined);
      setLocal(null);
    } catch {
      setLocal({ draft, message: { ...message, status: "error" } });
    } finally {
      sending.current = false;
    }
  }

  const error = send.error;
  return (
    <section
      className="chat-screen"
      data-keyboard={viewport.keyboard}
      style={
        {
          "--chat-viewport": viewport.height
            ? `${viewport.height}px`
            : "100dvh",
          "--chat-top": `${viewport.top}px`,
        } as CSSProperties
      }
      aria-label="Food conversation"
    >
      <header className="app-header shrink-0 border-b border-[var(--app-line)] px-5 sm:px-8">
        <div className="mx-auto flex min-h-20 max-w-2xl items-center justify-between">
          <Brand />
          <HeaderLink href="/history">View history</HeaderLink>
        </div>
      </header>
      <DailyStrip />
      <div
        ref={list}
        className="chat-messages min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 sm:px-8"
        tabIndex={0}
        aria-label="Messages"
        onScroll={() => {
          const element = list.current!;
          follows.current = nearBottom(element);
          setAtBottom(follows.current);
          if (element.scrollTop < 40 && initialScroll.current) void earlier();
        }}
      >
        <div className="mx-auto max-w-2xl py-6">
          <h1 className="sr-only">Chat</h1>
          {history.isPending && (
            <LoadingSkeleton
              label="Loading your conversation…"
              kind="chat"
              className="min-h-80 py-4"
            />
          )}
          {historyUnavailable && (
            <div role="alert" className="py-8 text-center">
              <p>Your conversation couldn’t load.</p>
              <button
                className="chat-text-button"
                onClick={() => void history.refetch()}
              >
                Retry conversation
              </button>
            </div>
          )}
          {history.hasNextPage && (
            <div className="mb-6 text-center">
              <button
                disabled={history.isFetchingNextPage}
                className="chat-text-button"
                onClick={() => void earlier(true)}
              >
                {history.isFetchingNextPage
                  ? "Loading earlier…"
                  : history.isFetchNextPageError
                    ? "Retry earlier messages"
                    : "Load earlier messages"}
              </button>
            </div>
          )}
          {history.data && !messages.length && !local && (
            <div className="py-10 sm:py-16">
              <p className="mb-3 text-xs font-medium uppercase tracking-widest text-[var(--app-accent)]">
                Your daily food log
              </p>
              <h2 className="text-3xl font-semibold tracking-tight">
                Start with what you ate.
              </h2>
              <p className="mt-3 max-w-sm text-sm leading-6 text-muted-foreground">
                A meal, a quick snack, or a question about your day. Describe it
                in your own words.
              </p>
              <div className="mt-7 flex flex-col items-start gap-2">
                {prompts.map((prompt) => (
                  <button
                    key={prompt}
                    className="min-h-11 rounded-xl border border-[var(--app-line)] px-4 py-3 text-left text-sm hover:bg-[var(--app-surface)]"
                    onClick={() => {
                      setText(prompt);
                      textarea.current?.focus();
                    }}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          )}
          <ol className="space-y-6">
            {[...messages, ...(shownLocal ? [shownLocal] : [])].map(
              (message, messageIndex) => (
                <li
                  key={message.id}
                  className={
                    message.role === "user" ? "ml-auto max-w-[88%]" : "max-w-xl"
                  }
                >
                  <article
                    aria-label={`${message.role === "user" ? "You" : "Assistant"}${message.status === "pending" ? ", sending" : message.status === "error" ? ", failed" : ""}`}
                  >
                    <div
                      className={
                        message.role === "user"
                          ? "rounded-2xl rounded-br-md bg-[var(--app-accent-soft)] px-4 py-3"
                          : "py-1"
                      }
                    >
                      {message.had_image && (
                        <p className="mb-1 text-xs text-muted-foreground">
                          <Camera
                            size={12}
                            className="inline"
                            aria-hidden="true"
                          />{" "}
                          Photo
                        </p>
                      )}
                      {message.text &&
                        !(
                          message.text === "This meal was deleted." &&
                          message.cards.some(
                            (card) => card.kind === "meal" && !card.meal,
                          )
                        ) && (
                          <p className="whitespace-pre-wrap break-words text-[15px] leading-6">
                            {message.text}
                          </p>
                        )}
                      {!!message.cards.length && (
                        <MessageMealCards
                          message={message}
                          sourceType={messageSource(messages, messageIndex)}
                          onLoadContext={
                            history.hasNextPage
                              ? () => void earlier(true)
                              : undefined
                          }
                          loadingContext={history.isFetchingNextPage}
                          onClarify={() => textarea.current?.focus()}
                        />
                      )}
                    </div>
                    {message.status !== "sent" && (
                      <p className="mt-1 text-right text-xs text-muted-foreground">
                        {message.status === "pending"
                          ? "Sending…"
                          : "Couldn’t send"}
                      </p>
                    )}
                  </article>
                </li>
              ),
            )}
          </ol>
          <div
            role="status"
            aria-live="polite"
            className={
              send.isPending ? "mt-4 text-sm text-muted-foreground" : "sr-only"
            }
          >
            {send.isPending
              ? "Thinking…"
              : send.isSuccess
                ? `Assistant: ${send.data.assistant_message.text}`
                : ""}
          </div>
        </div>
      </div>
      {!atBottom && (
        <button
          className="chat-text-button mx-auto flex items-center gap-2"
          onClick={() => {
            if (list.current)
              list.current.scrollTop = list.current.scrollHeight;
            follows.current = true;
            setAtBottom(true);
          }}
        >
          <ArrowDown size={16} />
          Latest messages
        </button>
      )}
      <div className="shrink-0 border-t border-[var(--app-line)] bg-background px-4 py-3 sm:px-8 sm:py-4">
        <div className="mx-auto max-w-2xl">
          {send.isError && (
            <div role="alert" className="mb-3 text-sm">
              <p>
                {error?.message ||
                  "Your message couldn’t send. Your draft is still here."}
              </p>
              <div className="flex gap-3">
                <button
                  className="chat-text-button"
                  onClick={() => void submit(true)}
                >
                  Retry
                </button>
                {error instanceof ApiClientError &&
                  error.code === "ai_cap_reached" && (
                    <button
                      className="chat-text-button"
                      onClick={() => setManual(true)}
                    >
                      Log manually
                    </button>
                  )}
              </div>
            </div>
          )}
          <PhotoInput
            image={image}
            disabled={send.isPending}
            onPreparing={setPreparingPhoto}
            onChange={(next) => {
              changeDraft();
              setImage(next);
            }}
          />
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit(send.isError);
            }}
            className="rounded-2xl border border-[var(--app-line)] bg-[var(--app-surface)] p-2"
          >
            <label htmlFor="chat-message" className="sr-only">
              Message
            </label>
            <textarea
              ref={textarea}
              id="chat-message"
              rows={1}
              maxLength={2000}
              value={text}
              disabled={send.isPending || preparingPhoto}
              onChange={(event) => {
                changeDraft();
                setText(event.target.value);
              }}
              placeholder="What did you eat?"
              className="block max-h-[120px] min-h-11 w-full resize-none bg-transparent px-2 py-2 text-base leading-6 outline-none focus-visible:ring-2 focus-visible:ring-[var(--app-accent)]"
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing &&
                  event.keyCode !== 229 &&
                  window.matchMedia("(min-width: 768px) and (pointer: fine)")
                    .matches
                ) {
                  event.preventDefault();
                  void submit(send.isError);
                }
              }}
            />
            <div className="flex items-center justify-between">
              <div className="flex">
                <button
                  type="button"
                  aria-label="Log manually"
                  className="chat-icon-button"
                  disabled={send.isPending}
                  onClick={() => setManual(true)}
                >
                  <Plus size={20} />
                </button>
              </div>
              <button
                type="submit"
                aria-label="Send message"
                disabled={
                  (!text.trim() && !image) ||
                  send.isPending ||
                  preparingPhoto ||
                  history.isPending ||
                  historyUnavailable
                }
                className="chat-send-button"
              >
                <ArrowUp size={20} />
              </button>
            </div>
          </form>
          <p className="mt-2 text-center text-[11px] text-muted-foreground">
            Estimates can vary. Review your meal before saving.
          </p>
        </div>
      </div>
      {manual && <ManualLog open onOpenChange={setManual} />}
    </section>
  );
}
