// Source-language registry — the worker-side projection of sync/registry.py's
// LANGUAGES (LG-FR-10/15: one rule set per language, two projections that must
// stay in step; the pipeline file is the authority).
//
// The app sends ?lang=<code> on every data request (LG-FR-13). Resolution builds
// the FALLBACK CHAIN (LG-FR-12): requested variant → its base → English (the
// required language every word carries). Unknown or absent codes resolve to
// English alone — a misspelled code degrades to the v1 behavior, never to an
// empty translation.

export const DEFAULT_LANG = "en";

const LANGUAGES: Record<string, { base?: string }> = {
  "en": {},
  "en-US": { base: "en" },
  "es-419": {},
  "es-MX": { base: "es-419" },
  "es-ES": { base: "es-419" },
  "zh": {},
};

export function isKnownLang(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(LANGUAGES, code);
}

// ["es-MX", "es-419", "en"] — ordered, deduplicated, always ending in English.
export function resolveChain(code: string | null): string[] {
  const chain: string[] = [];
  let cur = code && isKnownLang(code) ? code : DEFAULT_LANG;
  while (cur && !chain.includes(cur)) {
    chain.push(cur);
    cur = LANGUAGES[cur]?.base ?? "";
  }
  if (!chain.includes(DEFAULT_LANG)) chain.push(DEFAULT_LANG);
  return chain;
}

// Stable key for cache tags / ETags: distinct chains must never share a cached body.
export function chainKey(chain: string[]): string {
  return chain.join(">");
}
