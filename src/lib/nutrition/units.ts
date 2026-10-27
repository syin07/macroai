import { round1 } from "./calc";
import { hasPhrase, singularize, wordString } from "./text";
import type { FoodPortion, ServingSize } from "./usda";

// Converts "2 eggs", "1 cup rice", "a handful of almonds" into grams.
// Order (PRD §5.5): mass units are exact → our default table (by food kind) → USDA portion data →
// last-resort defaults (water density for volumes, a generic handful). Unresolvable → null.

export interface PortionInput {
  quantity: number;
  unit: string;
  foodName: string;
}

export interface UsdaPortionData {
  portions: FoodPortion[];
  serving: ServingSize | null;
}

export interface GramsResult {
  grams: number;
  source: "mass" | "table" | "usda_portion" | "serving" | "default";
  note: string | null;  // shown in the card's assumptions; null when exact
}

// --- Units ---

const MASS_GRAMS: Record<string, number> = { g: 1, kg: 1000, oz: 28.3495, lb: 453.592 };

// Volumes in ml. A "bowl" is treated as 1.5 cups.
const VOLUME_ML: Record<string, number> = { ml: 1, l: 1000, tsp: 5, tbsp: 15, fl_oz: 29.5735, cup: 240, bowl: 360 };

const SIZE_WORDS = new Set(["extra small", "small", "medium", "large", "extra large"]);
const CONTAINER_UNITS = new Set(["serving", "bottle", "can", "bar", "packet", "container", "pouch", "carton"]);

const UNIT_ALIASES: Record<string, string> = {
  g: "g", gr: "g", gram: "g", gramme: "g",
  kg: "kg", kilo: "kg", kilogram: "kg",
  oz: "oz", ounce: "oz",
  lb: "lb", lbs: "lb", pound: "lb",
  ml: "ml", milliliter: "ml", millilitre: "ml", cc: "ml",
  l: "l", liter: "l", litre: "l",
  "fl oz": "fl_oz", "fl. oz": "fl_oz", floz: "fl_oz", "fluid ounce": "fl_oz", fl_oz: "fl_oz",
  cup: "cup", c: "cup",
  tbsp: "tbsp", tbs: "tbsp", tbl: "tbsp", tablespoon: "tbsp",
  tsp: "tsp", teaspoon: "tsp",
  bowl: "bowl",
  slice: "slice", scoop: "scoop", handful: "handful",
  "": "piece", piece: "piece", pc: "piece", pcs: "piece", each: "piece", whole: "piece", item: "piece", unit: "piece",
  "extra small": "extra small", sm: "small", small: "small", med: "medium", medium: "medium", lg: "large", large: "large",
  "extra large": "extra large", "x large": "extra large", xl: "extra large", jumbo: "extra large",
  serving: "serving", "nlea serving": "serving", portion: "serving",
  bottle: "bottle", can: "can", bar: "bar", packet: "packet", pack: "packet", container: "container", pouch: "pouch", carton: "carton",
};

// Own-property lookup, so units like "constructor" don't hit Object.prototype.
function lookup<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

// "Tablespoons" → "tbsp", "fl. oz." → "fl_oz", "Eggs" → "egg" (unknown units are returned singular and lowercase).
export function normalizeUnit(unit: string): string {
  const cleaned = unit.toLowerCase().replace(/\(.*?\)/g, "").replace(/\.$/, "").replace(/\s+/g, " ").trim();
  const direct = lookup(UNIT_ALIASES, cleaned);
  if (direct) return direct;
  const singular = cleaned.split(" ").map(singularize).join(" ");
  return lookup(UNIT_ALIASES, singular) ?? singular;
}

export function isMassUnit(unit: string): boolean {
  return lookup(MASS_GRAMS, normalizeUnit(unit)) !== undefined;
}

// --- Food kinds (for volume and informal units) ---

export type FoodKind =
  | "protein_powder" | "nut_butter" | "ice_cream" | "liquid" | "soup" | "yogurt" | "cheese" | "oil" | "butter"
  | "syrup" | "sugar" | "flour" | "granola" | "cereal" | "oats_dry" | "porridge" | "pasta" | "grain" | "beans"
  | "nuts" | "chips" | "leafy_greens" | "fruit" | "vegetable" | "generic";

// First match wins, so specific phrases come before the words they contain ("peanut butter" before "butter").
const KIND_KEYWORDS: Array<[FoodKind, string[]]> = [
  ["protein_powder", ["protein powder", "whey", "casein"]],
  ["nut_butter", ["peanut butter", "almond butter", "nut butter", "cashew butter", "sunflower butter"]],
  ["ice_cream", ["ice cream", "gelato", "frozen yogurt"]],
  ["liquid", ["milk", "juice", "water", "coffee", "tea", "latte", "broth", "smoothie", "shake", "milkshake", "soda", "beer", "wine", "kombucha", "kefir", "lemonade"]],
  ["soup", ["soup", "stew", "chili", "chowder"]],
  ["yogurt", ["yogurt", "yoghurt", "skyr", "cottage cheese"]],
  ["cheese", ["cheese", "parmesan", "cheddar", "mozzarella"]],
  ["oil", ["oil"]],
  ["butter", ["butter", "ghee", "margarine"]],
  ["syrup", ["honey", "syrup", "agave"]],
  ["sugar", ["sugar"]],
  ["flour", ["flour"]],
  ["granola", ["granola", "muesli"]],
  ["cereal", ["cereal", "cheerio", "corn flake", "bran flake", "rice krispy"]],
  ["porridge", ["oatmeal", "porridge", "overnight oat", "grit"]],
  ["oats_dry", ["oat", "rolled oat"]],
  ["pasta", ["pasta", "spaghetti", "noodle", "macaroni", "penne", "fusilli", "linguine", "fettuccine", "ramen"]],
  ["grain", ["rice", "quinoa", "couscous", "barley", "bulgur", "farro"]],
  ["beans", ["bean", "lentil", "chickpea", "hummus", "edamame"]],
  ["nuts", ["almond", "peanut", "cashew", "walnut", "pecan", "pistachio", "hazelnut", "nut", "trail mix", "seed"]],
  ["chips", ["chip", "crisp", "pretzel", "cracker", "popcorn"]],
  ["leafy_greens", ["spinach", "lettuce", "kale", "arugula", "romaine", "mixed green", "salad green", "spring mix", "chard"]],
  ["fruit", ["berry", "blueberry", "strawberry", "raspberry", "blackberry", "cranberry", "grape", "fruit", "melon", "pineapple", "mango", "cherry", "watermelon", "cantaloupe"]],
  ["vegetable", ["broccoli", "carrot", "pepper", "onion", "cauliflower", "zucchini", "pea", "corn", "vegetable", "tomato", "cucumber", "mushroom", "celery", "asparagus"]],
];

const KIND_LABEL: Record<FoodKind, string> = {
  protein_powder: "protein powder", nut_butter: "nut butter", ice_cream: "ice cream", liquid: "liquid", soup: "soup",
  yogurt: "yogurt", cheese: "shredded cheese", oil: "oil", butter: "butter", syrup: "syrup", sugar: "sugar",
  flour: "flour", granola: "granola", cereal: "cereal", oats_dry: "dry oats", porridge: "cooked oatmeal",
  pasta: "cooked pasta", grain: "cooked grains", beans: "cooked beans", nuts: "nuts", chips: "chips",
  leafy_greens: "leafy greens", fruit: "fruit", vegetable: "chopped vegetables", generic: "food",
};

export function classifyFood(name: string): FoodKind {
  const padded = wordString(name);
  // "Raw oatmeal" is measured dry.
  if (hasPhrase(padded, "oatmeal") && /\b(dry|raw|uncooked|rolled)\b/.test(padded)) return "oats_dry";
  for (const [kind, keywords] of KIND_KEYWORDS) {
    if (keywords.some((keyword) => hasPhrase(padded, keyword))) return kind;
  }
  return "generic";
}

// Grams per US cup (240 ml); tbsp/tsp/ml/bowl scale from this. "generic" is deliberately absent so
// unknown foods use USDA portion data before falling back to water density.
const GRAMS_PER_CUP: Partial<Record<FoodKind, number>> = {
  liquid: 240, soup: 245, yogurt: 245, cheese: 113, oil: 218, butter: 227, syrup: 340, sugar: 200, flour: 125,
  granola: 120, cereal: 30, oats_dry: 80, porridge: 234, pasta: 140, grain: 160, beans: 172, nuts: 140,
  chips: 30, leafy_greens: 30, fruit: 150, vegetable: 120, protein_powder: 120, nut_butter: 258, ice_cream: 132,
};

// Per-item weights for count units ("2 eggs", "a banana"). Eggs are large; fruit is medium.
const PIECE_GRAMS: Record<string, number> = {
  egg: 50, banana: 118, apple: 182, orange: 131, pear: 178, peach: 150, avocado: 136, kiwi: 69, plum: 66,
  tortilla: 45, bagel: 105, "english muffin": 57, potato: 173, "sweet potato": 130,
};

const SLICE_GRAMS: Record<string, number> = {
  bread: 28, toast: 28, sourdough: 28, cheese: 21, pizza: 107, bacon: 8, tomato: 20, cake: 80,
};

const SCOOP_GRAMS: Partial<Record<FoodKind, number>> = { protein_powder: 30, ice_cream: 66 };

const HANDFUL_GRAMS: Partial<Record<FoodKind, number>> = { nuts: 28, chips: 28, fruit: 75, leafy_greens: 20 };
const DEFAULT_HANDFUL_GRAMS = 30;

// Longest key found in the name, so "sweet potato" beats "potato".
function lookupByName(table: Record<string, number>, name: string): [string, number] | null {
  const padded = wordString(name);
  let best: [string, number] | null = null;
  for (const [key, grams] of Object.entries(table)) {
    if (hasPhrase(padded, key) && (!best || key.length > best[0].length)) best = [key, grams];
  }
  return best;
}

// "2 eggs" arrives as unit "egg"; treat units that name a known countable food as pieces of it.
function countableNoun(unit: string): string | null {
  return lookup(PIECE_GRAMS, unit) !== undefined ? unit : null;
}

function result(input: PortionInput, grams: number, source: GramsResult["source"], why: string | null): GramsResult {
  const note = why === null ? null : `${input.quantity} ${input.unit} ≈ ${round1(grams)} g (${why})`;
  return { grams, source, note };
}

function validQuantity(input: PortionInput): boolean {
  return Number.isFinite(input.quantity) && input.quantity > 0;
}

// --- Step 1 + 2: exact mass units, then our table ---

export function gramsFromTable(input: PortionInput): GramsResult | null {
  if (!validQuantity(input)) return null;
  const unit = normalizeUnit(input.unit);
  const { quantity, foodName } = input;

  const mass = lookup(MASS_GRAMS, unit);
  if (mass !== undefined) return result(input, quantity * mass, "mass", unit === "g" ? null : "unit conversion");

  const kind = classifyFood(foodName);
  const ml = lookup(VOLUME_ML, unit);
  if (ml !== undefined) {
    const perCup = GRAMS_PER_CUP[kind];
    if (perCup === undefined) return null;
    const why = unit === "bowl" ? `bowl ≈ 1.5 cups of ${KIND_LABEL[kind]}` : `typical for ${KIND_LABEL[kind]}`;
    return result(input, quantity * ml * (perCup / VOLUME_ML.cup!), "table", why);
  }

  if (unit === "slice") {
    const hit = lookupByName(SLICE_GRAMS, foodName);
    return hit ? result(input, quantity * hit[1], "table", `typical slice of ${hit[0]}`) : null;
  }
  if (unit === "scoop") {
    const grams = SCOOP_GRAMS[kind];
    return grams ? result(input, quantity * grams, "table", `typical scoop of ${KIND_LABEL[kind]}`) : null;
  }
  if (unit === "handful") {
    const grams = HANDFUL_GRAMS[kind];
    return grams ? result(input, quantity * grams, "table", `typical handful of ${KIND_LABEL[kind]}`) : null;
  }
  if (unit === "piece" || countableNoun(unit)) {
    const hit = countableNoun(unit) ? ([unit, lookup(PIECE_GRAMS, unit)!] as const) : lookupByName(PIECE_GRAMS, foodName);
    return hit ? result(input, quantity * hit[1], "table", `typical ${hit[0]}`) : null;
  }
  return null;
}

// --- Step 3: USDA portion data for the matched food ---

const KNOWN_UNITS = new Set(Object.values(UNIT_ALIASES));

// "cup, chopped" → "cup"; "medium (7\" to 7-7/8\" long)" → "medium"; "medium breast" → "medium";
// "large or thick slice" → "slice"; "breast, bone and skin removed" → "breast".
function portionUnit(portion: FoodPortion): string {
  const first = portion.unit.replace(/\(.*?\)/g, "").split(",")[0] ?? "";
  const unit = normalizeUnit(first);
  if (KNOWN_UNITS.has(unit)) return unit;
  const parts = unit.split(" ");
  const last = parts[parts.length - 1] ?? "";
  if (KNOWN_UNITS.has(last) && !SIZE_WORDS.has(last)) return last;
  const size = [parts.slice(0, 2).join(" "), parts[0] ?? ""].find((w) => SIZE_WORDS.has(w));
  return size ?? unit;
}

function perUnitGrams(portion: FoodPortion): number {
  return portion.gramWeight / portion.amount;
}

export function gramsFromUsda(input: PortionInput, usda: UsdaPortionData): GramsResult | null {
  if (!validQuantity(input)) return null;
  const unit = normalizeUnit(input.unit);
  const { quantity } = input;

  const ml = lookup(VOLUME_ML, unit);
  if (ml !== undefined) {
    // Prefer the same unit; otherwise derive density from any volume portion ("1 cup" → tbsp).
    const volumePortions = usda.portions.filter((p) => lookup(VOLUME_ML, portionUnit(p)) !== undefined);
    const portion = volumePortions.find((p) => portionUnit(p) === unit) ?? volumePortions[0];
    if (portion) {
      const gramsPerMl = perUnitGrams(portion) / lookup(VOLUME_ML, portionUnit(portion))!;
      return result(input, quantity * ml * gramsPerMl, "usda_portion", `USDA: 1 ${portion.unit} = ${round1(perUnitGrams(portion))} g`);
    }
  }

  if (CONTAINER_UNITS.has(unit) && usda.serving) {
    const { amount, unit: servingUnit, household } = usda.serving;
    const label = household ? `${household}, ${amount} ${servingUnit}` : `${amount} ${servingUnit}`;
    // Branded nutrients are per 100 g or per 100 ml, matching the serving unit, so ml count as grams here.
    return result(input, quantity * amount, "serving", `label serving: ${label}`);
  }

  const noun = countableNoun(unit);
  const foodWords = wordString(input.foodName);
  const portion = usda.portions.find((p) => {
    const pUnit = portionUnit(p);
    if (pUnit === unit) return true;
    // A plain count ("1 banana", "2 eggs") matches USDA's per-item or medium portions.
    if (unit === "piece" || noun) {
      return pUnit === "piece" || pUnit === "medium" || pUnit === noun || hasPhrase(foodWords, pUnit);
    }
    return false;
  });
  if (portion) {
    return result(input, quantity * perUnitGrams(portion), "usda_portion", `USDA: 1 ${portion.unit} = ${round1(perUnitGrams(portion))} g`);
  }
  return null;
}

// --- Step 4: last-resort defaults ---

export function gramsFromDefaults(input: PortionInput): GramsResult | null {
  if (!validQuantity(input)) return null;
  const unit = normalizeUnit(input.unit);

  const ml = lookup(VOLUME_ML, unit);
  if (ml !== undefined) return result(input, input.quantity * ml, "default", "assumed density of water");
  if (unit === "handful") return result(input, input.quantity * DEFAULT_HANDFUL_GRAMS, "default", "typical handful");
  // "1 large banana" with no USDA size data: use the standard item weight.
  if (SIZE_WORDS.has(unit)) {
    const hit = lookupByName(PIECE_GRAMS, input.foodName);
    if (hit) return result(input, input.quantity * hit[1], "default", `typical ${hit[0]}; size not adjusted`);
  }
  return null;
}

// Full chain for when USDA portion data is already at hand. match.ts runs the steps lazily instead,
// so it only fetches portion data when the table can't answer.
export function resolveGrams(input: PortionInput, usda?: UsdaPortionData): GramsResult | null {
  return (
    gramsFromTable(input) ??
    (usda ? gramsFromUsda(input, usda) : null) ??
    gramsFromDefaults(input)
  );
}
