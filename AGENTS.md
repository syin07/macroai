# MacroAI

Private, mobile-first, chat-based calorie and macro tracker (web app). Two developers, two approved accounts.

- What we're building: `docs/PRD.md`
- API shapes and who owns which files: `docs/plans/shared-contracts.md`
- Step-by-step plans: `docs/plans/sandy-backend-ai.md` (backend + AI) and `docs/plans/ken-frontend.md` (frontend)

Stack: Next.js (App Router) + TypeScript + Tailwind + shadcn/ui, Supabase (Postgres, Auth, RLS), Zod, TanStack Query, Vercel.

## Working rules

- Before starting work, find the first unchecked step in the developer's plan, confirm it with them, and work on that. Tick its boxes (`- [x]`) in the plan when the work is merged.
- Stay inside the developer's ownership area (shared-contracts §1). If a change needs a file the other person owns, stop and say so. Suggest what to tell them instead of editing it.
- Types in `src/types/api.ts` are the contract. Don't redefine them; changes need the other developer's review and an update to `shared-contracts.md` in the same PR.
- The AI model never writes to the database directly; nutrition math lives in pure functions in `src/lib/nutrition/calc.ts`; daily totals come from saved records.
- Meal photos are never stored: no database rows, no storage buckets, no logs.
- Secrets stay server-side. Only `NEXT_PUBLIC_*` variables may appear in client code.
- Small branches (`sandy/<step>` or `ken/<step>`), small PRs, and `npm run lint && npm run typecheck && npm test` passing before a PR.

## Who you're working with

Your developer's role, plan, and file ownership come from `./setup.sh`, which generates a personal, gitignored context file (`.claude/role.md` for Claude Code, `AGENTS.override.md` for Codex). If you don't see a role section, ask the developer to run `./setup.sh sandy` or `./setup.sh ken` before doing anything else.
