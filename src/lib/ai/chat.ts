import { ApiErrorException } from "@/lib/api-error";
import { isAiCapReached } from "./cap";
import type { ChatContext } from "./context";
import type { AIProvider, ProviderMessage } from "./provider";
import { newTurnState, runTool, toolDefs, type ToolContext, type TurnState } from "./tools";
import type { RecordUsage } from "./usage";

// One chat turn: the model ↔ tools loop (PRD §5.7). The model decides which tools to call; the tools
// decide what actually happens, and TurnState records it. The reply text comes from the model, but
// the cards come only from TurnState, so a card never shows something that didn't happen.

// Model calls per turn. Tool calls the model asks for on the last call are not run: there would be
// no model call left to report on them.
export const MAX_TOOL_STEPS = 6;

// The reply when the daily AI cap is reached partway through a turn (after what the turn already did).
export const CAP_REACHED_REPLY = "You've reached today's AI limit, so I stopped here. You can still log and edit meals by hand.";

export interface ChatTurnDeps {
  provider: AIProvider;
  recordUsage: RecordUsage;
  // Runs before every chat model call; throws ApiErrorException("ai_cap_reached") at the daily cap.
  // The route passes its AiCapGuard (cap.ts). Extraction calls are checked inside ToolContext.analyze.
  checkCap: () => Promise<unknown>;
}

export interface ChatTurnResult {
  text: string;
  state: TurnState;
  capReached: boolean; // the turn stopped early at the daily AI cap
}

function aiUnavailable(cause: unknown): ApiErrorException {
  const error = new ApiErrorException("ai_unavailable");
  error.cause = cause; // for the route's server log; never sent to the client
  return error;
}

// A failed usage insert must not throw away an answer that was already paid for.
async function record(deps: ChatTurnDeps, model: string, usage: { inputTokens: number; outputTokens: number }) {
  try {
    await deps.recordUsage({ model, usage });
  } catch (error) {
    console.error("chat: could not record AI usage", error instanceof Error ? error.name : typeof error);
  }
}

const kcal = (value: number) => `${Math.round(value)} kcal`;

// What the turn did, in plain lines. Built only from TurnState, so it can't claim a save that didn't
// happen.
function workLines(state: TurnState): string[] {
  const lines: string[] = [];
  const saved = [...state.meals.values()];
  if (saved.length > 0) lines.push(`Saved: ${saved.map((meal) => `${meal.name} (${kcal(meal.totals.calories)})`).join(", ")}.`);
  for (const card of state.cards) {
    if (card.kind !== "proposal") continue;
    const { proposal } = card;
    lines.push(
      proposal.needs_clarification && proposal.clarification_question
        ? proposal.clarification_question
        : `${proposal.name}: about ${kcal(proposal.totals.calories)}. Save it if it looks right.`,
    );
  }
  if (state.cards.some((card) => card.kind === "meal" && card.meal === null)) lines.push("Deleted.");
  return lines;
}

// Used when the model ends without text (or the provider fails after tools already ran).
export function fallbackText(state: TurnState): string {
  return workLines(state).join("\n") || "Sorry, I couldn't finish that. Please try again.";
}

// Used when the cap stops the turn: what was done, then the limit message.
export function capReachedText(state: TurnState): string {
  return [...workLines(state), CAP_REACHED_REPLY].join("\n");
}

const didWork = (state: TurnState) => state.cards.length > 0 || state.mealChanged;

export async function runChatTurn(chat: ChatContext, tools: ToolContext, deps: ChatTurnDeps): Promise<ChatTurnResult> {
  const state = newTurnState();
  const defs = toolDefs(tools);
  const messages: ProviderMessage[] = [...chat.messages];
  let text = "";

  for (let step = 1; step <= MAX_TOOL_STEPS; step++) {
    try {
      await deps.checkCap();
    } catch (error) {
      // Before the first call nothing has happened: the route answers 429. Later, end the turn with
      // what it already did (an extraction that hit the cap shows up here as well).
      if (isAiCapReached(error)) {
        if (step === 1) throw error;
        return { text: capReachedText(state), state, capReached: true };
      }
      // The count couldn't be read: like a provider failure, keep finished work.
      if (didWork(state)) break;
      throw aiUnavailable(error);
    }

    let turn;
    try {
      turn = await deps.provider.chat({ system: chat.system, context: chat.context, messages, tools: defs });
    } catch (error) {
      // Work already done (a saved meal) must still be reported, or a retry would redo it.
      if (didWork(state)) break;
      throw aiUnavailable(error);
    }
    await record(deps, turn.model, turn.usage);

    if (turn.toolCalls.length === 0 || step === MAX_TOOL_STEPS) {
      text = turn.toolCalls.length === 0 ? turn.text : "";
      break;
    }

    messages.push({ role: "assistant", text: turn.text, toolCalls: turn.toolCalls, providerContent: turn.providerContent });
    const results = [];
    // One at a time: tool calls can depend on each other (save after propose) and write the same rows.
    for (const call of turn.toolCalls) results.push(await runTool(call, tools, state));
    messages.push({ role: "tool", results });
  }

  return { text: text.trim() || fallbackText(state), state, capReached: false };
}
