# MacroAI release checklist

Updated 2026-10-28 for Ken's A15 local pass. This is a review handoff, **not a production release sign-off**. Ken confirmed there is no deployment yet and requested local work only. Sandy owns deployment and backend verification. The A11–A15 PR stack still needs review/merge; plan boxes are ticked only after merge and acceptance.

## Local A15 evidence

- Shared loading skeletons cover Chat/totals, History (existing), Insights, Settings, onboarding, account/recovery checks and meal detail. Reduced-motion settings disable skeleton animation. App routes have loading and safe error/retry fallbacks. Placeholder geometry reserves space; authenticated Lighthouse/CLS measurement remains pending.
- Global keyboard focus rings and route-change focus; modal Escape restores the opening control. Icon-only controls are named, form errors remain linked, and Chat's typing/response region remains `aria-live="polite"`.
- Muted light text uses neutral OKLCH 0.47 rather than 0.556; dark neutral 0.708 remains. Calculated contrast: light muted/white 6.83:1, light muted/surface 6.46:1, dark muted/surface 6.82:1. Local browser checks cover light/dark, 375/768/1280 widths and the short 375×568 chat layout. These are desktop browser checks, not physical-phone results.
- Meal editor and manual-entry code load on demand with loading feedback. No authenticated `/chat` performance or accessibility score is claimed without a deployed approved session.
- All auth UI operations call Sandy's real helpers outside development mocks. Password updates recheck recovery claims; a query string cannot authorize one. Provider errors are sanitized, failed inputs retained, and successful account transitions clear old query data.
- Production ignores `NEXT_PUBLIC_USE_MOCKS=1` and `{mock:true}`. Ten scratch routes and ten preview-only components are removed, leaving no debug controls. Test fixtures remain for automated tests.
- Regression tests cover real-helper delegation, production mock exclusion, verified recovery, route focus, retained errors and asynchronous editor loading. Full Windows testing still encounters the pre-existing `tests/eval/lib/eval.test.ts` URL pathname issue; Sandy should use `fileURLToPath(import.meta.url)` instead of `new URL(import.meta.url).pathname`. That backend-owned file is unchanged. Linux CI is the full-suite gate.
- Final local validation: lint/typecheck/production build pass; 52 focused tests pass; full suite 845/846 passes with only that existing Windows failure. The production build was made with `NEXT_PUBLIC_USE_MOCKS=1` deliberately set: all ten scratch route entries are absent; seven retired public preview URLs return 404, `/dev/*` stays behind default-deny auth, `/chat` redirects signed-out users and `/api/me` returns 401. Production sign-in buttons are enabled, with no preview banner/debug controls. A scan of all 37 emitted client JS files found zero mock-host/fixture/debug/banner signatures and zero configured server-secret variable/key-prefix patterns. This local placeholder-config scan does not replace checking the final deployed build.

## PRD §19, criterion by criterion

“Local” below means mock/component/unit evidence exists. Every row marked “Pending live” must be exercised against the deployed app before release, even when its local implementation is ready.

| Area | Definition of Done criterion | Current evidence / remaining work |
| --- | --- | --- |
| Accounts | Both approved users can sign in. | Frontend delegates all auth methods to H2 helpers; **pending live** Google and email/password for both users. |
| Accounts | Unapproved accounts are blocked. | Proxy/server and frontend approval routing tests; **pending live** third-account attempt. |
| Accounts | Their data remains isolated. | Server/RLS enforcement exists; **pending live**, Sandy: cross-account reads and writes through every route. |
| Chat | Users can send and receive messages. | Local send/retry UI tests; **backend pending H4**, then live send/reply. |
| Chat | Chat messages persist across refreshes. | Local fixtures retain correct shapes; **backend pending H4/H7**, then refresh/cross-device verification. |
| Chat | Chat history can be retrieved. | Local cursor pagination/anchoring tests; **backend pending H7**, then live scrollback. |
| Chat | The assistant correctly distinguishes ordinary questions from meal logging. | **Pending backend/live** classification and grounded-answer evaluation after H4. |
| Food Recognition | Text meal input produces editable nutritional results. | Local proposal/editor tests; **backend pending H4**, then real meals. |
| Food Recognition | Photo input produces editable nutritional results. | Local resize/upload UI tests; **backend pending H5**, then real iPhone/Android photos. |
| Food Recognition | Nutritional information uses database matching where appropriate. | Backend lookup/provenance pipeline; **pending live** inspect source matches on representative foods. |
| Food Recognition | AI-only fallback values are labeled. | Local card fixtures verify source/estimate labels; **pending live** H4/H5 fallback response. |
| Food Recognition | Users can correct estimated portions and macros. | Local editor/manual override/version-conflict tests; **pending live** save and reload corrections. |
| Food Recognition | The AI provider was chosen through the bake-off, and its results are recorded. | See PRD §20 and Sandy's B4 notes: text bake-off recorded; weighed-photo calorie accuracy is **not yet measured**. Sandy confirms selected provider/configuration and photo evidence. |
| Meal Tracking | Users can save, edit, and delete meals. | Local editor/delete/undo tests; H6 endpoints exist; **pending live** persisted CRUD. |
| Meal Tracking | Auto-save and confirmation modes work. | Local save-mode/undo tests; **pending live** H4/H6 plus refreshed preferences. |
| Meal Tracking | Multiple meals can be submitted in one message. | Local save-all/idempotency tests; **backend/live pending H4** multiple proposals and one atomic save. |
| Meal Tracking | Historical meal timestamps are supported. | Local native date/time and account-zone grouping tests; **pending live** edit across midnight/DST. |
| Meal Tracking | Daily totals update correctly. | Shared server-returned cache update tests; H6 exists; **pending live** save/edit/delete/undo totals. |
| AI Memory | Useful preferences can persist between sessions. | H8 backend/preferences exist; local Settings tests; **pending live** reload and second-device checks. |
| AI Memory | The AI can use relevant past corrections. | Backend memory retrieval exists; **pending live** H4/H8 grounded reuse. |
| AI Memory | Users can view and delete stored memories. | Local Settings list/edit/delete/retry tests; **pending live** persisted H8 actions. |
| AI Memory | Deleted memories are not reused. | Backend deletion/retrieval tests; **pending live** subsequent assistant turn after deletion. |
| History | Previously logged meals can be viewed. | Local 205-meal pagination/detail tests; H6 exists; **pending live** saved history. |
| History | Food history can be searched. | Local debounce/date-range/no-results tests; **pending live** H6 query results. |
| History | The assistant can answer factual questions based on saved records. | **Pending H4/live** grounded tool calls; never infer totals from conversation memory. |
| History | Nutrition data can be exported. | Local CSV/JSON download tests and H8 endpoints; **pending live** export known records and compare. |
| Privacy | Photos are not retained, and temporary photos are deleted according to policy. | Frontend memory-only object URLs/cleanup tests; **pending H5/live**, Sandy verifies no bytes in storage, DB or logs. |
| Privacy | Private records are protected. | Server auth/approval/RLS; **pending live** cross-account security review with Sandy. |
| Privacy | Deletion behavior is functional. | Local meal delete/undo/expiry and exact-DELETE account UI tests; **pending live** retention/purge/export behavior on disposable accounts. |
| Privacy | Sensitive API keys remain server-side. | Frontend uses public configuration only; local production client-bundle scan found zero server-secret patterns. **Pending deployed-build** scan with real configuration. |
| UI | Works well on mobile and desktop. | Local 375/768/1280 and short-phone checks; **pending physical devices**. |
| UI | Supports light and dark mode. | Local theme/save/contrast checks; **pending physical** system/manual theme transitions and reload. |
| UI | Uses compact expandable nutrition cards. | Local fixture/render/expand/edit tests; **pending live** H4 card payloads. |
| UI | Feels clean and conversational. | Local quiet system-font/sage design review; **pending joint** Ken/Sandy usability sign-off. |
| UI | Common food logging actions require minimal navigation. | Local chat composer/card/manual-entry flows; **pending physical/live** first-meal and daily-use checks. |
| Deployment | Application is accessible through the intended Vercel URL. | **Pending Sandy deployment**; Ken explicitly assigned Vercel to Sandy. |
| Deployment | Authentication is functioning in production. | H2 frontend wiring locally verified; **pending deployment** callbacks, allow-list, recovery and session persistence. |
| Deployment | Production database migrations are applied. | **Pending Sandy** confirmation against the intended production Supabase project. |
| Deployment | No critical errors remain in principal user flows. | Local automated/browser checks; **pending H4/H5/H7, security/device pass and joint release sign-off**. |

## Device and Lighthouse runbook (pending deployment)

Use disposable test records and each approved account. Do not paste passwords, tokens, photos or exported private data into logs/reports.

| Surface | Required check | Result |
| --- | --- | --- |
| iPhone Safari browser | Type a multiline caption; open/dismiss keyboard; composer and Send stay visible; safe areas and back gesture; rotate; system/manual themes. | Pending |
| iPhone installed PWA | Install from Safari; launch to approved Chat/onboarding; repeat keyboard/safe-area/theme/back checks. | Pending |
| iPhone camera/library | Real HEIC + camera capture; resized JPEG ≤1.5 MB and longest side ≤1024 px; remove/retry/send; no photo retained. | Pending H5 |
| Android Chrome | Repeat keyboard, camera/library (including a large image), rotation, safe areas, navigation and theme checks. | Pending H5 |
| Mobile Lighthouse `/chat` | Use deployed production build and an approved signed-in browser profile. Verify the audited final URL is `/chat`, not redirected sign-in. Performance ≥90, accessibility ≥95; save report/date/browser/build SHA. Fix findings and rerun. | Pending; no scores claimed |
| Layout stability | Record authenticated Chat/History/Insights/Settings/onboarding loading and completion; inspect actual layout shifts and keyboard transitions. | Pending measured CLS/device pass |
| Release approval | Ken and Sandy review every row above, record evidence/build SHA, merge reviewed PRs and confirm production configuration. | Pending |

Before release, remove/disable the mock env flag in deployment even though the client ignores it in production. Confirm `macroai-dev` Preview and `macroai-prod` Production data/configuration remain separate. Sandy manages these settings; A15 does not change Vercel.
