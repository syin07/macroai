import type { Confidence, Macros, MealItem } from "@/types/api";
import { itemMacros } from "./calc";
import { hasPhrase, words } from "./text";
import { gramsFromDefaults, gramsFromTable, gramsFromUsda, type GramsResult } from "./units";
import {
  BRANDED_DATA_TYPES,
  GENERIC_DATA_TYPES,
  UsdaError,
  type NutritionLookup,
  type UsdaDataType,
  type UsdaFood,
} from "./usda";

// Turns extracted foods into USDA-backed MealItems. Candidates are ranked by name similarity, preparation
// (raw vs cooked), and data type; anything below the threshold is rejected rather than swapped for a
// different food (PRD FR-04). Rejected foods come back as "unmatched" so the caller can fall back to a
// labeled AI estimate.

// One food from the extraction step (PRD §5.6). The AI layer's Zod schema should produce this shape.
export interface ExtractedFood {
  name: string;               // user-facing, e.g. "Cooked white rice"
  quantity: number;
  unit: string;
  preparation: string | null; // "grilled", "raw", ...
  inferred: boolean;
  confidence: Confidence;
  search_query: string;       // database wording, e.g. "rice, white, cooked"
  brand?: string | null;
  notes?: string | null;
}

export interface ScoredCandidate {
  food: UsdaFood;
  score: number;    // 0..~1, higher is better
  recall: number;   // share of the query's food words found in the candidate
}

export type Rejection = "unrelated_food" | "weak_name_match" | "preparation_conflict" | "low_score";

export type FoodMatchResult =
  | { status: "matched"; food: ExtractedFood; item: MealItem; match: ScoredCandidate }
  | {
      status: "unmatched";
      food: ExtractedFood;
      reason: "no_match" | "unknown_portion" | "lookup_failed";
      match: ScoredCandidate | null;  // set for unknown_portion: the food matched but grams couldn't be resolved
    };

// --- Tunables ---

export const MIN_SCORE = 0.65;
const MIN_RECALL = 0.6;
const MIN_RECALL_BRANDED = 0.75;  // branded descriptions have no "head" structure, so ask for more overlap
const CANDIDATES_TO_TRY = 3;      // top-ranked candidates checked for usable nutrients
const MAX_ASSUMPTIONS_LENGTH = 1000;

const WEIGHT = {
  recall: 0.6,
  precision: 0.15,
  sameState: 0.1,
  sameMethod: 0.05,
  differentMethod: -0.05,
  heavyModifier: -0.25,
} as const;

const DATA_TYPE_BONUS: Record<string, number> = {
  Foundation: 0.1,
  "SR Legacy": 0.1,
  "Survey (FNDDS)": 0.05,
};
const BRANDED_WHEN_BRAND_NAMED = 0.15;  // stands in for the state + data-type bonuses generic foods can earn
const BRAND_NAME_FOUND = 0.1;

// --- Vocabulary ---

const STOPWORDS = new Set([
  "a", "an", "and", "the", "of", "with", "or", "in", "on", "to", "as", "for", "from", "by", "at",
  "ns", "nfs", "made", "style", "type", "food", "eaten", "includes", "include",
]);

// Descriptors that don't change what the food is; ignored on both sides.
const DESCRIPTORS = new Set([
  "enriched", "unenriched", "regular", "long", "short", "medium", "grain", "boneless", "skinless", "meat", "only",
  "broiler", "fryer", "commercial", "ready", "eat", "rtd", "natural", "salt", "added", "solution", "all",
  "variety", "usda", "commodity", "upc", "generic", "plain", "dryheat", "moistheat",
]);

const COOKED = new Set([
  "cooked", "boiled", "roasted", "grilled", "broiled", "fried", "baked", "steamed", "braised", "stewed",
  "sauteed", "saute", "poached", "scrambled", "microwaved", "toasted", "barbecued", "bbq", "rotisserie",
  "dryroasted", "heated", "smoked", "seared",
]);
const RAW = new Set(["raw", "uncooked", "dry", "unprepared", "unheated"]);
const GENERIC_COOKED = new Set(["cooked", "heated", "dryheat", "moistheat"]);

// In a candidate but not the query, these change the nutrition a lot (dried fruit, breaded meat, rice with oil).
const HEAVY_WORDS = ["dried", "dehydrated", "powder", "flour", "concentrate", "breaded", "battered", "candied", "syrup", "sweetened", "frosted"];
const HEAVY_PHRASES = ["fat added", "made with oil", "made with butter", "made with margarine", "with sauce", "with gravy", "with cheese", "in oil", "in syrup"];

// SR Legacy prefixes some foods with a category ("Nuts, almonds", "Beverages, almond milk"); the food is the next part.
const CATEGORY_HEADS = new Set([
  "beverage", "snack", "nut", "seed", "fish", "cereal", "cereal ready to eat", "fast food", "restaurant",
  "candy", "spice", "sweetener", "alcoholic beverage", "crustacean", "mollusk", "game meat",
]);

// Query word → words that mean the same food in USDA descriptions.
const SYNONYMS: Record<string, string[]> = {
  toast: ["bread"],
  spaghetti: ["pasta"], penne: ["pasta"], macaroni: ["pasta"], fusilli: ["pasta"], linguine: ["pasta"],
  fry: ["potato"],
  yoghurt: ["yogurt"],
  oatmeal: ["oat", "cereal"], porridge: ["oat", "cereal"],
  steak: ["beef"], burger: ["beef"], hamburger: ["beef"],
  scallion: ["onion"],
  garbanzo: ["chickpea"],
};

const NEGATIONS = new Set(["without", "no", "not"]);

// --- Text analysis ---

// Rewrites phrases where "dry" doesn't mean raw before splitting into words.
function prepare(text: string): string {
  return text.toLowerCase().replace(/dry[\s-]+heat/g, "dryheat").replace(/moist[\s-]+heat/g, "moistheat").replace(/dry[\s-]+roasted/g, "dryroasted");
}

// Splits on commas and drops negated tails: "grilled without sauce" → "grilled", "no added fat" → "".
function segments(text: string): string[][] {
  return prepare(text)
    .split(",")
    .map((segment) => {
      const all = words(segment);
      const cut = all.findIndex((word) => NEGATIONS.has(word));
      return cut === -1 ? all : all.slice(0, cut);
    });
}

function isIdentityWord(word: string): boolean {
  return (
    !STOPWORDS.has(word) &&
    !DESCRIPTORS.has(word) &&
    !COOKED.has(word) &&
    !RAW.has(word) &&
    !/^\d/.test(word) // quantities like "26g", "2", "85"
  );
}

type State = { kind: "cooked" | "raw" | null; methods: Set<string> };

function stateOf(allWords: string[]): State {
  const methods = new Set(allWords.filter((w) => COOKED.has(w) && !GENERIC_COOKED.has(w)));
  if (allWords.some((w) => COOKED.has(w))) return { kind: "cooked", methods };
  if (allWords.some((w) => RAW.has(w))) return { kind: "raw", methods };
  return { kind: null, methods };
}

interface QueryProfile {
  groups: Array<Set<string>>;  // one per query word, with synonyms
  vocabulary: Set<string>;     // union of all groups
  state: State;
  allWords: Set<string>;
  brandWords: string[];
}

function queryProfile(food: ExtractedFood, includeBrand: boolean): QueryProfile {
  const brandWords = food.brand ? words(food.brand).filter(isIdentityWord) : [];
  const identitySource = food.search_query.trim() || food.name;
  let identity = segments(identitySource).flat().filter(isIdentityWord);
  if (!includeBrand) identity = identity.filter((w) => !brandWords.includes(w));
  else identity = [...new Set([...brandWords, ...identity])];

  const groups = [...new Set(identity)].map((w) => new Set([w, ...(Object.hasOwn(SYNONYMS, w) ? SYNONYMS[w]! : [])]));
  const vocabulary = new Set(groups.flatMap((g) => [...g]));
  const stateWords = segments([food.preparation ?? "", food.name, food.search_query].join(", ")).flat();
  return { groups, vocabulary, state: stateOf(stateWords), allWords: new Set(stateWords), brandWords };
}

interface CandidateProfile {
  identity: Set<string>;   // description + brand words
  described: Set<string>;  // description words only; brand owners ("Fair Oaks Farms Brands, Inc.") would dilute precision
  head: string[];          // identity words of the leading segment (after any category prefix)
  state: State;
  padded: string;          // for phrase checks
}

function candidateProfile(candidate: UsdaFood): CandidateProfile {
  const isBranded = candidate.dataType === "Branded";
  const text = isBranded && candidate.brand ? `${candidate.description}, ${candidate.brand}` : candidate.description;
  const parts = segments(text);
  const all = parts.flat();

  let headIndex = 0;
  while (headIndex < parts.length - 1 && CATEGORY_HEADS.has(parts[headIndex]!.join(" "))) headIndex++;
  const head = (parts[headIndex] ?? []).filter(isIdentityWord);

  return {
    identity: new Set(all.filter(isIdentityWord)),
    described: new Set(segments(candidate.description).flat().filter(isIdentityWord)),
    head,
    state: stateOf(all),
    padded: ` ${parts.map((p) => p.join(" ")).join(" , ")} `,
  };
}

// --- Scoring ---

export type CandidateScore = { ok: true; score: number; recall: number } | { ok: false; reason: Rejection };

export function scoreCandidate(food: ExtractedFood, candidate: UsdaFood): CandidateScore {
  const isBranded = candidate.dataType === "Branded";
  const query = queryProfile(food, isBranded);
  const c = candidateProfile(candidate);
  if (query.groups.length === 0) return { ok: false, reason: "weak_name_match" };

  // Generic descriptions lead with the food itself; every word of that head must be something the query
  // asked for, or it's a different food ("Soup, chicken noodle" is not chicken; "Rice flour" is not rice).
  if (!isBranded) {
    if (c.head.length === 0 || !c.head.every((w) => query.vocabulary.has(w))) return { ok: false, reason: "unrelated_food" };
  }

  const matchedGroups = query.groups.filter((g) => [...g].some((w) => c.identity.has(w))).length;
  const recall = matchedGroups / query.groups.length;
  if (recall < (isBranded ? MIN_RECALL_BRANDED : MIN_RECALL)) return { ok: false, reason: "weak_name_match" };

  // Raw vs cooked changes calories per gram several-fold (dry vs cooked rice), so a known mismatch is fatal.
  if (query.state.kind && c.state.kind && query.state.kind !== c.state.kind) return { ok: false, reason: "preparation_conflict" };

  const matchedCandidateWords = [...c.described].filter((w) => query.vocabulary.has(w)).length;
  const precision = c.described.size === 0 ? 0 : matchedCandidateWords / c.described.size;

  let score = WEIGHT.recall * recall + WEIGHT.precision * precision;

  if (query.state.kind && query.state.kind === c.state.kind) score += WEIGHT.sameState;
  if (query.state.methods.size > 0 && c.state.methods.size > 0) {
    const shared = [...query.state.methods].some((m) => c.state.methods.has(m));
    score += shared ? WEIGHT.sameMethod : WEIGHT.differentMethod;
  }

  const heavy =
    HEAVY_WORDS.filter((w) => hasPhrase(c.padded, w) && !query.allWords.has(w)).length +
    HEAVY_PHRASES.filter((p) => hasPhrase(c.padded, p) && !p.split(" ").some((w) => query.allWords.has(w) && !STOPWORDS.has(w))).length;
  score += WEIGHT.heavyModifier * Math.min(heavy, 2);

  if (isBranded) {
    if (food.brand) score += BRANDED_WHEN_BRAND_NAMED;
    if (query.brandWords.length > 0 && query.brandWords.every((w) => c.identity.has(w))) score += BRAND_NAME_FOUND;
  } else {
    score += DATA_TYPE_BONUS[candidate.dataType] ?? 0;
  }

  if (score < MIN_SCORE) return { ok: false, reason: "low_score" };
  return { ok: true, score, recall };
}

// Accepted candidates, best first. Ties keep USDA's relevance order.
export function rankCandidates(food: ExtractedFood, candidates: readonly UsdaFood[]): ScoredCandidate[] {
  return candidates
    .flatMap((candidate) => {
      const scored = scoreCandidate(food, candidate);
      return scored.ok ? [{ food: candidate, score: scored.score, recall: scored.recall }] : [];
    })
    .sort((a, b) => b.score - a.score);
}

// --- Lookup + calculation ---

function searchPlan(food: ExtractedFood): Array<{ query: string; dataTypes: UsdaDataType[] }> {
  const generic = { query: food.search_query.trim() || food.name, dataTypes: GENERIC_DATA_TYPES };
  const brand = food.brand?.trim();
  if (!brand) return [generic];
  const query = generic.query.toLowerCase().includes(brand.toLowerCase()) ? generic.query : `${brand} ${generic.query}`;
  // A brand was named: try that product first, then a generic equivalent (FR-04 fallback step 1).
  return [{ query, dataTypes: BRANDED_DATA_TYPES }, generic];
}

async function withBasis(candidate: ScoredCandidate, lookup: NutritionLookup): Promise<ScoredCandidate | null> {
  if (candidate.food.basis_per_100g) return candidate;
  const detail = await lookup.getFood(candidate.food.fdcId);
  return detail?.basis_per_100g ? { ...candidate, food: detail } : null;
}

async function findMatch(food: ExtractedFood, lookup: NutritionLookup): Promise<ScoredCandidate | null> {
  for (const { query, dataTypes } of searchPlan(food)) {
    const ranked = rankCandidates(food, await lookup.searchFoods(query, { dataTypes }));
    for (const candidate of ranked.slice(0, CANDIDATES_TO_TRY)) {
      const usable = await withBasis(candidate, lookup);
      if (usable) return usable;
    }
  }
  return null;
}

// Table first; fetch the food's portion data only when the table can't answer.
async function resolvePortion(food: ExtractedFood, match: UsdaFood, lookup: NutritionLookup): Promise<GramsResult | null> {
  const input = { quantity: food.quantity, unit: food.unit, foodName: food.name };
  const fromTable = gramsFromTable(input);
  if (fromTable) return fromTable;
  const detail = match.portions.length > 0 ? match : await lookup.getFood(match.fdcId);
  const fromUsda = detail ? gramsFromUsda(input, { portions: detail.portions, serving: detail.serving ?? match.serving }) : null;
  return fromUsda ?? gramsFromDefaults(input);
}

function describeMatch(food: ExtractedFood, match: UsdaFood): string {
  const brand = match.dataType === "Branded" && match.brand ? ` — ${match.brand}` : "";
  const parts = [`USDA: ${match.description}${brand} (${match.dataType}, FDC ${match.fdcId})`];
  if (food.brand && match.dataType !== "Branded") parts.push(`no ${food.brand} product found; generic equivalent used`);
  return parts.join("; ");
}

export function buildItem(food: ExtractedFood, match: UsdaFood, basis: Macros, portion: GramsResult): MealItem {
  const assumptions = [describeMatch(food, match), portion.note, food.notes?.trim() || null]
    .filter((part): part is string => Boolean(part))
    .join("; ")
    .slice(0, MAX_ASSUMPTIONS_LENGTH);
  return {
    id: null,
    food_name: food.name,
    quantity: food.quantity,
    unit: food.unit,
    grams: portion.grams,
    basis_per_100g: basis,
    macros: itemMacros(basis, portion.grams),
    nutrition_source: "usda",
    source_reference: String(match.fdcId),
    inferred: food.inferred,
    confidence: food.confidence,
    edited_by_user: false,
    assumptions,
  };
}

export async function matchFood(food: ExtractedFood, lookup: NutritionLookup): Promise<FoodMatchResult> {
  try {
    const match = await findMatch(food, lookup);
    const basis = match?.food.basis_per_100g;
    if (!match || !basis) return { status: "unmatched", food, reason: "no_match", match: null };

    const portion = await resolvePortion(food, match.food, lookup);
    if (!portion) return { status: "unmatched", food, reason: "unknown_portion", match };

    return { status: "matched", food, item: buildItem(food, match.food, basis, portion), match };
  } catch (error) {
    // A USDA outage shouldn't sink the whole meal: report it per food so the caller can fall back to AI.
    if (error instanceof UsdaError) return { status: "unmatched", food, reason: "lookup_failed", match: null };
    throw error;
  }
}

// One result per extracted food, in the same order.
export function matchAndCalculate(foods: readonly ExtractedFood[], lookup: NutritionLookup): Promise<FoodMatchResult[]> {
  return Promise.all(foods.map((food) => matchFood(food, lookup)));
}
