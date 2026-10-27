// Small text helpers shared by units.ts and match.ts. English-only, good enough for food names.

export function singularize(word: string): string {
  if (word.length <= 3) return word;
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.endsWith("oes")) return word.slice(0, -2);
  if (/(ches|shes|sses|xes)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !/(ss|us|is)$/.test(word)) return word.slice(0, -1);
  return word;
}

// Lowercase words with punctuation removed and plurals folded: "Bananas, raw" → ["banana", "raw"].
export function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map(singularize);
}

// " banana raw " — padded so phrases can be matched on word boundaries with includes(` ${phrase} `).
export function wordString(text: string): string {
  return ` ${words(text).join(" ")} `;
}

export function hasPhrase(padded: string, phrase: string): boolean {
  return padded.includes(` ${phrase} `);
}
