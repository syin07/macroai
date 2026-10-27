# Ken — Frontend Plan

**Role:** everything the user sees and touches: the Next.js app shell, pages, components, mobile behavior, theming, PWA, and the typed API client.
**Read with:** [`../PRD.md`](../PRD.md) (the what) and [`shared-contracts.md`](shared-contracts.md) (the exact data shapes and endpoints).
**Partner:** Sandy owns the backend and AI pipeline. Sandy's plan: [`sandy-backend-ai.md`](sandy-backend-ai.md).

Work top to bottom. Tick a box when it's merged to `main`. You never need to wait on Sandy: build against mock data (`NEXT_PUBLIC_USE_MOCKS=1`), then switch each screen to the real API when the matching checkpoint **(H#)** lands.

Ground rules for every step:

- Mobile first: design at 375 px wide, then check 768 px and 1280 px.
- Both themes: check every screen in light and dark before calling it done.
- Never call `fetch` directly from components. Go through `src/lib/api/` so mock mode and error handling work everywhere.
- Never put secrets in client code. Only `NEXT_PUBLIC_*` variables are allowed in the browser.
- Every async action has a loading state, an error state that keeps the user's input, and a retry.

---

## A0 — Contracts first (with Sandy)

- [ ] Walk through `shared-contracts.md` together with Sandy; push back now on anything awkward for the UI (e.g. fields you need on a card).
- [x] After **H1**, import the types from `src/types/api.ts`. Never redefine them locally.

## A1 — Project scaffold

Do this first: Sandy's routes go into this project.

- [x] `npx create-next-app@latest macroai --ts --app --tailwind --eslint --src-dir --import-alias "@/*"` in a temporary folder, then move its contents into the repo root. Merge its `.gitignore` into ours, and keep `README.md`, `AGENTS.md`, and `CLAUDE.md`.
- [x] `npx shadcn@latest init`; add components as you need them (start with: button, input, textarea, card, sheet, dialog, drawer, tabs, sonner, skeleton, progress, dropdown-menu, form, label, switch, separator).
- [x] Install: `lucide-react`, `@tanstack/react-query`, `next-themes`, `date-fns`, `date-fns-tz`, `zod`, `react-hook-form`, `@hookform/resolvers`, `vitest`, `@testing-library/react`, `prettier`, `prettier-plugin-tailwindcss`.
- [x] Create the folder structure from PRD §6.2. Per Ken's A1 handoff requirements, use only empty `.gitkeep` files in Sandy's folders; no `index.ts`, `api.ts`, or middleware placeholders.
- [x] `next-themes` provider in `src/app/layout.tsx`: default `system`, class strategy. A theme toggle comes later in Settings.
- [x] Mobile meta: `viewport` with `viewport-fit=cover`, a `theme-color` per scheme, and `env(safe-area-inset-*)` padding utilities.
- [x] PWA: `src/app/manifest.ts` (name "MacroAI", `display: "standalone"`, start URL `/chat`), 192/512 px icons plus a maskable icon and `apple-touch-icon` in `public/`.
- [ ] **Sandy owns deployment:** import `syin07/macroai` into Vercel and confirm preview builds on PRs. Ken reassigned Vercel setup to Sandy; not verified by this scaffold.
- [x] Add `npm run lint`, `npm run typecheck`, `npm test` scripts and a GitHub Action that runs them on PRs.

Scaffold handoff: Zod 4; strict TypeScript and `@/*` → `./src/*`; Vitest defaults to Node and picks up `src/**/*.test.{ts,tsx}`. DOM tests opt into jsdom per file. Node 24 LTS is used locally and in CI. `.env.example` remains trackable. Physical iPhone home-screen installation remains to be checked after Sandy deploys.

**Done when:** the empty app deploys to a Vercel preview URL, installs to an iPhone home screen, and follows the system dark mode.

## A2 — API client and mocks

- [x] `src/lib/api/client.ts`: a `request<T>(method, path, body?)` that parses `ApiError` into a typed `ApiClientError` (with `code`, `message`, `retryable`), handles `401` → redirect to `/sign-in` and `403 not_approved` → `/not-approved`, and switches to mocks when `NEXT_PUBLIC_USE_MOCKS=1`.
- [x] `src/lib/api/*.ts`: one typed function per endpoint in the contracts (`sendChat`, `getMessages`, `saveMeals`, `getMeals`, `getMeal`, `updateMeal`, `deleteMeal`, `undoDelete`, `getDaily`, `getMe`, `getGoals`, `putGoals`, `suggestGoals`, `getPreferences`, `patchPreferences`, `completeOnboarding`, `getMemories`, `patchMemory`, `deleteMemory`, `exportData`, `deleteAccount`).
- [x] `sendChat` builds `multipart/form-data` and generates `client_message_id` with `crypto.randomUUID()`. On retry, reuse the same ID.
- [x] `saveMeals` sends `Idempotency-Key` (the `proposal_id` for one card; a new UUID for save-all and manual entries, reused on retry).
- [x] `src/mocks/`: the fixtures listed in contracts §4, plus an in-memory mock "database" so save → daily summary → history behaves realistically in mock mode.
- [x] TanStack Query hooks in `src/hooks/` (`useDaily(date)`, `useMessages()` infinite query, `useMeals(filters)` infinite query, `useMe()`, `usePreferences()`, `useGoals()`, `useMemories()`). After any meal mutation, update the `daily` cache from the returned `daily_summary` instead of refetching.

**Done when:** a scratch page can call every function in mock mode and show the results.

A2 merged in PR #3 after Sandy’s approval. The API transport skips auth redirects when already on the destination page, preventing reload loops. Development playground: `/dev/api` with `NEXT_PUBLIC_USE_MOCKS=1`; unavailable in production. Chat drafts and save actions retain their IDs on retry; mocks remain in memory.

## A3 — App shell and navigation

- [x] Route groups: `src/app/(auth)/{sign-in,sign-up,reset-password,not-approved}/page.tsx` and `src/app/(app)/{chat,history,insights,settings,onboarding}/page.tsx`. `/` redirects to `/chat`.
- [x] Mobile (< 768 px): a bottom tab bar with Chat / History / Insights / Settings (Lucide icons: `MessageCircle`, `History`, `ChartLine`, `Settings`), fixed, respecting the safe-area inset.
- [x] Desktop (≥ 768 px): a left sidebar with the same four links. Content is centered with `max-w-2xl` on chat and `max-w-3xl` elsewhere.
- [x] Small header: the app name plus a contextual action slot.
- [x] Apple-like feel: system font stack (`-apple-system, BlinkMacSystemFont, "Inter", …`), 12–16 px radii, subtle surfaces (`bg-muted/50`), generous spacing, no gradients, no bouncy animations (150–200 ms ease-out max).

**Done when:** all four tabs navigate without full reloads on phone and desktop sizes in both themes.

A3 merged in PR #4 after Sandy’s approval. Includes the route shells, mobile tabs, desktop sidebar, safe-area spacing, and accessible navigation. Browser checks cover all four tabs at 375/768/1280 px in both themes. Physical-device checks remain A15.

## A4 — Auth screens

Build with mocks or stubs first; wire up after **H2**.

- [ ] Sign in: a "Continue with Google" button plus an email/password form (react-hook-form + zod), with links to sign up and reset password. Use Sandy's helpers from `src/lib/auth/client.ts`.
- [ ] Sign up: email, password, confirm; then a "check your email" state.
- [ ] Reset password: request form, plus the "set new password" form reached from the email link.
- [ ] Not approved: a friendly message, the signed-in email, and a sign-out button.
- [ ] Error messages for wrong password, unconfirmed email, and network failure.

**Done when (after H2):** both of you can sign in with Google and with email on the preview URL; a third account sees "not approved"; refreshing keeps you signed in.

A4 UI merged in PR #9 after Sandy’s approval. `/dev/auth` exercises the mock-only flows. H2 backend auth plumbing is now merged, but the frontend adapter in `src/lib/api/auth.ts` still needs to delegate to Sandy’s helpers. Production authentication remains unavailable until that wiring is done. The new-password form requires a recovery session; a URL flag alone cannot authorize a change. Keep A4 acceptance boxes open until real OAuth, email delivery, approval enforcement, and session persistence are verified.

## A5 — Chat screen

The core of the app. Spend the most polish here.

- [x] Layout (PRD §3.4): header → collapsible daily summary bar → message list → composer pinned to the bottom.
- [ ] Use `100dvh` and handle the mobile keyboard: the composer stays visible above it on iPhone Safari and Android Chrome (test both; use `visualViewport` resize if `dvh` alone isn't enough).
- [x] Message list: `useMessages()` infinite query; show the newest at the bottom; "load earlier" when scrolled to the top (keep scroll position steady when older messages are prepended); auto-scroll to the bottom on a new message only if the user was already near the bottom.
- [x] Bubbles: user messages right-aligned, assistant messages left-aligned and plain (no avatar clutter). Meal cards render inside the assistant message.
- [x] Sending: an optimistic user bubble (`status: pending`), then a typing indicator for the assistant. On error: mark the bubble failed, keep the text and photo in the composer, show "Retry" (same `client_message_id`). Handle `ai_cap_reached` with a "Log manually" button (opens A10's form).
- [x] Composer: an auto-growing textarea (max 5 lines), a photo button, a send button (disabled while empty or sending). Enter sends on desktop; on mobile, Enter adds a newline.
- [x] Empty state for a first-time user: 3 tappable example prompts ("2 eggs and toast", "Chicken bowl with double rice", "How much protein do I have left?").

**Done when (mock mode):** sending text shows the right card fixtures, errors keep the draft, and scrolling back loads older pages smoothly.

A5 merged in PR #12 after Sandy’s approval. Includes chronological pagination, anchored scrollback, optimistic sends, retained text/photo drafts, same-ID retry, first-use prompts, a totals strip, and manual-entry fallback. Cards are now provided by A6. A8 still adds photo resizing/camera/library/thumbnails; A9 expands the summary and A10 completes save/undo/manual cards. Physical iPhone Safari/Android Chrome keyboard checks and real chat endpoint integration remain open.

## A6 — Meal card

`src/components/meals/meal-card.tsx`.

- [x] Compact view: meal name, calories (large), P / C / F in grams, and a small "estimated" label when any item is `ai` or `inferred`.
- [x] States: `unsaved` (subtle dashed or outlined border; Save / Edit / Discard buttons), saved (a small check, no toast), `discarded` (collapsed, greyed: "Discarded"), deleted (`meal: null` → "This meal was deleted").
- [x] Expand (tap the card or a chevron): an item list with portion, macros, and a source badge (USDA / Open Food Facts / Label / Web / AI estimate / Manual; a link if `source_reference` is a URL); inferred items marked "assumed" in a muted style; a low-confidence dot on the portion; the `assumptions` text; the consumed-at time; totals.
- [x] Clarification: if `needs_clarification`, show `clarification_question` above the buttons, and focus the composer on tap.
- [x] Multiple proposals in one message: stacked cards plus one "Save all (3)" button. One request, one idempotency key.
- [x] Tap targets ≥ 44 px; macros use tabular numbers (`tabular-nums`).

**Done when:** every card fixture from contracts §4 renders correctly in both themes.

A6 merged in PR #15 at Ken’s request, with CI and the production build passing. Cards expand to portions, sources, assumptions, time, and totals; single/batch saves preserve retry identities and use server totals. Clarification focuses chat. Discard and unsaved name/time edits survive navigation in private browser memory, but reset on reload because the contract has no discard endpoint. `/dev/meals` covers all fixtures and failure/retry. Full item/portion and saved-meal editing remain A7; auto-save undo remains A10.

## A7 — Meal editor

`src/components/meals/meal-editor.tsx`: a bottom sheet on mobile (`Drawer`), a dialog on desktop.

- [ ] Edit the name, consumed-at date and time (native `datetime-local`), and each item's quantity and unit. Grams is editable directly, as one tap from the card.
- [ ] Add an item (name + grams, or manual macros), and remove an item.
- [ ] Manual macro override per item (switches that item to `nutrition_source: "manual"`).
- [ ] Live totals preview using `src/lib/nutrition/calc.ts` (Sandy's pure functions). The server's response is the final value.
- [ ] For a proposal: Save sends the edited proposal through `saveMeals`. For a saved meal: `updateMeal` with `version`; on `409 version_conflict`, refetch and show "This meal changed — review and save again".

**Done when:** editing grams updates totals instantly, and save works in mock mode (and in real mode after **H6**).

A7 implementation is on `ken/a7-meal-editor`, pending review/merge. Includes mobile Drawer/desktop Dialog, one-tap grams focus, quantity/unit conversion, item add/remove and repeated portions, manual overrides and label-per-100g entries, validation through Sandy's schemas, and previews through `src/lib/nutrition/calc.ts`. New foods require entered nutrition rather than guesses from name/weight. Edited proposals retain their save key on retry; saved edits retain item IDs and versions. A 409 fetches the latest meal, keeps the user's draft visible, and requires explicit loading/review before saving again. `/auth/meal-editor-preview` is a public, development-only mock page under the existing public auth namespace; production still returns 404. H6 real endpoint and physical phone checks remain pending; boxes stay open until merge.

## A8 — Photo input

- [ ] Photo button → a hidden `<input type="file" accept="image/*" capture="environment">`. Add a second option, "Choose from library", using the same input without `capture`.
- [ ] Downscale before upload in `src/lib/image/downscale.ts`: `createImageBitmap` (fall back to an `<img>` element), draw onto a canvas with the longest side 1024 px, `toBlob("image/jpeg", 0.8)`, and reject over 1.5 MB after compression. Test with an iPhone HEIC photo and a large Android photo.
- [ ] Show a thumbnail preview in the composer with a remove (×) button; the user can add a caption in the textarea.
- [ ] Keep the image only in memory (an object URL, revoked after send). Never in localStorage or IndexedDB.
- [ ] In the sent bubble, show a small "📷 Photo" chip (`had_image`), not the image itself, since the server doesn't keep it (PRD FR-15).

**Done when (after H5):** a photo taken on both your phones produces a card through the real API, and the upload is under 1.5 MB.

## A9 — Daily summary and dashboard

- [ ] Compact bar at the top of chat: `1,240 / 2,200 kcal` and three thin P / C / F bars. Tap to expand.
- [ ] Expanded: a calorie ring (SVG, no chart library needed), three macro progress bars with consumed / target / remaining, and today's meal timeline (time, name, kcal; tap → editor).
- [ ] Over target: the bar fills to 100% with an overflow segment in a neutral accent color, and the text reads "120 kcal over". No red alarm styling and no judgmental copy (PRD 3.5, 12.9).
- [ ] No goals set: show consumed only, with a "Set goals" link to Settings.
- [ ] Updates from `daily_summary` in mutation responses, with no extra fetch.

## A10 — Save modes, undo, and manual logging

- [ ] Auto-save mode: cards arrive already saved; show a compact "Saved · Undo" row on the card for 10 s (undo calls `deleteMeal`, then shows the undo option for the delete).
- [ ] Delete flow (from card, editor, or history): call `deleteMeal` → a toast "Meal deleted · Undo" until `undo_until` → `undoDelete` on tap.
- [ ] Manual logging: a "+" action in the composer menu opens a form (name, kcal, protein, carbs, fat, date/time) → `saveMeals` with `source_type: "manual"`. The result appears in chat as a saved card.

Combined A9/A10 implementation is on `ken/a9-a10-dashboard-save-modes`, pending review/merge. The chat summary includes compact macro bars, an SVG calorie ring, consumed/target/remaining values, neutral overflow styling, and a timezone-aware timeline opening A7's editor. Returned daily summaries update totals without another daily fetch. Newly received auto-saved cards offer Undo for 10 seconds; deletion uses the server's `undo_until`, with shared notifications, retry, expiry handling, and restoration. Cards and the editor share deletion actions; History will reuse them in A11. Manual logging validates through the shared schema, preserves retry identity, and inserts the returned saved meal into chat. This immediate manual card is kept in private browser memory and deduplicated against server messages; cross-device/reload chat placement depends on the backend emitting the linked message (the mock does). `/auth/dashboard-preview` is development-only and unavailable in production. Real H4/H6 integration and physical-device checks remain open; do not tick acceptance boxes before merge.

## A11 — History screen

- [ ] An infinite list grouped by day (sticky day headers showing that day's kcal total), newest first, from `useMeals()`.
- [ ] A search box (debounced 300 ms → `q`) and a date-range filter (from/to).
- [ ] Tap a meal → a detail sheet (the same expanded view as the card) with Edit and Delete.
- [ ] Empty and no-results states.

**Done when (after H6):** 200+ mock meals scroll smoothly and search filters correctly.

## A12 — Settings

- [ ] Sections: Appearance (System / Light / Dark → `patchPreferences` + `next-themes`), Logging (Confirm before saving / Auto-save), Goals (four number fields + "Recalculate" opening the onboarding goal step), Time zone (select, default detected), Memories (list with edit-in-place and delete; explain that deleting a memory doesn't delete chats and vice versa, per PRD FR-13), Data (Export nutrition CSV, Export nutrition JSON, Export full account JSON), Account (Sign out, Delete account with a type-DELETE confirmation dialog).

**Done when (after H3/H8):** every setting persists across reload and across devices.

## A13 — Onboarding

- [ ] Shown after the first sign-in when `me.onboarding_complete` is false. 4 short steps with a progress dots indicator, and "Skip" on optional steps:
  1. Time zone (pre-filled from `Intl.DateTimeFormat().resolvedOptions().timeZone`).
  2. Optional body stats + goal (age, height with a cm/ft-in toggle, weight with a kg/lb toggle, sex with a one-line explanation of why the formula asks, activity, lose/maintain/gain) → `suggestGoals`.
  3. Review suggested targets (editable) or enter your own → `putGoals`. The copy says these are estimates, not medical advice.
  4. Save mode choice with a one-line explanation of each.
- [ ] `completeOnboarding` → `/chat`.

## A14 — Insights tab (MVP-light)

- [ ] For the MVP: the last 7 recorded days as a simple list (date, kcal, protein) via `getDaily` per day, with a note that charts are coming. Full charts (Recharts) are P1.

## A15 — Polish and device testing

- [ ] Loading skeletons on every screen; no layout shift when data arrives.
- [ ] Accessibility: labels on icon buttons, focus rings, `aria-live="polite"` on the assistant's typing/response area, contrast checked in both themes.
- [ ] Real-device pass on iPhone Safari (browser and installed PWA) and Android Chrome: keyboard + composer, camera, safe areas, theme switching, back-gesture behavior.
- [ ] Lighthouse mobile on `/chat`: performance ≥ 90, accessibility ≥ 95.
- [ ] Remove the scratch pages; mock mode off in production.
- [ ] Release checklist with Sandy: PRD §19 Definition of Done, line by line.

---

## Shared Tasks (with Sandy)

- Photograph and weigh 15+ of your own real meals for the bake-off test set (see Sandy's B4 for the format). Weigh each component before it's combined.
- Review each other's PRs within a day; Sandy reviews anything touching `src/lib/api/` error handling, and you review any change to `src/types/api.ts`.
- Cross-account security pass before release: sign in as each other's test account and try to see the other's data.

## Later (P1, don't start before the MVP ships)

- Voice input (Web Speech API → composer text).
- Barcode scanning UI (ZXing camera view → Open Food Facts lookup).
- Nutrition-label photo flow.
- Insights charts (Recharts): daily calories, macro trends, weekly/monthly averages.
- Saved meals / favorites UI.
