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

Sandy's implementation paths contain only `.gitkeep` files until his branches
land. Import API types from `@/types/api` after H1 merges; do not create local copies.

## Project documentation

- [`docs/PRD.md`](docs/PRD.md): what we're building and why
- [`docs/plans/shared-contracts.md`](docs/plans/shared-contracts.md): API shapes, file ownership, handoff checkpoints
- [`docs/plans/sandy-backend-ai.md`](docs/plans/sandy-backend-ai.md): Sandy's plan (backend and AI pipeline)
- [`docs/plans/ken-frontend.md`](docs/plans/ken-frontend.md): Ken's plan (frontend)
