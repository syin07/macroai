# Macro Tracker — PRD

v0.2 · 2026-10-26 · Owners: Sandy Yin + (friend's name TBD) · Working title, rename freely

## Overview & goals

A web app (built for phone browsers first) where you log what you ate by typing it ("2 eggs and a slice of sourdough") or snapping a photo, and it records calories, protein, carbs, and fat for the day. The hard part isn't the app, it's getting the numbers right, so this doc spends half its length on how to do that.

**Goals**

1. **Logging takes under 10 seconds.** Type a sentence or take one photo, confirm, done.
2. **Numbers you can trust.** Nutrition values come from a real food database wherever possible, not from an AI's guess. The AI's job is to figure out *what* and *how much*; the database says *how many calories*.
3. **Easy to correct.** Every guess (food, portion) is shown and editable before saving, because photo estimates are often wrong (see Research).
4. **Cheap to run.** Under $1 per 1,000 logged meals in AI costs at MVP scale, and no paid nutrition API until we need one.

**Success looks like**

- Calorie error under ~15% on our own test set of weighed meals (see "How we'll pick a model").
- A new user logs their first meal within 60 seconds of opening the app.
- We both use it daily for two weeks without going back to another tracker.

## Users

| User | Needs |
| --- | --- |
| Us (gym-goers tracking protein) | Fast logging, accurate protein, daily totals vs. a target |
| Casual tracker | Rough calorie count without weighing food |
| Strict tracker (cutting/bulking) | Gram-level edits, barcode scanning, saved meals |

## Features

### MVP

- **Text logging.** Free-form sentence → list of foods with portions → nutrition. Handles "a chipotle bowl with chicken, rice, beans" and "200g chicken breast".
- **Photo logging.** Take a photo with the phone's camera from the browser, or upload one → detected foods with estimated portions → nutrition. User confirms or edits each item. The photo is deleted once parsing finishes (see Photo privacy).
- **Review screen.** Every item shows food name, portion (editable: grams, cups, pieces), and macros. Low-confidence guesses are flagged.
- **Daily dashboard.** Calories, protein, carbs, fat vs. targets; list of today's meals.
- **History.** Past days, editable.
- **Targets.** User sets calorie and protein goals manually.
- **Accounts + sync.** Sign up / sign in (email or Google). Each user's log lives in the cloud, so it works across phone and laptop.

### Next (after MVP)

- **Barcode scanning** for packaged food. Cheapest and most accurate input there is, since the label data is exact.
- **Saved meals / favorites** ("my usual breakfast").
- **Restaurant items** via web lookup (see Research).
- Micronutrients (fiber, sodium, sugar), weekly trends, target suggestions from height/weight/goal.

### Not doing (for now)

- Native iPhone/Android apps. Web only for now; revisit once the web app is in daily use.
- Meal plans, recipes, social features, workout tracking, Apple Health / Google Fit sync.

## How a meal gets logged

```
 text ──┐
        ├─► 1. LLM: identify foods + estimate grams ──► 2. look up per-100g nutrition ──► 3. user reviews/edits ──► save
 photo ─┘         (structured JSON output)                 in a food database
                                                            │ not found?
                                                            └─► 2b. web-search LLM fallback (restaurant/branded items)
 barcode ─────────────────────────────────────────────► 2. Open Food Facts lookup by barcode ─────► 3.
```

**Why split it like this:** LLMs are good at "that's grilled chicken, about 150 g" and bad at remembering exact calorie counts. Databases are the opposite. Splitting the job means the AI never makes up the nutrition numbers when a database has them, and every number in the app can be traced to a source.

Step 1 output (example):

```json
{
  "items": [
    { "name": "grilled chicken breast", "grams": 150, "confidence": "high", "search_query": "chicken breast, grilled" },
    { "name": "white rice, cooked", "grams": 180, "confidence": "medium", "search_query": "rice, white, cooked" }
  ]
}
```

## Research

### 1. Photo recognition (which vision model)

The best evidence so far is a July 2026 preprint that benchmarked ten vision models on Nutrition5k (a dataset of real cafeteria plates with weighed ground truth). Not peer-reviewed yet.

| Model | Result in that benchmark | Notes |
| --- | --- | --- |
| Gemini 3.0 Flash | Best calorie accuracy (MAE ≈ 81 kcal per plate) | Strong default candidate |
| Gemini 3.1 Flash-Lite | Nearly as accurate, best at naming ingredients, cheapest of the top group (~$0.59 per 1,000 images) | Best value in the study |
| GPT-4o, GPT-5 mini, Claude Haiku 4.5, Qwen2-VL-7B | Also tested; we didn't get their individual scores | Read the full paper |

Newer models not in that study that are worth testing:

- **Claude Haiku 5.5** (`claude-haiku-5-5`): $0.10 / $0.50 per million input/output tokens, so roughly $0.30–0.50 per 1,000 photos. Cheapest option on paper.
- **Claude Sonnet 5.5** (`claude-sonnet-5-5`): $2 / $10 per million tokens. Use it if the cheap models fail on mixed dishes.
- The current OpenAI mini-tier vision model. Check pricing when we test.
- **Open-source / on-device** (Qwen-VL family, fine-tuned food models like Food-R1): free per request and private, but more work to host. Revisit later.

**Accuracy reality check:** an NIH study presented at NUTRITION 2026 found photo-based apps (including Cal AI) consistently **underestimate** calories and fat. Hidden ingredients like oil, butter, sauces, and dressings are the usual cause. What we'll do about it:

- Ask the model to list likely hidden ingredients ("cooked in oil?") as separate editable items.
- Let the user add a note with the photo ("fried, with ranch") and pass it to the model.
- Show portion confidence and make grams one tap to edit.

**How we'll pick a model:** we'll build our own small test set before committing. That means 30–50 meals we actually eat, weighed on a kitchen scale and photographed, with true macros worked out from USDA data. Then we run 3 candidates (Gemini 3.1 Flash-Lite, Claude Haiku 5.5, one OpenAI model) through the same prompt and compare calorie and protein error, cost, and speed. This takes about an afternoon and settles the question with our own data instead of someone else's benchmark.

### 2. Text parsing

Easier than photos: any cheap model with structured (JSON) output handles "2 eggs and toast" well. Use the same model as photos, so there's one provider, one API key, and one prompt style. The main challenge is units ("a handful", "a bowl"), so keep a small table of default gram weights per common unit, and let USDA's portion data fill in the rest.

### 3. Nutrition databases

| Source | Cost | Coverage | Use for |
| --- | --- | --- | --- |
| **USDA FoodData Central** | Free (data.gov key; 1,000 requests/hour) | Generic and whole foods, lab-measured; some branded foods | **Primary source** for step 2 |
| **Open Food Facts** | Free (ODbL license, must credit) | 2.5M+ packaged products by barcode, crowdsourced | **Barcode scanning** |
| FatSecret Platform API | Free tier reported (verify) | ~1.9M foods incl. restaurants | Possible restaurant source |
| Edamam | Paid tiers (sources conflict, ~$49+/mo) | ~900K foods, natural-language parsing | Probably skip |
| Nutritionix | No free tier anymore (~$499/mo reported) | ~1.9M foods, restaurants, NL parsing | Too expensive for now |

**Plan:** USDA + Open Food Facts are free and cover most meals. We could also download the USDA data and load it into our own database, which avoids rate limits and is faster.

### 4. Web lookup (LLM with internet access)

For things no database has, like "Chipotle chicken burrito" or "Trader Joe's mandarin chicken", a model with web search can find the restaurant's published nutrition page. This is the fallback, not the main path: it's slower (several seconds), costs more, and needs the source link shown to the user.

| Option | Cost | Notes |
| --- | --- | --- |
| Gemini + Grounding with Google Search | Gemini 3: 5,000 prompts/month free, then $14 per 1,000 searches | Pairs naturally if Gemini wins the vision test |
| Claude + web search tool (`web_search_20260209`) | ~$10 per 1,000 searches plus tokens (verify) | Can restrict to trusted domains (restaurant sites, USDA); returns citations |
| Perplexity Sonar API | Per-request pricing (check) | Built for search-answer; extra vendor |

**Plan:** use whichever provider wins the vision test, so there's still one API key. Cache every result (restaurant menus rarely change), so each item is only searched once across all users.

## Suggested stack (to discuss)

- **App:** Next.js (React) web app, designed for phone screens first. Make it a PWA so it can be added to the home screen and feel like an app.
- **Camera:** a plain `<input type="file" accept="image/*" capture="environment">` opens the phone's rear camera in both iPhone Safari and Android Chrome, so no camera library is needed. Shrink the image in the browser (to about 1024 px) before upload. That makes uploads faster and AI calls cheaper.
- **Barcodes (later):** a JS scanning library such as ZXing, since the browser's built-in `BarcodeDetector` doesn't work in every browser (notably Safari).
- **Accounts + database:** Supabase (Postgres + built-in auth with email and Google sign-in) or Firebase. Use row-level security so each user can only read their own entries.
- **Hosting:** Vercel (free tier fits Next.js).
- **Secrets:** the AI API keys **must** live in a server route, never in browser code, or anyone can copy them from the page and run up our bill. Add a per-user daily limit on AI calls for the same reason.
- **AI calls:** one server endpoint, `/parse-meal`, that takes text or an image and returns the reviewed-items JSON above.

## Data model (first pass)

- **User**: id, calorie_target, protein_target, (carb/fat targets optional)
- **MealEntry**: id, user_id, eaten_at, input_type (text/photo/barcode), raw_text (no photo field: photos aren't kept)
- **FoodItem**: id, meal_entry_id, name, grams, calories, protein_g, carbs_g, fat_g, source (usda/off/web/manual), source_id_or_url, confidence, edited_by_user
- **FoodCache**: query → nutrition per 100 g + source (for web lookups and repeat searches)

Storing `source` and `edited_by_user` on each item gives us free accuracy data: every user correction shows where the AI was wrong.

### Photo privacy

We don't store meal photos long term.

- The photo goes from the browser to our server route, then to the AI model, and is never written to our database or file storage. If it has to be uploaded to storage first (e.g. because of size limits on the server function), it gets deleted as soon as parsing finishes, and a daily cleanup job removes anything left over.
- What we keep is the parsed result (food names, grams, macros), which is all the dashboard needs.
- Check each AI provider's data policy: confirm that API inputs aren't used for training, and find out how long they keep them.
- Downside: we can't re-run old photos through a better model later, or build a dataset from them. If we ever want that, it should be an explicit opt-in per user.

## Milestones

1. **Research spike (1 week):** build the weighed test set; run the 3-model comparison; pick a provider.
2. **Text logging end to end:** sentence → USDA lookup → review → save → dashboard.
3. **Photo logging** on the same pipeline.
4. **Polish + daily use:** history, targets, editing; we both use it for 2 weeks.
5. **Barcode scanning + saved meals.**
6. **Web lookup fallback** for restaurants.

## Decisions

- 2026-10-26: Web app first (mobile-first, PWA); native apps later, if ever.
- 2026-10-26: Accounts are required (MVP).
- 2026-10-26: Meal photos are not stored long term; only parsed results are kept.

## Open questions (for both of us)

- Who owns what? (e.g. one person on app UI, the other on the AI pipeline and backend)
- Is this just for us, or open to anyone who signs up? (Affects privacy policy, sign-up limits, and AI cost caps.)
- Sign-in methods: email + Google only, or add Apple too?
- Name.

## Sources

- [Vision-Language Models for Image-Based Dietary Assessment: benchmark of ten models (bioRxiv, 2026)](https://www.biorxiv.org/content/10.64898/2026.07.26.740845v1)
- [Foodvision Bench: open food-recognition benchmark](https://github.com/foodvision-bench/foodvision-bench)
- [Fitia: AI calorie photo app accuracy roundup, incl. NIH NUTRITION 2026 study (competitor blog)](https://fitia.app/learn/article/ai-calorie-photo-apps-accuracy-2026/)
- [Cal AI product teardown (RaftLabs)](https://www.raftlabs.com/blog/cal-ai-product-teardown)
- [USDA FoodData Central API guide](https://fdc.nal.usda.gov/api-guide)
- [Top Nutrition APIs for developers in 2026 (Spike)](https://www.spikeapi.com/blog/top-nutrition-apis-for-developers-2026)
- [Calorie API vs USDA, FatSecret, Edamam, Nutritionix (vendor comparison)](https://calorieapi.com/blog/calorie-api-vs-usda-fatsecret-edamam-nutritionix)
- [Gemini grounding free-quota rules (Google AI forum)](https://discuss.ai.google.dev/t/grounding-free-quota-clarifying-2026-rules-for-gemini-2-5-flash-paid-tier-1/144593)
- [Gemini API pricing roundup (Morph)](https://www.morphllm.com/gemini-api-pricing)
- Claude model pricing: Anthropic API docs (as of 2026-10-06)

Several prices come from third-party roundups that disagree with each other. Check them on each provider's own pricing page before we commit.
