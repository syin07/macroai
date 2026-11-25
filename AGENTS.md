# MacroAI

Private, mobile-first, chat-based calorie and macro tracker (web app). Sandy owns the whole project (frontend, backend, AI pipeline, deployment) and builds it with AI coding agents.

- What we're building: `docs/PRD.md`
- API shapes and a map of the codebase: `docs/plans/shared-contracts.md`
- Step-by-step plans: `docs/plans/backend-ai.md` (backend + AI) and `docs/plans/frontend.md` (frontend)

Stack: Next.js (App Router) + TypeScript + Tailwind + shadcn/ui, Supabase (Postgres, Auth, RLS), Zod, TanStack Query, Vercel.

## Working rules

- Before starting work, find the first unchecked step in the relevant plan (backend or frontend), confirm it with Sandy, and work on that. Tick its boxes (`- [x]`) in the plan when the work is merged.
- Any file in the repo is in scope. There is no ownership split.
- Types in `src/types/api.ts` are the contract between the frontend and the API. Don't redefine them elsewhere; when you change them, update the Zod schemas in `src/lib/validation/` and `docs/plans/shared-contracts.md` in the same PR.
- The AI model never writes to the database directly; nutrition math lives in pure functions in `src/lib/nutrition/calc.ts`; daily totals come from saved records.
- Meal photos are never stored: no database rows, no storage buckets, no logs.
- Secrets stay server-side. Only `NEXT_PUBLIC_*` variables may appear in client code.
- Small branches (`sandy/<step>`), small PRs, and `npm run lint && npm run typecheck && npm test` passing before a PR.

## Focus

- Security first: every route authenticates, checks approval, validates with Zod, and uses the session user ID.
- Correctness of nutrition math and RLS matters more than speed. Write tests for both.
- Frontend: mobile first (375 px), light and dark themes, and every async action has loading, error (keeping input), and retry states. Components go through `src/lib/api/`, never `fetch` directly.
