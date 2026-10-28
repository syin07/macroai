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

Open http://localhost:3000. Signed-out users are sent to sign-in; approved users
complete onboarding before Chat. Configure the public Supabase settings from
`.env.example` for real authentication. Sandy manages Vercel and its environment variables.

Before opening a PR, run `npm run lint`, `npm run typecheck`, `npm test`, and
`npm run build`. Vitest runs `src/**/*.test.ts` and `src/**/*.test.tsx` in Node by
default. Component tests can opt into the DOM with `// @vitest-environment jsdom`
at the top of each test file. The `@/` alias resolves to `src/` in both TypeScript
and Vitest.

H1's API types and Zod schemas are merged. Import API types from `@/types/api`;
do not create local copies.

## API development and mocks

`npm test` exercises the in-memory API/auth fixtures, errors, pagination, and UI
flows without live accounts. A15 removes the `/dev/*` and `/auth/*-preview`
scratch routes and their controls. Those pages are no longer part of the app.

Components call `src/lib/api/` or the hooks in `src/hooks/use-api.ts`; all network
requests go through the shared client. During integration, pass `{ mock: false }`
to an endpoint wrapper to use the real API while keeping other calls mocked.
`NEXT_PUBLIC_USE_MOCKS=1` is available only outside production. Production ignores
both that flag and a per-call `{ mock: true }` override. Mocks create no real
session and never bypass the server's account/approval checks. Use real approved
Supabase accounts for app-route integration testing.

Create a chat draft with `createChatDraft()` and a save action with
`createSaveAction()`. Keep that object after a failed request and pass it back
to `sendChat()` or `saveMeals()` on retry so its identifier stays unchanged.
The query hooks copy the returned daily summaries into the cache and cancel
older daily requests that could otherwise overwrite them.

## Authentication and integration

The frontend boundary `src/lib/api/auth.ts` delegates to Sandy's helpers in
`src/lib/auth/client.ts` outside explicit development mocks. OAuth, email/password,
sign-up, reset email, session inspection, password update and sign-out are wired.
`?mode=update` selects the reset form; a verified recovery session is rechecked
before a password update. Successful sign-in/sign-out clears old private query data.

Real OAuth, email delivery, account approval, session persistence and cross-account
isolation still need deployment testing. Sandy's chat/photo/history endpoint
implementations are now merged; their end-to-end deployment checks remain. See the line-by-line
[release checklist](docs/release-checklist.md) for evidence and outstanding checks.

## Meal editing

Unsaved proposal edits,
discard state, and pending retry actions live only in the private browser-memory
query cache; navigation preserves them, while reload/sign-out clears them. The
current API has no route to persist a discarded proposal across devices.

A7's editor opens as a mobile drawer or desktop dialog. It edits names, time,
quantity/unit/grams, and items; a card's Edit grams action focuses that item.
Database portions use the shared calculator. Explicit overrides become Manual;
new foods need portion totals or label values per 100 g. Saves use server-returned
nutrition totals. Save all still sends one request with one retained key.

A version conflict fetches the latest meal but keeps edits until the user
explicitly loads it and saves again. The editor and manual-entry form load on
demand, keeping their code out of the initial conversation screen.

## Project documentation

- [`docs/PRD.md`](docs/PRD.md): what we're building and why
- [`docs/plans/shared-contracts.md`](docs/plans/shared-contracts.md): API shapes, file ownership, handoff checkpoints
- [`docs/plans/sandy-backend-ai.md`](docs/plans/sandy-backend-ai.md): Sandy's plan (backend and AI pipeline)
- [`docs/plans/ken-frontend.md`](docs/plans/ken-frontend.md): Ken's plan (frontend)
