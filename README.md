# MacroAI

A private, mobile-first web app for logging meals by chatting: type what you ate or send a photo, and it tracks calories, protein, carbs, and fat.

## Getting started

```bash
git clone https://github.com/syin07/macroai.git
cd macroai
./setup.sh ken      # or: ./setup.sh sandy
```

`setup.sh` tells your coding CLI who you are. It writes a personal, gitignored context file for Claude Code (`.claude/role.md`) and Codex (`AGENTS.override.md`). Then start your CLI in this folder and ask: "What's my next step?"

Re-run `./setup.sh` after pulling changes to `AGENTS.md`, because the Codex file is a copy of it.

## Local development

Use Node.js 24 LTS (also used by CI), then run:

```bash
npm ci
npm run dev
```

Open http://localhost:3000. The initial scaffold redirects to `/chat` and follows
the system theme. Vercel project setup and environment variables are managed by Sandy.

Before opening a PR, run `npm run lint`, `npm run typecheck`, `npm test`, and
`npm run build`. Vitest runs `src/**/*.test.ts` and `src/**/*.test.tsx` in Node by
default. Component tests can opt into the DOM with `// @vitest-environment jsdom`
at the top of each test file. The `@/` alias resolves to `src/` in both TypeScript
and Vitest.

H1's API types and Zod schemas are merged. Import API types from `@/types/api`;
do not create local copies.

## API development and mocks

Set `NEXT_PUBLIC_USE_MOCKS=1` in `.env.local`, restart `npm run dev`, and open
`/dev/api` to exercise the endpoints, fixtures, error responses, and pagination.
This playground is unavailable in production and when mock mode is off. Mock
state is held in memory and resets on reload; photos are never persisted.
AI fixture responses take 600–1,500 ms. The fixture scenarios are examples,
not an AI model or nutrition service.

Components call `src/lib/api/` or the hooks in `src/hooks/use-api.ts`; all network
requests go through the shared client. During integration, pass `{ mock: false }`
to an endpoint wrapper to use the real API while keeping other calls mocked.
Turn off mock mode for production once the backend is ready.

Create a chat draft with `createChatDraft()` and a save action with
`createSaveAction()`. Keep that object after a failed request and pass it back
to `sendChat()` or `saveMeals()` on retry so its identifier stays unchanged.
The query hooks copy the returned daily summaries into the cache and cancel
older daily requests that could otherwise overwrite them.

## Auth UI previews (H2 pending)

With mock mode enabled, open `/dev/auth` for sign-in, sign-up, unapproved-account,
network-error, and password-recovery scenarios. Use made-up credentials. These
stubs create no accounts, send no email, and retain only session metadata in
memory. Passwords and recovery tokens are never persisted. Both development
playgrounds return 404 in production.

The frontend boundary is `src/lib/api/auth.ts`. Until Sandy's H2 helpers land,
production authentication stays unavailable even if mock mode is enabled.
H2 integration must delegate to `src/lib/auth/client.ts`, verify the user and
approval through the real session/server, and use a verified recovery session
from the email callback. `?mode=update` selects the reset form; it never authorizes
a password change. Real OAuth, email delivery, approval enforcement, and session
persistence still need integration testing after H2.

## Meal card previews

With mock mode enabled, `/dev/meals` previews single/multiple proposals, photo
assumptions, clarification, saved, discarded, and deleted cards. It includes a
save-failure/retry scenario and returns 404 in production. Unsaved proposal edits,
discard state, and pending retry actions live only in the private browser-memory
query cache; navigation preserves them, while reload/sign-out clears them. The
current API has no route to persist a discarded proposal across devices.

A6's Edit action changes an unsaved proposal's name and consumed time. Full
portion/item editing and saved-meal edits are part of A7. Saves use server-returned
nutrition totals. Save all sends one request with one retained idempotency key.

## Project documentation

- [`docs/PRD.md`](docs/PRD.md): what we're building and why
- [`docs/plans/shared-contracts.md`](docs/plans/shared-contracts.md): API shapes, file ownership, handoff checkpoints
- [`docs/plans/sandy-backend-ai.md`](docs/plans/sandy-backend-ai.md): Sandy's plan (backend and AI pipeline)
- [`docs/plans/ken-frontend.md`](docs/plans/ken-frontend.md): Ken's plan (frontend)
