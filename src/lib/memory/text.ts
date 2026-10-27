import { words } from "@/lib/nutrition/text";

// Keyword helpers for memory retrieval and deduplication. English-only, no embeddings: memories are
// short ("Usual shake: Fairlife Core Power 26g, 1 bottle") and a user has dozens, not thousands.

// Words that carry no meaning for matching a memory to a message. Food words never go here, and
// neither does "usual": "my usual shake" has to find "Usual shake: ...".
const STOPWORDS = new Set([
  "a", "about", "after", "again", "all", "also", "am", "an", "and", "any", "are", "as", "at", "be",
  "been", "before", "but", "by", "can", "could", "did", "do", "doe", "for", "from", "get", "got", "had",
  "ha", "have", "he", "her", "him", "his", "how", "i", "if", "in", "into", "is", "it", "its",
  "just", "let", "like", "me", "my", "myself", "no", "not", "now", "of", "off", "ok", "on", "or", "our",
  "out", "please", "she", "so", "some", "than", "that", "the", "their", "them", "then", "there", "these",
  "they", "this", "those", "to", "too", "up", "us", "very", "wa", "want", "we", "were", "what", "when",
  "which", "who", "why", "will", "with", "would", "yeah", "yes", "you", "your",
]);

// "Jalapeño" → "jalapeno", so accents don't split words.
function fold(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "");
}

// Distinct meaningful words: lowercased, plurals folded, stopwords and single characters dropped
// ("26g" and "500" stay; "1", "2", and the "m" of "I'm" go: nearly every memory has a "1").
export function keywords(text: string): Set<string> {
  return new Set(words(fold(text)).filter((word) => word.length > 1 && !STOPWORDS.has(word)));
}

// "Usual shake: Fairlife Core Power 26g, 1 bottle" → "usual shake fairlife core power 26g 1 bottle".
export function normalizeMemoryText(text: string): string {
  return words(fold(text)).join(" ");
}

// How many distinct keywords two texts share.
export function overlap(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared;
}

// Sørensen–Dice coefficient of two keyword sets, 0..1.
export function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  return (2 * overlap(a, b)) / (a.size + b.size);
}

const NUMBER = /\d/;

function split(set: Set<string>): { numbers: Set<string>; terms: Set<string> } {
  const numbers = new Set<string>();
  const terms = new Set<string>();
  for (const word of set) (NUMBER.test(word) ? numbers : terms).add(word);
  return { numbers, terms };
}

// Two memories this alike in their words are about the same thing.
export const SIMILARITY_THRESHOLD = 0.7;

// Compares a new memory text with an existing one:
//   "same"      — the same fact (normalized text equal, or near-identical words and the same numbers)
//   "revised"   — the same subject with different numbers ("26g" → "42g", "2 eggs" → "3 eggs"):
//                 the newer one replaces the older
//   "different" — anything else
// Numbers decide between same and revised because quantities are what matters in a calorie tracker.
// Every number counts here, including the single digits keywords() drops.
export function compareMemoryText(next: string, existing: string): "same" | "revised" | "different" {
  const a = normalizeMemoryText(next);
  const b = normalizeMemoryText(existing);
  if (a === b) return "same";

  const left = split(new Set(a.split(" ").filter((word) => word && !STOPWORDS.has(word))));
  const right = split(new Set(b.split(" ").filter((word) => word && !STOPWORDS.has(word))));
  if (left.terms.size === 0 || right.terms.size === 0) return "different";
  if (dice(left.terms, right.terms) < SIMILARITY_THRESHOLD) return "different";
  const sameNumbers = left.numbers.size === right.numbers.size && [...left.numbers].every((n) => right.numbers.has(n));
  return sameNumbers ? "same" : "revised";
}

// True when `quote` appears word-for-word (after normalizing) in `text`.
export function containsQuote(text: string, quote: string): boolean {
  const needle = normalizeMemoryText(quote);
  if (!needle) return false;
  return ` ${normalizeMemoryText(text)} `.includes(` ${needle} `);
}
