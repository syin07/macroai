import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { CookieMethodsServer } from "@supabase/ssr";
import { createFakeSupabase, signedIn, signedOut, stubSupabaseEnv, type FakeAuthState, type FakeSupabase } from "./__fixtures__/fake-supabase";

let fake: FakeSupabase;
let cookieMethods: CookieMethodsServer;
vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn((_url: string, _key: string, options: { cookies: CookieMethodsServer }) => {
    cookieMethods = options.cookies;
    return fake;
  }),
}));

const { updateSession } = await import("./proxy");

function given(state: FakeAuthState) {
  fake = createFakeSupabase(state);
}

function get(path: string) {
  return updateSession(new NextRequest(new URL(path, "http://localhost:3000")));
}

function redirectedTo(response: Response) {
  const location = response.headers.get("location");
  return location ? new URL(location).pathname : null;
}

describe("updateSession (proxy)", () => {
  beforeEach(stubSupabaseEnv);

  describe("signed out", () => {
    beforeEach(() => given(signedOut()));

    it.each(["/", "/chat", "/history", "/settings", "/onboarding", "/dev/api"])("redirects %s to /sign-in", async (path) => {
      const response = await get(path);
      expect(response.status).toBe(307);
      expect(redirectedTo(response)).toBe("/sign-in");
    });

    it.each(["/sign-in", "/sign-up", "/reset-password", "/not-approved", "/auth/callback"])("lets %s through", async (path) => {
      const response = await get(path);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("x-middleware-next")).toBe("1");
    });

    it("lets /api/cron/** through without a session (the route checks CRON_SECRET)", async () => {
      const response = await get("/api/cron/purge");
      expect(response.status).toBe(200);
      expect(response.headers.get("x-middleware-next")).toBe("1");
      expect(fake.auth.getClaims).not.toHaveBeenCalled();
    });

    it("answers /api/** with a JSON 401, never a redirect", async () => {
      const response = await get("/api/me");
      expect(response.status).toBe(401);
      expect(response.headers.get("location")).toBeNull();
      expect(await response.json()).toMatchObject({ error: { code: "unauthenticated", retryable: false } });
    });
  });

  describe("signed in, not approved", () => {
    beforeEach(() => given(signedIn(false)));

    it.each(["/chat", "/history", "/settings"])("redirects %s to /not-approved", async (path) => {
      const response = await get(path);
      expect(redirectedTo(response)).toBe("/not-approved");
    });

    it("doesn't loop on /not-approved", async () => {
      const response = await get("/not-approved");
      expect(response.headers.get("location")).toBeNull();
    });

    it("leaves /api/** to the route (which answers 403 JSON)", async () => {
      const response = await get("/api/me");
      expect(response.headers.get("x-middleware-next")).toBe("1");
      expect(fake.rpc).not.toHaveBeenCalled();
    });

    it("fails closed when the approval check errors", async () => {
      given(signedIn(true, { rpcError: "timeout" }));
      expect(redirectedTo(await get("/chat"))).toBe("/not-approved");
    });
  });

  describe("signed in and approved", () => {
    beforeEach(() => given(signedIn(true)));

    it.each(["/chat", "/history", "/api/me"])("lets %s through", async (path) => {
      const response = await get(path);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("x-middleware-next")).toBe("1");
    });

    it("doesn't check approval on public pages", async () => {
      await get("/sign-in");
      expect(fake.rpc).not.toHaveBeenCalled();
    });
  });

  it("writes refreshed session cookies onto pass-through and redirect responses", async () => {
    const refresh = () =>
      void cookieMethods.setAll!([{ name: "sb-access", value: "fresh", options: { path: "/", httpOnly: true } }], {
        "Cache-Control": "private, no-cache, no-store, must-revalidate, max-age=0",
      });

    given(signedIn(true, { onGetClaims: refresh }));
    const passed = await get("/chat");
    expect(passed.cookies.get("sb-access")?.value).toBe("fresh");
    expect(passed.headers.get("cache-control")).toContain("no-store");

    given(signedIn(false, { onGetClaims: refresh }));
    const redirected = await get("/chat");
    expect(redirectedTo(redirected)).toBe("/not-approved");
    expect(redirected.cookies.get("sb-access")?.value).toBe("fresh");
    expect(redirected.headers.get("cache-control")).toContain("no-store");
  });
});
