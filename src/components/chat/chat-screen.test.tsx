// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "@/lib/api";
import { ChatScreen } from "./chat-screen";
import { nearBottom } from "./scroll-position";
import { queryKeys } from "@/hooks/use-api";
import type { ChatMessage, ChatResponse } from "@/types/api";

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof api>()),
  getMessages: vi.fn(),
  getDaily: vi.fn(),
  sendChat: vi.fn(),
}));
vi.mock("@/lib/image/downscale", () => ({
  downscale: vi.fn(
    async () => new Blob(["compressed"], { type: "image/jpeg" }),
  ),
}));
const user: ChatMessage = {
  id: "user-1",
  client_message_id: null,
  role: "user",
  text: "2 eggs and toast",
  cards: [],
  had_image: false,
  status: "sent",
  created_at: "2026-10-26T10:00:00Z",
};
const assistant: ChatMessage = {
  ...user,
  id: "assistant-1",
  role: "assistant",
  text: "Here is your estimate.",
};
const daily = {
  date: "2026-10-26",
  timezone: "UTC",
  consumed: { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
  targets: null,
  remaining: null,
  meals: [],
};
beforeEach(() => {
  vi.clearAllMocks();
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
  vi.mocked(api.getMessages).mockResolvedValue({
    messages: [],
    has_more: false,
  });
  vi.mocked(api.getDaily).mockResolvedValue(daily);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ChatScreen />
    </QueryClientProvider>,
  );
  return client;
}
async function ready() {
  await screen.findByText("Start with what you ate.");
}
function response(draft: api.ChatDraft): ChatResponse {
  return {
    user_message: {
      ...user,
      text: draft.text ?? "",
      had_image: !!draft.image,
      client_message_id: draft.client_message_id,
    },
    assistant_message: assistant,
    daily_summary: null,
  };
}

it("fills and focuses a first-use prompt without sending it", async () => {
  mount();
  await ready();
  fireEvent.click(screen.getByRole("button", { name: "2 eggs and toast" }));
  expect(
    (screen.getByRole("textbox", { name: "Message" }) as HTMLTextAreaElement)
      .value,
  ).toBe("2 eggs and toast");
  expect(document.activeElement).toBe(
    screen.getByRole("textbox", { name: "Message" }),
  );
  expect(api.sendChat).not.toHaveBeenCalled();
});
it("keeps failed text and photo, retries with the same ID, and renders exactly one successful turn", async () => {
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn().mockResolvedValue({ width: 500, height: 500, close: vi.fn() }),
  );
  vi.mocked(api.sendChat)
    .mockRejectedValueOnce(
      new api.ApiClientError("ai_unavailable", "Try again", true, 503),
    )
    .mockImplementationOnce(async (draft) => response(draft));
  const client = mount();
  await ready();
  const image = new File(["jpeg"], "meal.jpg", { type: "image/jpeg" });
  fireEvent.change(screen.getByLabelText("Choose meal photo"), {
    target: { files: [image] },
  });
  await screen.findByText("Photo ready");
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: user.text },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("Couldn’t send");
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
    user.text,
  );
  expect(screen.getByText("Photo ready")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText(assistant.text);
  const calls = vi.mocked(api.sendChat).mock.calls;
  expect(calls[1][0]).toBe(calls[0][0]);
  expect(calls[1][0].image).toBe(calls[0][0].image);
  expect(calls[1][0].image).not.toBe(image);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
  expect(screen.getAllByText(user.text)).toHaveLength(1);
  expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  expect(screen.queryByText("Photo ready")).toBeNull();
  expect(client.getQueryData(queryKeys.messages)).toBeTruthy();
});
it("shows a pending bubble, prevents double send and clears the draft only after success", async () => {
  let resolve!: (result: ChatResponse) => void;
  vi.mocked(api.sendChat).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  mount();
  await ready();
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: user.text },
  });
  fireEvent.submit(screen.getByRole("textbox").closest("form")!);
  fireEvent.submit(screen.getByRole("textbox").closest("form")!);
  await screen.findByText("Thinking…");
  expect(screen.getByRole("article", { name: "You, sending" })).toBeTruthy();
  expect(api.sendChat).toHaveBeenCalledTimes(1);
  await act(async () =>
    resolve(response(vi.mocked(api.sendChat).mock.calls[0][0])),
  );
  await screen.findByText(assistant.text);
});
it("editing a failed draft creates a new message ID", async () => {
  vi.mocked(api.sendChat)
    .mockRejectedValueOnce(new Error("Offline"))
    .mockImplementationOnce(async (draft) => response(draft));
  mount();
  await ready();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Eggs" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("Couldn’t send");
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "Three eggs" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText(assistant.text);
  const calls = vi.mocked(api.sendChat).mock.calls;
  expect(calls[0][0].client_message_id).not.toBe(calls[1][0].client_message_id);
});
it("Enter sends on desktop but Shift+Enter, IME, and mobile Enter do not", async () => {
  vi.mocked(api.sendChat).mockImplementation(async (draft) => response(draft));
  mount();
  await ready();
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "Eggs" } });
  fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
  fireEvent.keyDown(input, { key: "Enter", isComposing: true });
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false })),
  );
  fireEvent.keyDown(input, { key: "Enter" });
  expect(api.sendChat).not.toHaveBeenCalled();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true })),
  );
  fireEvent.keyDown(input, { key: "Enter" });
  await screen.findByText(assistant.text);
  expect(api.sendChat).toHaveBeenCalledTimes(1);
});
it("loads earlier messages using the oldest ID and preserves the viewport anchor", async () => {
  vi.mocked(api.getMessages)
    .mockResolvedValueOnce({ messages: [assistant], has_more: true })
    .mockResolvedValueOnce({
      messages: [{ ...assistant, id: "older", text: "Older meal" }],
      has_more: false,
    });
  mount();
  await screen.findByText(assistant.text);
  const list = screen.getByLabelText("Messages");
  let height = 1000;
  Object.defineProperties(list, {
    scrollHeight: { get: () => height },
    clientHeight: { value: 400 },
  });
  list.scrollTop = 20;
  fireEvent.click(
    screen.getByRole("button", { name: "Load earlier messages" }),
  );
  height = 1600;
  await screen.findByText("Older meal");
  expect(vi.mocked(api.getMessages).mock.calls[1][0]).toEqual({
    before: assistant.id,
  });
  expect(list.scrollTop).toBe(620);
});
it("does not pull a reader to the bottom when a reply arrives", async () => {
  vi.mocked(api.getMessages).mockResolvedValue({
    messages: [assistant],
    has_more: false,
  });
  vi.mocked(api.sendChat).mockImplementation(async (draft) => response(draft));
  mount();
  await screen.findByText(assistant.text);
  const list = screen.getByLabelText("Messages");
  Object.defineProperties(list, {
    scrollHeight: { value: 2000 },
    clientHeight: { value: 400 },
  });
  list.scrollTop = 500;
  fireEvent.scroll(list);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Eggs" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => expect(screen.queryByText("Thinking…")).toBeNull());
  expect(list.scrollTop).toBe(500);
  fireEvent.click(screen.getByRole("button", { name: "Latest messages" }));
  expect(list.scrollTop).toBe(2000);
});
it("offers a working manual form when the AI cap is reached", async () => {
  vi.mocked(api.sendChat).mockRejectedValue(
    new api.ApiClientError("ai_cap_reached", "Daily limit reached", false, 429),
  );
  mount();
  await ready();
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Eggs" } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await screen.findByText("Daily limit reached");
  fireEvent.click(
    within(screen.getByRole("alert")).getByRole("button", {
      name: "Log manually",
    }),
  );
  expect(await screen.findByRole("dialog")).toBeTruthy();
  expect(screen.getByLabelText("Meal name")).toBeTruthy();
});
it("recognizes the near-bottom threshold", () => {
  expect(
    nearBottom({ scrollHeight: 1000, clientHeight: 500, scrollTop: 450 }),
  ).toBe(true);
  expect(
    nearBottom({ scrollHeight: 1000, clientHeight: 500, scrollTop: 200 }),
  ).toBe(false);
});

it("keeps the composer usable after an earlier-page error and retries pagination separately", async () => {
  vi.mocked(api.getMessages)
    .mockResolvedValueOnce({ messages: [assistant], has_more: true })
    .mockRejectedValueOnce(new Error("Offline"))
    .mockResolvedValueOnce({
      messages: [{ ...assistant, id: "older", text: "Older meal" }],
      has_more: false,
    });
  mount();
  await screen.findByText(assistant.text);
  fireEvent.click(
    screen.getByRole("button", { name: "Load earlier messages" }),
  );
  await screen.findByRole("button", { name: "Retry earlier messages" });
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "Eggs" } });
  expect(
    (screen.getByRole("button", { name: "Send message" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
  expect(screen.queryByText("Your conversation couldn’t load.")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: "Retry earlier messages" }),
  );
  await screen.findByText("Older meal");
});
