# MacroAI
## Product Requirements Document (PRD)

**Version:** 1.2
**Date:** October 26, 2026
**Status:** Agreed. Merged from Sandy's v0.2 and Ken's v1.0; merge conflicts resolved (Section 23).
**Project type:** Private, AI-powered nutrition tracking web application
**Development team:** Sandy (backend & AI pipeline) and Ken (frontend), using AI-assisted coding tools
**Deployment platform:** Vercel

---

# 1. Executive Summary

## 1.1 Product Overview

MacroAI is a mobile-first, AI-powered calorie and macronutrient tracking web application.

The product is inspired by Cal AI but replaces the traditional food-tracking experience with a conversational interface.

Users should be able to log meals naturally, as though messaging an AI assistant.

Examples:

- "I just ate 3 eggs and some toast."
- "Had a chicken bowl with double rice."
- "Here's my lunch." (Photo attached)
- "Actually, I only ate half of that."
- "How much protein do I have left today?"
- "What did I eat last Tuesday?"

The AI interprets these inputs and identifies foods, a food database supplies the nutrition values, and meals are recorded according to the user's chosen confirmation setting.

All meal records, chat history, preferences, and approved AI memories persist across sessions and devices unless explicitly deleted.

The product must remain visually minimal, fast, and easy to use, particularly on mobile devices.

## 1.2 Product Vision

**Make nutrition tracking feel as effortless as sending a message.**

MacroAI should combine:

1. The simplicity of a modern AI chat interface.
2. The food-recognition functionality of Cal AI.
3. The clean visual design of Apple Health and Apple Fitness.
4. A searchable, long-term personal nutrition history.

The experience should feel casual, intuitive, and personal rather than clinical, overly professional, or cluttered.

## 1.3 Intended Users

Initially, there will be only two approved users: the project's developers.

Each user must have a completely independent account, food history, goals, memories, and preferences.

The architecture should permit expansion later, but public registration, subscriptions, and multi-user social features are not part of the MVP.

## 1.4 Primary Goals

- Reduce the effort required to record daily nutrition. Typing a sentence or taking one photo, then confirming, should take under 10–15 seconds.
- Provide reasonably useful calorie and macro estimates from photos and text.
- Make food logging conversational.
- Allow effortless corrections to AI estimates.
- Preserve complete nutrition history over time.
- Personalize estimates using previous food logs and corrections.
- Present nutrition progress through a clean, mobile-friendly interface.
- Maintain private, independent accounts.
- Keep AI running costs low (target in Section 20).

## 1.5 Non-Goals

MacroAI v1 is not intended to be:

- A clinical nutrition or medical diagnosis tool.
- A fully autonomous dietary coach.
- A social fitness network.
- A weight-loss competition or gamified streak application.
- A subscription business.
- A substitute for accurately weighed food or nutrition labels.
- A native iPhone or Android app (web only for now; see P2).

Nutrition values should always be presented as estimates where appropriate.

---

# 2. Scope and Release Strategy

## 2.1 Development Constraint

Two developers primarily using AI coding tools will build this.

So the first release must prioritize polish and reliability in its central workflow rather than breadth of features.

The primary release objective is:

**User opens MacroAI → describes or photographs food → receives a useful estimate → confirms or edits → meal is saved → daily nutrition updates.**

Everything else should support this workflow.

## 2.2 Release Priorities

### P0 — Required for MVP

- Private user authentication.
- Google login and email/password login.
- Mobile-first chat interface.
- Text-based meal recognition.
- Photo-based meal recognition.
- FoodData Central nutritional lookup.
- Clearly labeled AI-only fallback estimates.
- Compact, expandable nutrition cards.
- Manual correction of food portions and macros.
- Conversational corrections.
- User-configurable auto-save or confirm-before-save behavior.
- Multiple meal recognition from a single message.
- Daily calorie and macro dashboard.
- Historical meal storage and browsing.
- Continuous chat history.
- Structured AI memory and preference tracking.
- Natural-language date handling.
- Manual nutrition logging.
- Daily calorie and macro goals.
- Basic history search.
- Cloud persistence and user isolation.
- Proper uploaded-photo deletion.
- Meal editing, deletion, and undo.
- Light and dark mode.
- Per-user daily cap on AI calls.
- Vercel deployment.

### P1 — Secondary, post-core features

- Browser speech-to-text food logging.
- Barcode scanning (Open Food Facts).
- Nutrition-label recognition.
- Web-search lookup for restaurant and branded items not in a database.
- Weekly and monthly charts.
- Comprehensive analytics.
- AI-generated trend analysis.
- Date-range filtering.
- Calendar-based meal browsing.
- Cached offline history access.
- More sophisticated AI coaching.
- Additional personalized goal recommendations.
- Saved meals and favorites.

### P2 — Future expansion

- Body-weight tracking.
- Weight-trend analysis.
- Adaptive macro goals based on weight changes.
- Wearable integrations.
- Restaurant menu integrations.
- Advanced recipe recognition.
- Richer nutritional breakdowns, including micronutrients.
- Automated meal suggestions.
- Native mobile applications.

**Release rule:** Do not hold back the MVP to complete P1 or P2 features.

Some architectural groundwork for P1 features (dates, data export, analytical queries) should still go into the MVP where it's straightforward.

---

# 3. User Experience and Visual Design

## 3.1 Design Philosophy

The application must be:

- Minimalist.
- Mobile-first.
- Chat-oriented.
- Casual and approachable.
- Clean and visually balanced.
- Fast and responsive.
- Free of unnecessary visual clutter.

The UI should resemble a modern messaging interface more than a traditional fitness dashboard.

Use Apple-inspired spacing, typography, subtle surfaces, and smooth interactions without directly copying another application's branded design.

Avoid excessive gradients, flashy animations, motivational pop-ups, and information-dense screens.

## 3.2 Theme

Support both light and dark mode.

Default to the device's system preference.

The user must be able to override this choice in settings.

Persist the theme preference per account.

## 3.3 Navigation Architecture

### Mobile

Main tabs:

1. Chat
2. History
3. Insights
4. Settings

The Chat tab is the default landing page.

A compact daily nutrition summary should be visible above the conversation, with the message composer fixed near the bottom.

### Desktop

Use a responsive sidebar containing navigation and recent chats, with the main content occupying the remaining space.

The interface should remain constrained to a readable central width rather than stretching chat bubbles across the entire screen.

### Navigation Principle

Chat is the primary interaction surface.

Other screens exist for inspecting and managing structured information.

Do not require users to navigate away from chat to perform ordinary food logging or corrections.

## 3.4 Chat Screen Layout

From top to bottom:

1. Small application header.
2. Expandable daily nutrition summary.
3. Scrollable conversation history.
4. AI replies and embedded meal cards.
5. Message input bar.
6. Photo upload and additional-action controls.

The input should remain accessible when the mobile keyboard is displayed.

Long conversations must scroll smoothly.

Support loading earlier messages without rendering the complete lifetime history simultaneously.

## 3.5 Daily Nutrition Summary

The chat page must contain a compact summary showing:

- Total calories consumed.
- Daily calorie goal.
- Remaining calories.
- Protein consumed and target.
- Carbohydrates consumed and target.
- Fat consumed and target.

An expanded dashboard may show a calorie progress ring, macro progress bars, and today's meal timeline.

Progress must remain readable if the user exceeds a target.

Do not imply exceeding a target is a personal failure.

## 3.6 Meal Cards

When the AI identifies a meal, it should return a compact card embedded in the conversation.

Example:

**Chicken & Rice Bowl**

- 620 estimated calories
- Protein: 48 g
- Carbs: 65 g
- Fat: 18 g

Actions:

- Expand details
- Edit
- Save, when confirmation is enabled
- Discard, when unsaved

Expanded details should display:

- Identified food items.
- Individual portion sizes. Grams should be editable in one tap.
- Calorie and macro values per item.
- Nutritional source (USDA, Open Food Facts, web, AI estimate, or manual), with a link where one exists.
- AI assumptions, including likely hidden ingredients such as cooking oil or sauces, shown as separate editable items.
- Estimated or database-backed status, and a flag on low-confidence portions.
- Meal date and time.
- Totals.

After saving, the card should show a subtle saved indicator rather than a disruptive notification.

## 3.7 Chronological Meal History

Meals should be organized chronologically based on when the food was consumed, not necessarily when the log was created.

Display meal name, time, calories, and macros.

Do not force users to classify entries into breakfast, lunch, dinner, or snacks.

Meal classification may be inferred as optional metadata, but should not determine the main layout.

---

# 4. Core Functional Requirements

## FR-01 — Account Authentication

### Requirements

Users must be able to sign in with:

- Google OAuth.
- Email and password.

Only two explicitly approved accounts should be allowed initially.

Registration must not automatically grant application access.

Authentication must persist securely across page reloads and supported devices.

Support sign-out, password reset, and account deletion.

### Authorization

Every private record must belong to a specific user ID.

Users must never be able to retrieve another user's:

- Meals.
- Chat messages.
- AI memories.
- Personal measurements.
- Nutrition goals.
- Preferences.
- Uploaded images.

This restriction must be enforced server-side and in the database, not merely by hiding UI elements.

### Acceptance Criteria

- An unapproved account cannot access the application.
- User A cannot access User B's data through the UI or API.
- Refreshing the browser preserves a valid session.
- Signing out prevents access to protected pages.

---

## FR-02 — Text-Based Meal Logging

Users must be able to describe food naturally.

Example:

"Had 2 eggs, toast with butter, and a Fairlife protein shake."

### Required Behavior

The backend should:

1. Interpret the message.
2. Identify individual food items.
3. Extract explicit portion information.
4. Infer unspecified portions conservatively, using the default unit weights (5.5) and USDA portion data.
5. Identify relevant preparation details.
6. Search the nutrition database.
7. Calculate estimated nutrition values.
8. Create an editable meal proposal.
9. Save according to the user's confirmation setting.

The AI must not require the user to enter precisely formatted food descriptions.

Support informal language, abbreviations, and conversational phrasing.

### Acceptance Criteria

- A natural-language meal description produces a structured meal card.
- Individual foods can be edited before saving.
- Daily totals update after saving.
- Failed AI requests do not create incomplete meal records.

---

## FR-03 — Photo-Based Food Recognition

Users should be able to take a picture or upload an existing image.

### Required Behavior

1. Accept a photo through the mobile camera or file picker. A plain `<input type="file" accept="image/*" capture="environment">` opens the rear camera in both iPhone Safari and Android Chrome.
2. Validate file type and size, and downscale in the browser (longest side around 1024 px) before upload to cut upload time and AI cost.
3. Send the photo to a vision-capable AI model. By default, pass the bytes straight through in the request without writing them to storage (see FR-15).
4. Identify visible foods and likely ingredients.
5. Estimate portions.
6. Query the nutritional database.
7. Display an editable meal card.
8. Save the structured meal after confirmation or under auto-save rules.
9. Delete any temporary image per FR-15.

The user may add a text note with the photo ("fried, with ranch"), and it is passed to the model along with the image.

The system must distinguish between observed food and inferred ingredients.

For example, an image may show pasta and sauce, but oil or butter quantities might be unknown.

### Accuracy Requirements

Do not pretend the AI can reliably infer exact grams from a photograph.

Research shows photo-based trackers, Cal AI included, consistently **underestimate** calories and fat, mostly because of hidden oil, butter, and sauces (Appendix A.1). The model should therefore be prompted to list likely hidden ingredients as separate, editable items.

When portion size is uncertain, use a reasonable estimate and expose the assumption.

Ask clarifying questions only if uncertainty could significantly change the calculated nutrition.

For the MVP, define materially significant uncertainty as an estimated difference greater than approximately 20% of meal calories or 15 g of protein. These are product heuristics, not scientific confidence guarantees.

### Acceptance Criteria

- A recognizable meal photo returns a useful estimate.
- Unsupported or unreadable images return clear errors.
- Estimated foods and quantities can be corrected.
- Original photo bytes are not retained in permanent application storage.

---

## FR-04 — Nutrition Calculation Engine

The LLM should not be the primary calculator of nutritional totals.

LLMs are good at "that's grilled chicken, about 150 g" and bad at recalling exact nutrition values. Databases are the opposite. Splitting the job means every number can be traced to a source.

### Required Calculation Pipeline

1. LLM identifies the food.
2. LLM estimates or extracts portion size.
3. Backend searches a trusted nutrition database.
4. Backend selects or ranks appropriate food matches.
5. Nutrition values are normalized to the relevant serving size.
6. Backend calculates per-item and meal totals.
7. Results are displayed to the user.

### Nutrient Sources

| Source | Use for | Cost |
|---|---|---|
| **USDA FoodData Central** | Primary source for generic and whole foods; some branded foods | Free (data.gov key; 1,000 requests/hour) |
| **Open Food Facts** | Packaged products by barcode (P1) and branded-item matches | Free (ODbL license; must credit) |
| Web-search lookup (P1) | Restaurant and branded items not in either database | Per search (Appendix A.4) |

When available, use packaged-food data or manufacturer label information that matches the exact product.

Consider loading a downloaded USDA dataset into our own database instead of calling the API per request. This avoids the rate limit and is faster.

### Fallback Logic

If no reliable database match exists:

1. Attempt an appropriate food-category equivalent.
2. (P1) Run a web-search lookup restricted to trusted domains (restaurant nutrition pages, manufacturer sites). Show the source link. Cache the result so each item is only searched once.
3. If still unsuccessful, generate an AI-only estimate.
4. Mark the result as an AI estimate.
5. Allow manual correction.

Do not quietly substitute an unrelated food merely to avoid an AI fallback.

### Nutrition Fields

Required:

- Calories (kcal).
- Protein (g).
- Carbohydrates (g).
- Fat (g).

Optional for future versions:

- Fiber.
- Sugar.
- Sodium.
- Saturated fat.
- Other micronutrients.

### Mathematical Consistency

All calculations must be performed by deterministic application code.

The app should store the nutrition source, basis quantity, and derived totals.

Do not force total calories to equal exactly 4 × protein + 4 × carbs + 9 × fat, because source labels, fiber, and rounding can produce differences.

### Acceptance Criteria

- Doubling a food's portion doubles its nutritional contribution.
- Meal totals equal the sum of item values, subject to consistent rounding.
- Editing one food updates the meal and daily totals.
- Database-backed values are distinguishable from AI-only estimates.

---

## FR-05 — Conversational AI Assistant

The chat assistant is the primary interface.

### Tone

The assistant should be:

- Casual by default.
- Concise.
- Friendly without being overly enthusiastic.
- More detailed when asked.
- Direct and helpful.

Avoid lengthy introductions, repetitive disclaimers, or unnecessary coaching after ordinary food logs.

### Supported Intent Types

The assistant must recognize:

- New meal logging.
- Meal corrections.
- Meal deletion requests.
- Nutrition questions.
- Daily remaining-macro questions.
- Food history queries.
- Basic nutrition trend questions.
- Requests to explain nutritional assumptions.

### Examples

**User:** "How much protein do I have left?"

**AI:** "You're at 112 g out of 150 g today, so you've got 38 g left."

**User:** "Actually it was 200g of rice."

**AI:** Updates the correct meal and displays revised macros.

**User:** "What did I eat yesterday?"

**AI:** Queries the saved meal records and summarizes yesterday's entries.

### Important Behavior

The AI must retrieve actual stored data when answering account-specific questions.

It must never invent a meal record, saved preference, or historical total.

The AI must not silently change the user's nutritional goals.

---

## FR-06 — Conversation Context and Corrections

The AI should understand follow-up messages using recent conversation context.

Examples:

- "Remove the cheese."
- "I only ate half."
- "Make that two scoops."
- "That was actually lunch yesterday."

### Requirements

The AI must identify the intended target meal before performing mutations.

When several meals could match a correction, ask a short clarification question.

Once a correction is applied:

- Recalculate nutritional values.
- Update the meal record.
- Update affected daily totals.
- Display the new result.
- Save the correction in the audit history, and mark the item `edited_by_user`. User corrections double as free accuracy data showing where the AI was wrong.
- Consider whether it represents a reusable preference.

### Mutation Safety

AI-generated commands must go through validated backend functions.

The model must never write directly to database tables.

Corrections should update the existing entry rather than creating a duplicate.

Support undo for recent accidental changes.

---

## FR-07 — Multiple Meals per Message

The AI must support several meals described in one message.

Example:

"For breakfast I had eggs and toast. Lunch was chicken and rice. Dinner was pizza."

### Expected Behavior

- Detect three distinct meals.
- Generate three independent meal proposals.
- Infer dates and times only when sufficiently clear.
- Present separate editable cards.
- Allow each card to be edited.
- Provide one action to save all eligible cards together.
- Avoid creating duplicate records if the save action is retried.

When the user mentions food hypothetically rather than actually eating it, do not log it.

---

## FR-08 — Meal Save Behavior

Support two user-selectable modes.

### Mode A: Confirm Before Saving

Default setting.

The AI proposes a meal, then waits for confirmation.

The user can save, edit, or discard it.

### Mode B: Automatic Saving

The AI automatically saves sufficiently interpretable meals.

The user may undo the action or edit the record.

If essential details remain ambiguous, the AI should ask before saving.

### Requirements

- Every saved meal has a persistent ID.
- Repeated submission must not duplicate a meal.
- Unsaved cards must be visibly distinguishable from saved ones.
- Switching save modes must not retroactively modify previous meals.

---

## FR-09 — Natural-Language Dates and Times

The AI should understand phrases such as:

- "Yesterday."
- "Last night."
- "This morning."
- "Two hours ago."
- "Last Tuesday."
- "At 8 PM."

Use the user's configured time zone for date interpretation.

If no time is supplied, default to the current time when the meal is described as recently consumed.

All inferred timestamps must be editable.

Store the actual consumed-at timestamp separately from record creation time.

---

## FR-10 — Daily Macro Tracking

The application must track:

- Calories consumed.
- Protein consumed.
- Carbs consumed.
- Fat consumed.
- Daily targets.
- Remaining amounts.

### Dashboard Requirements

Include:

- Calorie progress ring.
- Protein progress bar.
- Carbohydrate progress bar.
- Fat progress bar.
- Chronological meal timeline.
- Easy access to editing logged meals.

The dashboard should be accessible directly from the chat screen without requiring a completely separate interaction flow.

### Data Integrity

Daily totals must be calculated from saved meal records.

Do not use totals invented or cached exclusively by the LLM.

Changing a meal's date must move its nutritional contribution to the correct day.

---

## FR-11 — Personalized Nutrition Goals

During onboarding, collect:

- Age.
- Height.
- Weight.
- Sex used for the chosen energy-expenditure equation, with appropriate explanation.
- Activity level.
- Goal: maintain, gain, or lose weight.
- Optional target weight.
- Optional preferred macro targets.

### Recommendation System

Use established estimation formulas, such as Mifflin–St Jeor, to estimate resting energy expenditure where required inputs are available.

Apply a user-selectable activity multiplier to estimate total daily energy needs.

Recommend calories based on goal.

Calculate initial protein and fat recommendations, then allocate remaining energy to carbohydrates.

AI may explain and contextualize recommendations, but the numerical baseline should come from transparent application logic.

### User Control

Users may manually override:

- Daily calorie goal.
- Protein target.
- Carbohydrate target.
- Fat target.

All changes should persist.

Goal estimates must not be presented as medical prescriptions.

Body-weight trend tracking is outside v1 scope.

---

## FR-12 — Nutrition History

Meal records must be stored indefinitely until deleted by the user or their account is removed.

### Required Features

- Chronological meal list.
- Date filtering.
- Basic food-name search.
- Full meal detail views.
- Manual meal editing.
- Meal deletion.
- Ability to access any historically retained meal.

For long-term scalability, use pagination and server-side filtering.

Do not load the entire history into the browser at once.

### Conversational History Queries

The AI must be able to retrieve history through database-backed tools.

Examples:

- "What did I eat last Tuesday?"
- "How much protein did I eat yesterday?"
- "When was the last time I logged salmon?"
- "What was my average calorie intake this week?"

Do not rely only on remembered chat messages.

---

## FR-13 — Persistent AI Memory

MacroAI should learn useful information from past interactions.

### Memory Categories

- Frequently eaten foods.
- Common portion sizes.
- Brand preferences.
- Dietary preferences explicitly shared.
- Repeated preparation methods.
- Corrections to previous food recognition.
- Preferred AI response style.
- User-approved assumptions relevant to future estimates.

### Example

A user regularly logs a specific protein shake.

The AI can later recognize a reference to "my usual shake" and use the previously saved product details.

### Memory Behavior

- Persist structured memories separately from chat messages.
- Associate each memory with a user ID.
- Store the source and creation date.
- Allow users to inspect, edit, and delete individual memories.
- Retrieve only relevant memories for each AI request.
- Avoid automatically promoting a one-time correction into a permanent fact when its meaning is unclear.

### Correction Learning

If a user corrects a serving size or brand, the AI should use that correction when recognizing the same food again.

Memories should not override clear information in the current message.

### Deleted Data

If a user deletes a saved AI memory, it must stop being used for personalization.

Deleting a chat does not automatically delete separately approved memories, and deleting a memory does not automatically erase the original chat. These controls must be clearly explained.

---

## FR-14 — Persistent Chat History

The application should present a continuous conversational experience.

### Requirements

- Store all chat messages until explicitly deleted.
- Preserve message ordering and timestamps.
- Support retrieval of old messages.
- Support conversation search.
- Allow deleting individual chats or conversation segments.
- Keep nutrition records independent from conversational content.
- Show nutrition cards within the appropriate messages.

A continuous chat UI may be backed by multiple internal conversation segments for technical scalability.

Previous messages should be searchable without transmitting the complete historical transcript to the LLM on every request.

### Context Retrieval

For each AI interaction:

1. Fetch recent relevant messages.
2. Retrieve relevant saved memories.
3. Retrieve relevant nutrition records when needed.
4. Provide a concise context package to the model.
5. Execute validated tools where authorized.

Do not send entire user histories to the model unnecessarily. Context size is also the main driver of AI cost per message.

---

## FR-15 — Photo Retention and Deletion

Meal photos are not stored long term.

### Required Policy

**Default: no storage.** The photo goes from the browser to our server route and straight to the AI model in the same request. It is never written to the database or file storage. Only the structured nutrition results and necessary metadata are kept.

**If temporary storage is needed** (e.g. a server-function payload size limit, or re-analysis during conversational corrections):

- Storage must be private and access-controlled.
- After a meal is successfully confirmed and saved, delete the source image and remove any temporary image reference.
- If a proposed meal is discarded, delete the associated temporary photo.
- If the user abandons a draft, an automated expiration process removes the photo after a short retention period. Recommended maximum: 24 hours, configurable.

Trade-off: without stored photos, old meals can't be re-run through a better model later or used to build a dataset. If that's ever wanted, it must be an explicit per-user opt-in.

### Third-Party Processing

The AI provider may have independent data-retention rules.

Application-level deletion does not guarantee immediate deletion of all third-party processing copies.

Select provider settings and processing methods that minimize unnecessary retention. Confirm the chosen provider does not train on API inputs, and record how long it keeps them.

### Verification

Test image deletion and ensure deleted image URLs can no longer be accessed.

---

## FR-16 — Meal Editing and Deletion

Users must be able to:

- Rename meals.
- Add or remove foods.
- Change portions.
- Edit calorie and macro values.
- Change consumed-at timestamps.
- Delete meals.
- Undo recent deletions.

### Deletion Flow

1. User requests deletion.
2. Entry becomes temporarily recoverable.
3. User receives a short undo opportunity.
4. Once the recovery window expires, the meal is permanently deleted.

Recommended undo window: 10 seconds.

Deletion should remove the meal and related food records without removing unrelated chat messages.

If chat messages reference deleted meals, the UI should display that the underlying meal entry is no longer available.

Prevent the AI from continuing to use deleted meals as active nutritional data.

---

## FR-17 — Manual Meal Logging

Users must be able to log food without AI.

Manual entry should support:

- Meal name.
- Calories.
- Protein.
- Carbs.
- Fat.
- Consumed-at date and time.

Manual entries should appear in chat and the daily timeline alongside AI-generated meals.

The system must not modify manually entered macro values unless explicitly instructed.

---

## FR-18 — Export and Account Deletion

### Data Export

Users must be able to export their nutrition data in:

- CSV.
- JSON.

CSV should include meal and food details with timestamps and nutritional values.

JSON should preserve structured relationships, metadata, and source information.

For the complete-account export, include chat history and structured memories.

### Account Deletion

Provide a deliberate account-deletion action.

This must permanently remove the user's application data according to the documented retention and backup policy.

Deleting one user's account must not affect the other user's data.

---

# 5. AI System Architecture

## 5.1 Architectural Principle

**Use AI for interpretation. Use deterministic code and stored records for calculations and persistence.**

The LLM should not independently decide that database writes succeeded.

All changes must be validated and executed by application code.

## 5.2 AI Responsibilities

The AI system should:

- Understand natural-language food descriptions.
- Interpret food photos.
- Identify likely ingredients.
- Extract serving sizes.
- Detect dates and times.
- Recognize user intent.
- Suggest meal corrections.
- Explain nutrition results.
- Respond conversationally.
- Retrieve relevant memories and history.
- Generate basic nutrition insights.

## 5.3 Non-AI Responsibilities

Application code should:

- Authenticate users.
- Authorize access.
- Query nutrition databases.
- Validate food matches.
- Calculate calories and macros.
- Save or edit meal records.
- Aggregate daily nutrition.
- Manage retention and deletion.
- Enforce confirmation settings.
- Generate exports.
- Record and limit API usage.

## 5.4 AI Provider Strategy

Use an interchangeable model-provider interface so the team can compare models without rewriting the application.

Use a single provider in production initially, to reduce integration complexity. Ideally the same provider handles text, photos, and (P1) web-search lookup, so there's one API key and one prompt style.

Add multi-provider routing only if benchmarks justify it.

### Choosing the Provider: Bake-off

Pick the model by running a bake-off on our own data (16.3), not by default or reputation. Candidates, one per provider (details and pricing in Appendix A.1):

| Candidate | Why it's in the running |
|---|---|
| Gemini 3.1 Flash-Lite (or 3.0 Flash) | Best calorie accuracy in the only multi-model benchmark found; Flash-Lite cheapest of the top group |
| Claude Haiku 5.5 (`claude-haiku-5-5`) | Cheapest per token on paper; strong structured output and tool use |
| An affordable OpenAI vision model with structured outputs | Ken's original recommendation |

Escalate to a larger tier (e.g. Claude Sonnet 5.5, Gemini Flash over Flash-Lite) only if the small models fail on mixed dishes.

### Model Selection Criteria

Evaluate candidates on:

- Food identification accuracy.
- Portion interpretation, including calorie and protein error against weighed meals.
- Structured-output reliability.
- Conversational context handling and tool calling.
- Latency.
- Cost per text request.
- Cost per photo request.
- Handling of uncertain foods.
- Data-retention and training policy for API inputs.

Do not automatically select the largest or most expensive available model.

## 5.5 AI Estimation Pipeline

```
 text ──┐
        ├─► A. classify intent ─► B. extract foods + grams ─► C. match in USDA / Open Food Facts ─► D. calculate ─► E. card ─► F. save
 photo ─┘                          (strict JSON schema)          │ no match?
                                                                 ├─► (P1) web-search lookup, cached
                                                                 └─► AI-only estimate, labeled
 barcode (P1) ───────────────────────────────────────────────► C. Open Food Facts by barcode ──────────────► D.
```

### Step A — Input Processing

Accept text and/or photo input.

Classify the request as logging, correction, question, or another supported intent.

### Step B — Food Extraction

Return structured food candidates containing:

- Food name.
- Portion quantity.
- Portion unit.
- Preparation method.
- Explicit or inferred attributes.
- Potential brand.
- Likely hidden ingredients (oil, butter, sauce) as separate inferred items.
- Uncertainty notes.

Informal units ("a handful", "a bowl", "a scoop") are converted using a small table of default gram weights per common unit, kept in application code, with USDA portion data filling in the rest.

### Step C — Nutrition Matching

Search USDA FoodData Central, or Open Food Facts for an exact packaged product when available.

Resolve the best candidate using food identity, preparation method, brand, and serving basis.

Check the nutrition lookup cache first.

### Step D — Nutrition Calculation

Convert portions into the nutrition record's appropriate reference quantity.

Calculate per-food nutritional contributions.

Sum the meal total.

### Step E — Presentation

Return a compact card, with expanded details available.

Mark uncertain or AI-only values appropriately.

### Step F — Persistence

Apply the account's saving preference.

Only the validated backend should persist the resulting records.

## 5.6 Response Schema

The AI should provide structured data rather than unstructured prose alone.

Suggested internal schema:

```json
{
  "intent": "log_meal",
  "meals": [
    {
      "name": "Chicken and Rice",
      "consumed_at": null,
      "foods": [
        {
          "name": "Cooked chicken breast",
          "quantity": 150,
          "unit": "g",
          "preparation": "grilled",
          "estimated_quantity": true,
          "inferred": false,
          "confidence": "high",
          "search_query": "chicken breast, grilled",
          "notes": null
        },
        {
          "name": "Cooked white rice",
          "quantity": 200,
          "unit": "g",
          "preparation": "boiled",
          "estimated_quantity": true,
          "inferred": false,
          "confidence": "medium",
          "search_query": "rice, white, cooked",
          "notes": null
        },
        {
          "name": "Cooking oil",
          "quantity": 1,
          "unit": "tsp",
          "preparation": null,
          "estimated_quantity": true,
          "inferred": true,
          "confidence": "low",
          "search_query": "oil, vegetable",
          "notes": "Chicken looks pan-cooked; oil amount not visible"
        }
      ],
      "needs_clarification": false
    }
  ]
}
```

The backend enriches this data with nutrition database matches and calculated totals.

All model-generated data must be validated against a strict schema (Zod).

Do not store or trust arbitrary tool instructions embedded in photos or chat content.

## 5.7 AI Tool Interface

The conversational system should use a small set of validated application tools:

- `search_nutrition_foods`
- `get_food_nutrition`
- `create_meal_proposal`
- `save_meal`
- `update_meal`
- `delete_meal`
- `get_daily_totals`
- `search_meal_history`
- `get_nutrition_goals`
- `search_user_memories`
- `save_user_memory`
- `delete_user_memory`

Tool names are proposed interface contracts and may be adjusted during implementation.

Every tool must enforce authenticated user identity and server-side authorization.

## 5.8 AI Memory Pipeline

1. Analyze whether an interaction contains reusable information.
2. Distinguish preferences from one-time facts.
3. Check for duplicate or conflicting memories.
4. Save a structured memory when appropriate.
5. Retrieve relevant memories during later interactions.
6. Display and allow deletion in settings.

For example, a corrected meal should not automatically imply that the user always eats that same portion unless enough context supports the preference.

## 5.9 Provider Failure Handling

If the AI provider fails:

- Keep the typed input or unsaved draft.
- Show a clear retry option.
- Do not create duplicate meal entries.
- Do not falsely claim the entry was saved.
- Offer manual logging.
- Avoid charging for redundant client retries where possible.

---

# 6. Recommended Technology Stack

## 6.1 Architecture

Use a single TypeScript-based web application.

Avoid microservices, separate backend hosting, and complex orchestration for this project.

### Recommended Stack

| Layer | Technology |
|---|---|
| Web framework | Next.js with App Router |
| Language | TypeScript |
| Styling | Tailwind CSS |
| UI components | shadcn/ui |
| Icons | Lucide |
| Installability | PWA manifest, so the app can be added to a phone's home screen |
| Authentication | Supabase Auth |
| Database | Supabase PostgreSQL |
| Database permissions | PostgreSQL Row Level Security |
| Server/API | Next.js Route Handlers |
| AI | Provider chosen by bake-off (5.4), behind a provider abstraction |
| AI schema validation | Zod |
| Nutrition data | USDA FoodData Central; Open Food Facts |
| Barcode scanning (P1) | ZXing or similar JS library (the browser's built-in `BarcodeDetector` isn't supported in Safari) |
| Deployment | Vercel |
| Client data fetching | TanStack Query or equivalent |
| Charts | Recharts, where required |

### Why This Stack

- Compatible with Vercel deployment.
- Frontend and backend can be maintained together.
- TypeScript provides shared data types.
- Supabase combines authentication and persistent data storage.
- PostgreSQL supports structured meals, history, and analytics.
- Row Level Security provides important user isolation.
- Tailwind and shadcn/ui accelerate polished UI development.
- The stack is manageable for two people.

## 6.2 Repository Structure

Suggested structure:

```text
src/
  app/
    (auth)/
    (app)/
      chat/
      history/
      insights/
      settings/
    api/
      ai/
      meals/
      nutrition/
      history/
      memories/
      export/
  components/
    chat/
    meals/
    dashboard/
    shared/
  lib/
    ai/
    nutrition/
    database/
    auth/
    validation/
    memory/
  types/
supabase/
  migrations/
tests/
  eval/          # bake-off and AI evaluation set
```

## 6.3 Environment Configuration

Store the following securely in environment variables:

- Supabase project URL.
- Supabase public client key.
- Supabase server-side administrative key, if required.
- AI provider API key.
- USDA FoodData Central API key.
- Approved user configuration.

Never expose private API keys in client-side code. Anyone could copy them from the page and run up our bill.

Never commit environment secrets to GitHub.

---

# 7. Database Design

Use PostgreSQL with explicit relationships and ownership.

## 7.1 Core Tables

### profiles

| Column | Description |
|---|---|
| id | User ID |
| display_name | User display name |
| timezone | Preferred time zone |
| created_at | Account creation time |
| updated_at | Last profile update |

### account_preferences

| Column | Description |
|---|---|
| user_id | Owning user |
| theme | Light, dark, or system |
| save_mode | Auto-save or confirmation |
| assistant_style | Preferred communication behavior |
| updated_at | Last change |

### nutrition_goals

| Column | Description |
|---|---|
| id | Goal record ID |
| user_id | Owning user |
| calorie_target | Daily calories |
| protein_target_g | Daily protein |
| carbs_target_g | Daily carbohydrates |
| fat_target_g | Daily fat |
| effective_from | Start date |
| effective_to | Optional end date |

Using effective dates permits historical goal comparisons.

### meals

| Column | Description |
|---|---|
| id | Unique meal ID |
| user_id | Owning user |
| name | Meal title |
| consumed_at | When meal was eaten |
| created_at | When logged |
| updated_at | Last change |
| source_type | Text, photo, barcode, or manual |
| total_calories | Calculated calories |
| total_protein_g | Total protein |
| total_carbs_g | Total carbs |
| total_fat_g | Total fat |
| status | Active or pending deletion |
| deleted_at | Optional deletion timestamp |

No photo column: photos are not kept (FR-15).

### meal_items

| Column | Description |
|---|---|
| id | Unique food item ID |
| meal_id | Parent meal |
| food_name | Identified food |
| quantity | Portion amount |
| unit | Portion unit |
| grams | Normalized weight, if known |
| calories | Item calories |
| protein_g | Item protein |
| carbs_g | Item carbohydrates |
| fat_g | Item fat |
| nutrition_source | usda, open_food_facts, label, web, ai, or manual |
| source_reference | Database ID or source URL |
| inferred | True for hidden ingredients the AI assumed rather than saw |
| confidence | AI confidence in the portion (high/medium/low) |
| edited_by_user | True once the user has corrected this item |
| assumptions | Notes on uncertainty |

### nutrition_cache

Shared reference data, not user-owned. Caches database and web-search lookups so each query is resolved once.

| Column | Description |
|---|---|
| query_key | Normalized search query, barcode, or food name |
| source | usda, open_food_facts, or web |
| source_reference | Database ID or source URL |
| per_100g | Calories, protein, carbs, fat per 100 g |
| portions | Known portion weights, if any |
| fetched_at | When retrieved |

### conversations

| Column | Description |
|---|---|
| id | Conversation ID |
| user_id | Owning user |
| title | Optional conversation title |
| created_at | Creation timestamp |
| updated_at | Last interaction |

### messages

| Column | Description |
|---|---|
| id | Message ID |
| conversation_id | Parent conversation |
| user_id | Owning user |
| role | User, assistant, or tool |
| content | Message text/structured payload |
| created_at | Timestamp |
| related_meal_id | Optional linked meal |
| status | Sent, pending, error, or deleted |

### user_memories

| Column | Description |
|---|---|
| id | Memory ID |
| user_id | Owning user |
| category | Memory category |
| content | Structured memory |
| source_message_id | Optional origin |
| created_at | Creation timestamp |
| updated_at | Last update |
| deleted_at | Optional deletion time |

### meal_revisions

Store changes to meals for debugging, correction history, and undo support.

Minimum fields:

- Revision ID.
- Meal ID.
- User ID.
- Previous structured values.
- Updated structured values.
- Change reason.
- Timestamp.

### temporary_uploads

Only needed if temporary photo storage is used (FR-15).

Minimum fields:

- Upload ID.
- User ID.
- Temporary storage path.
- Created time.
- Expiration time.
- Deletion status.

### ai_usage

Per-user AI call log, for the daily cap and cost tracking.

Minimum fields:

- User ID.
- Timestamp.
- Endpoint / intent.
- Model.
- Input and output tokens.
- Estimated cost.

## 7.2 Data Ownership

All directly user-owned tables must include a user ID.

Child records must remain accessible only through an authorized parent relationship.

Enable Row Level Security for all user data tables.

Create explicit ownership policies.

Use authenticated identity from the server session, not a client-supplied user ID.

## 7.3 Nutrition Data Accuracy

Store all nutritional quantities as numeric database values.

Use sufficient decimal precision for intermediate calculations.

Round for display rather than repeatedly rounding stored intermediate values.

Use consistent units throughout the backend.

## 7.4 Indexes

Create indexes for:

- Meals by user ID and consumed timestamp.
- Messages by conversation and timestamp.
- Memories by user and category.
- Meal items by parent meal.
- Nutrition cache by query key.
- Searchable food names where appropriate.

---

# 8. API Design

The full request/response shapes, error codes, and additional routes (messages, goals, preferences, profile, onboarding, account deletion) are in `docs/plans/shared-contracts.md`, which is the source of truth.

Core server routes:

| Route | Purpose |
|---|---|
| POST /api/ai/chat | Process chat instructions |
| POST /api/ai/analyze-meal | Analyze a text or photo meal |
| POST /api/meals | Save validated meal |
| GET /api/meals | Retrieve meals with filters |
| PATCH /api/meals/:id | Update a meal |
| DELETE /api/meals/:id | Delete a meal |
| POST /api/meals/:id/undo | Undo recent deletion |
| GET /api/nutrition/daily | Daily calorie and macro totals |
| GET /api/history/search | Search retained nutrition history |
| GET /api/memories | Retrieve saved AI memories |
| DELETE /api/memories/:id | Delete a memory |
| GET /api/export | Export account data |

### API Requirements

- Authenticate every private request.
- Validate all inputs.
- Enforce account ownership.
- Use consistent error structures.
- Prevent duplicate writes.
- Avoid logging sensitive content unnecessarily.
- Apply request-size limits.
- Rate-limit AI-powered endpoints, including a per-user daily cap.
- Support paginated historical queries.

Define API request and response schemas in shared TypeScript types.

---

# 9. Privacy and Security

## 9.1 Private Access

Only two approved accounts may access the deployed application.

A publicly accessible Vercel URL must not imply publicly accessible nutrition records.

Require authentication before loading protected information.

## 9.2 Isolation

Each account must have its own:

- Data.
- AI memories.
- Conversations.
- Goals.
- Personal preferences.

Even developers must not be able to retrieve each other's account information through ordinary application access.

## 9.3 Images

Photos must not be stored indefinitely. By default they are not stored at all (FR-15).

Any temporary image storage must be private and access-controlled.

Delete temporary photos when the meal is confirmed and saved or discarded.

Also clean up expired and abandoned uploads.

## 9.4 Retention

Meal history, chat history, and AI memories are retained indefinitely by default unless deleted.

Deletion must apply to the appropriate underlying records, not merely hide them from the UI.

Account deletion must include cleanup of dependent data.

Document backup retention separately.

## 9.5 Third-Party AI

Send only information relevant to the current AI request.

Do not include another user's data.

Do not unnecessarily transmit the complete historical chat.

Before launch, confirm the chosen provider's API data policy: inputs are not used for training, and how long they are retained. Choose zero- or short-retention settings where available.

## 9.6 Secret Management

AI and nutrition API credentials must remain server-side.

Rotate credentials if leaked.

Keep separate development and production environments where practical.

---

# 10. Performance and Cost Requirements

These are initial engineering targets, not promises about third-party model speed.

| Action | Target |
|---|---|
| Initial mobile page interaction | Under 3 seconds on a typical connection |
| Open an existing saved meal | Under 500 ms after data is available |
| Daily totals calculation | Under 1 second for normal personal-use history |
| Typical text meal analysis | Aim for under 8 seconds |
| Typical photo analysis | Aim for under 15 seconds |
| UI feedback after sending | Immediate loading state |
| Navigation | No unnecessary full-page reloads |
| AI cost per photo analysis | Aim for under $0.001 (under $1 per 1,000 photos; see Appendix A.1) |

Optimization techniques:

- Paginate messages and meal history.
- Cache nutritional reference data (`nutrition_cache`).
- Avoid reanalyzing foods unnecessarily.
- Downscale images in the browser before upload.
- Keep the AI context package small (FR-14).
- Load analytics charts only when needed.
- Use optimistic UI updates carefully, with rollback on failure.

---

# 11. Offline Behavior

In v1, the application requires internet access for AI analysis and database mutations.

Previously cached meal history may be displayed offline when feasible.

Offline views must clearly indicate that the data may not be current.

Do not pretend that unsynced entries are saved remotely.

Robust offline logging and synchronization are future features.

---

# 12. Error Handling and Edge Cases

## 12.1 Ambiguous Meals

**Input:** "Had some chicken."

Behavior: Estimate a typical serving with an explicit assumption, or ask a targeted follow-up if the uncertainty is substantial.

## 12.2 Unrecognized Photos

If the image cannot be interpreted as a meal, respond with a concise explanation and ask for text or another image.

Do not invent foods.

## 12.3 Hidden Ingredients

If cooking oil, sauce, or preparation style materially affects nutrition, include it as an inferred, editable item and flag the assumption.

Avoid asking about every minor ingredient.

## 12.4 Multiple Meals

Detect separate meals and provide independently editable cards.

Do not merge different meals just because they were submitted together.

## 12.5 Ambiguous Corrections

**Input:** "Remove the cheese."

If multiple relevant meals exist, ask which one.

Never modify a random meal.

## 12.6 Duplicate Submission

If a network retry sends an identical save request, create only one record.

## 12.7 Past-Date Logging

Use the user's intended consumed-at date, not automatically today's date.

## 12.8 Historical Edits

Editing an old meal must update the correct historical day's aggregate values.

## 12.9 Exceeded Macro Targets

Display the excess normally.

Do not hide negative remaining values or provide judgmental messaging.

## 12.10 AI Outages

Allow manual logging or retry.

Preserve unsaved drafts.

## 12.11 No Nutrition Match

Try the category equivalent, then (P1) web-search lookup, then a clearly identified AI fallback estimate.

## 12.12 Deleted Memories

Deleted memories must no longer appear in future AI personalization context.

## 12.13 Deleted Meals Referenced in Chat

The chat message may remain, but the meal must no longer count toward nutrition totals.

## 12.14 Out-of-Order Requests

Use request identifiers and authoritative saved record versions to prevent older AI replies from overwriting newer user corrections.

## 12.15 Daily AI Cap Reached

Tell the user plainly, and offer manual logging until the cap resets.

---

# 13. Analytics

## 13.1 MVP Analytics

Provide basic user-accessible information:

- Today's calorie total.
- Today's macro totals.
- Daily targets.
- Recent saved meals.
- Searchable historical totals.
- Simple date-based summaries through chat.

## 13.2 Advanced Analytics — P1

Add an Insights screen displaying:

- Daily calorie chart.
- Protein trends.
- Carbohydrate trends.
- Fat trends.
- Weekly averages.
- Monthly averages.
- Custom date ranges.
- Goal adherence.
- AI-generated summaries.

### AI Insights

AI insights must use actual aggregate data from the database.

Example:

"Your average protein intake over the last seven recorded days was 124 g."

If days are missing, distinguish recorded days from calendar days.

Avoid interpreting missing records as zero food consumed unless the user explicitly chooses that interpretation.

---

# 14. Future Input Methods

## 14.1 Voice — P1

Use browser-based speech recognition or a transcription API.

Flow:

1. User taps microphone.
2. Speaks a meal description.
3. App transcribes the audio.
4. User may review or edit the text.
5. Text enters the existing meal-analysis pipeline.

Voice is transcription-based, not a live spoken AI conversation.

## 14.2 Barcode Scanning — P1

Use the device camera to read supported barcodes with a JS library such as ZXing.

Resolve recognized products through Open Food Facts (free, 2.5M+ products). Barcode data comes straight from the label, so this is the most accurate input method.

Ask the user to confirm serving size.

If a barcode cannot be resolved, offer a nutrition-label photo or manual entry.

## 14.3 Nutrition-Label Photos — P1

Allow users to photograph nutrition-facts labels.

Extract serving size, calories, protein, carbs, and fats.

Display extracted values for confirmation before saving.

---

# 15. Onboarding

## Required Steps

1. Sign in through an approved account.
2. Set time zone, defaulting to the device's detected time zone.
3. Enter optional body measurements and fitness goal.
4. Generate suggested calorie and macro targets when enough information is available.
5. Review or manually override targets.
6. Choose auto-save or confirmation mode.
7. Enter the main chat interface.

Keep onboarding short and skippable for nonessential information.

Users must be able to modify goals later.

Do not require body measurements just to use meal logging.

---

# 16. Quality Assurance and Testing

## 16.1 Unit Tests

Test:

- Portion conversions, including the default unit-weight table.
- Nutrition calculations.
- Macro aggregation.
- Time-zone handling.
- Date parsing.
- Meal-edit recalculation.
- Deletion and undo.
- Authorization checks.

## 16.2 Integration Tests

Test:

- Login and session persistence.
- Text analysis through the nutrition database.
- Photo analysis.
- Meal creation and retrieval.
- AI tool invocation.
- Conversation correction.
- Historical search.
- Image cleanup.
- Cross-account isolation.
- Daily AI cap enforcement.

## 16.3 AI Evaluation Set and Model Bake-off

Create an internal benchmark of at least 20 representative cases:

- Simple single-item foods.
- Multi-item meals.
- Homemade food.
- Restaurant-style meals.
- Packaged foods.
- Ambiguous portions.
- Difficult images.
- Multiple meals per message.
- Conversational corrections.
- Historical nutrition questions.

**Weighed-meal subset.** At least 30 of the photo cases should be meals we actually eat, weighed on a kitchen scale and photographed, with true macros worked out from USDA data. This is the labeled reference dataset that makes accuracy numbers meaningful.

Measure:

- Food identification correctness.
- Appropriate database matching.
- Correct portion extraction when explicitly provided.
- Calorie and protein error on the weighed subset.
- Recognition of uncertainty.
- Valid structured responses.
- Whether the assistant properly requests clarification.
- Whether saved database results match the displayed card.
- Latency and cost per request.

Run every bake-off candidate (5.4) through the same prompts and cases, and pick the provider from the results. Keep the set in `tests/eval/` and re-run it whenever the model or prompt changes.

Do not claim exact photo-estimation accuracy without the labeled reference dataset.

## 16.4 Security Tests

Verify:

- Unapproved users are denied access.
- Accounts cannot read each other's data.
- Accounts cannot edit each other's data.
- Temporary image URLs expire or become inaccessible.
- API keys are never present in browser-delivered code.
- API errors do not leak sensitive data.

---

# 17. Build Order

Work in this order. There are no target dates. Each developer's detailed steps are in `docs/plans/sandy-backend-ai.md` and `docs/plans/ken-frontend.md`. If something runs long, protect the core logging workflow, authentication, privacy, and data integrity first, and move nonessential conveniences to the P1 backlog.

**Stage 1 — Foundation.** Initialize the Next.js project, TypeScript, and styling. Set up the repository and Vercel deployment pipeline. Connect Supabase.

**Stage 2 — Accounts and data.** Authentication, approved-account access, database schema, and Row Level Security policies.

**Stage 3 — Model bake-off** (can run alongside Stages 1–2). Build the evaluation set and weighed-meal subset, run the candidates, and pick the provider.

**Stage 4 — Chat shell.** Responsive chat layout, persistent chat messages, nutrition card components.

**Stage 5 — Text logging end to end.** AI text recognition with structured responses, nutrition database search and cache, calculation functions, meal saving, editing, and deletion, and daily totals.

**Stage 6 — Photo logging.** Photo analysis on the same pipeline, image handling per FR-15, and an end-to-end test of the logging workflow.

**Stage 7 — Conversation.** Conversational corrections, meal targeting, and date handling.

**Stage 8 — History.** Meal history, search, and historical queries through chat.

**Stage 9 — Personalization.** Persistent AI memories and memory management, onboarding, suggested targets, and preferences.

**Stage 10 — Export and polish.** Basic summaries, data export, responsive polish, loading and error states, deletion cleanup, AI cap.

**Stage 11 — Release.** Test user isolation and AI accuracy, manual testing on desktop and mobile, production deployment, and fixing release-blocking issues.

**Then:** both developers use it daily for two weeks before starting P1 work.

---

# 18. Team Responsibilities

Work is divided by ownership, with shared data contracts (`docs/plans/shared-contracts.md`). Run `./setup.sh sandy` or `./setup.sh ken` so your coding CLI knows your role.

## Ken — Frontend and Experience

Primary responsibilities:

- Responsive interface.
- Chat layout.
- Dashboard.
- Nutrition cards.
- Meal editor.
- Loading and error states.
- History interface.
- Mobile interaction testing.

## Sandy — Backend and AI

Primary responsibilities:

- Supabase schema.
- Authentication and authorization.
- AI integration and model bake-off.
- FoodData Central and Open Food Facts integration.
- Calculation engine.
- Meal persistence.
- AI memory.
- Data cleanup and export.

## Shared Responsibilities

- Data types and API contracts.
- Building the weighed-meal test set (both of us eat, weigh, and photograph).
- Integration tests.
- Security testing.
- Deployment.
- AI evaluation.
- Code review.

Use short feature branches and merge small tested changes frequently.

---

# 19. MVP Definition of Done

The MVP is complete when all of the following conditions are met.

### Accounts

- Both approved users can sign in.
- Unapproved accounts are blocked.
- Their data remains isolated.

### Chat

- Users can send and receive messages.
- Chat messages persist across refreshes.
- Chat history can be retrieved.
- The assistant correctly distinguishes ordinary questions from meal logging.

### Food Recognition

- Text meal input produces editable nutritional results.
- Photo input produces editable nutritional results.
- Nutritional information uses database matching where appropriate.
- AI-only fallback values are labeled.
- Users can correct estimated portions and macros.
- The AI provider was chosen through the bake-off, and its results are recorded.

### Meal Tracking

- Users can save, edit, and delete meals.
- Auto-save and confirmation modes work.
- Multiple meals can be submitted in one message.
- Historical meal timestamps are supported.
- Daily totals update correctly.

### AI Memory

- Useful preferences can persist between sessions.
- The AI can use relevant past corrections.
- Users can view and delete stored memories.
- Deleted memories are not reused.

### History

- Previously logged meals can be viewed.
- Food history can be searched.
- The assistant can answer factual questions based on saved records.
- Nutrition data can be exported.

### Privacy

- Photos are not retained, and any temporary photos are deleted according to policy.
- Private records are protected.
- Deletion behavior is functional.
- Sensitive API keys remain server-side.

### UI

- Works well on mobile and desktop.
- Supports light and dark mode.
- Uses compact expandable nutrition cards.
- Feels clean and conversational.
- Common food logging actions require minimal navigation.

### Deployment

- Application is accessible through the intended Vercel URL.
- Authentication is functioning in production.
- Production database migrations are applied.
- No critical errors remain in the principal user flows.

---

# 20. Success Metrics

Because this is initially a private personal-use project, prioritize practical usability over growth metrics.

Suggested targets:

| Metric | Initial target |
|---|---|
| Typical logging interaction | Under 15 seconds of active user effort |
| First meal logged | Within 60 seconds of a new user opening the app |
| Core flow success | 95%+ of tested scenarios without a blocking error |
| Persistent data | No lost confirmed meal records in normal operation |
| Nutrition totals | 100% consistency with stored meal-item calculations |
| Account isolation | Zero unauthorized cross-account access |
| AI structured-output validation | 99%+ valid responses after bounded retries |
| Mobile usability | Core logging flows work on common mobile viewport sizes |
| AI cost | Under $1 per 1,000 logged meals |
| Calorie error (weighed subset) | Aspirational: under ~15%. Set the real target after the first bake-off measurement |
| Daily use | Both developers use it daily for two weeks without returning to another tracker |

These are engineering acceptance targets, not measured product performance.

Food-estimation accuracy should be evaluated against the team's labeled test cases before defining a numeric accuracy promise.

---

# 21. Final Product Principles

All development decisions should follow these principles.

**1. Chat first.**
Users should interact naturally rather than navigate complicated forms.

**2. Accuracy over false precision.**
Nutrition estimates should expose uncertainty rather than imply exact measurements.

**3. The database is authoritative.**
Saved meals, calories, and history must come from structured records, not model recollection.

**4. Everything is editable.**
AI must never prevent users from correcting their own nutrition data.

**5. Personal memory is useful but controllable.**
Persist helpful information while allowing users to inspect and delete it.

**6. Long-term history matters.**
Users should be able to revisit any retained historical record regardless of age.

**7. Privacy is foundational.**
Separate accounts, restricted access, no photo retention, and secure backend operations are mandatory.

**8. Mobile simplicity wins.**
Optimize for quick interaction on a phone before adding desktop-specific complexity.

**9. Keep costs reasonable.**
Minimize unnecessary model calls, avoid repeatedly processing the same data, and cache safe reference results.

**10. Deliver the core experience first.**
A polished photo/text logging experience is more valuable than a collection of unfinished features.

---

# 22. Final Product Description

MacroAI is a private, mobile-first AI nutrition tracker that makes logging food as easy as texting an assistant.

Users can describe meals or upload photos, receive estimates of calories and macronutrients, correct results conversationally, and monitor their daily nutritional progress.

The application combines a minimalist chat interface with structured food tracking, persistent AI memories, detailed nutrition history, personalized goals, and privacy-focused data management.

Its initial release focuses on accurate-enough, convenient food logging and a clean conversational experience, with voice input, barcode scanning, and advanced analytics planned for later releases.

**Ultimate goal: Make calorie tracking feel less like filling out a spreadsheet and more like talking to an assistant that understands what you eat.**

---

# 23. Decisions and Open Questions

## Decisions

- 2026-10-26: Web app first (mobile-first, PWA); native apps are P2.
- 2026-10-26: Accounts required; two approved accounts only; Google + email/password sign-in.
- 2026-10-26: Meal photos are not stored long term; only structured results are kept.
- 2026-10-26: Name is MacroAI.
- 2026-10-26: Chat-first interface (from v1.0).
- 2026-10-26: AI provider is chosen by a bake-off (Gemini Flash-Lite vs Claude Haiku 5.5 vs an OpenAI model) behind a provider abstraction.
- 2026-10-26: Photos are sent straight to the model and never stored by default; temporary storage only if required, with v1.0's deletion rules.
- 2026-10-26: Web-search lookup for restaurant/branded items is P1; AI-only labeled fallback is in the MVP.
- 2026-10-26: Roles: Sandy owns backend and AI pipeline; Ken owns frontend.

## Open Questions

- **USDA data:** call the API per request, or load the downloaded dataset into Supabase? (Sandy decides during step B5.)

---

# Appendix A — Research: Models and Data Sources

Researched October 2026. Several prices come from third-party roundups that disagree with each other; verify on each provider's own pricing page before committing.

## A.1 Photo Recognition (Vision Models)

The best evidence found is a July 2026 preprint that benchmarked ten vision models on Nutrition5k, a dataset of real cafeteria plates with weighed ground truth. Not yet peer-reviewed.

| Model | Result in that benchmark | Notes |
|---|---|---|
| Gemini 3.0 Flash | Best calorie accuracy (MAE ≈ 81 kcal per plate) | Strong candidate |
| Gemini 3.1 Flash-Lite | Nearly as accurate, best at naming ingredients, cheapest of the top group (~$0.59 per 1,000 images) | Best value in the study; ~$0.25 / $1.50 per million input/output tokens |
| GPT-4o, GPT-5 mini, Claude Haiku 4.5, Qwen2-VL-7B | Also tested; individual scores not retrieved | Read the full paper |

Newer models not in that study:

- **Claude Haiku 5.5** (`claude-haiku-5-5`): $0.10 / $0.50 per million input/output tokens, roughly $0.30–0.50 per 1,000 photos. Cheapest on paper.
- **Claude Sonnet 5.5** (`claude-sonnet-5-5`): $2 / $10 per million tokens. Escalation option for mixed dishes.
- **Current OpenAI mini-tier vision model:** check pricing during the bake-off.
- **Open-source / on-device** (Qwen-VL family, fine-tuned food models such as Food-R1): free per request and private, but more work to host. Revisit later.

**Accuracy reality check:** an NIH study presented at NUTRITION 2026 tested MyFitnessPal, LoseIt!, Cal AI, and Appediet, and found photo-based apps significantly **underestimate** calories and fat. Hidden ingredients (oil, butter, sauces, dressings) are the usual cause. A 2024 study with dietitians found AI plus human review gives the most accurate results, which supports the editable-card design.

## A.2 Text Parsing

Easier than photos: any cheap model with structured output handles "2 eggs and toast" well. Use the same model as photos. The main challenge is informal units, handled by the default unit-weight table and USDA portion data.

## A.3 Nutrition Databases

| Source | Cost | Coverage | Verdict |
|---|---|---|---|
| **USDA FoodData Central** | Free (data.gov key; 1,000 requests/hour; DEMO_KEY far lower) | Generic and whole foods, lab-measured; some branded | **Primary source** |
| **Open Food Facts** | Free (ODbL; must credit) | 2.5M+ packaged products by barcode, crowdsourced | **Barcodes and branded items** |
| FatSecret Platform API | Free tier reported (verify) | ~1.9M foods incl. restaurants | Possible restaurant source |
| Edamam | Paid tiers (sources conflict, ~$49+/mo) | ~900K foods, natural-language parsing | Skip for now |
| Nutritionix | No free tier anymore (~$499/mo reported) | ~1.9M foods, restaurants, NL parsing | Too expensive |

## A.4 Web-Search Lookup (LLM with Internet Access)

For items no database has, such as "Chipotle chicken burrito" or "Trader Joe's mandarin chicken". This is a fallback, not the main path: it's slower (several seconds), costs more, and must show the source link.

| Option | Cost | Notes |
|---|---|---|
| Gemini + Grounding with Google Search | Gemini 3: 5,000 prompts/month free, then $14 per 1,000 searches | Pairs naturally if Gemini wins the bake-off |
| Claude + web search tool (`web_search_20260209`) | ~$10 per 1,000 searches plus tokens (verify) | Can restrict to trusted domains; returns citations |
| OpenAI web search tool | Check pricing | Pairs if OpenAI wins the bake-off |
| Perplexity Sonar API | Per-request pricing (check) | Extra vendor |

Use whichever provider wins the bake-off, and cache every result in `nutrition_cache`, since restaurant menus rarely change.
