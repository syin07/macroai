import { QueryClient } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { endAccountSession } from "./account-session";
it("cancels private queries, clears caches, and navigates to sign-in", async () => {
  const client = new QueryClient();
  client.setQueryData(["private"], { text: "private" });
  const navigate = vi.fn();
  await endAccountSession(client, navigate);
  expect(client.getQueryCache().getAll()).toHaveLength(0);
  expect(navigate).toHaveBeenCalledWith("/sign-in");
});
