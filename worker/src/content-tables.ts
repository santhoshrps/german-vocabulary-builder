export const PHYSICAL_TABLES = [
  "verbs", "nouns", "adverbs_adjectives", "translations", "id_aliases",
] as const;

export type PhysicalTable = (typeof PHYSICAL_TABLES)[number];

export const ALLOWED_TABLES = new Set<string>(PHYSICAL_TABLES);

// Fixed column order drives parameterised publication SQL. Names are source
// constants and never accepted from a request.
export const TABLE_COLUMNS: Record<PhysicalTable, readonly string[]> = {
  verbs: [
    "id", "content_hash", "free", "level", "capital", "type", "word", "sense",
    "german_sentence", "ich", "du", "er_sie_es",
    "wir", "ihr", "sie_sie", "past_participle", "simple_past",
  ],
  nouns: [
    "id", "content_hash", "free", "level", "capital", "type", "article", "word",
    "plural", "sense", "image", "german_sentence",
  ],
  adverbs_adjectives: [
    "id", "content_hash", "free", "level", "capital", "type", "word", "sense",
    "german_sentence", "comparative", "superlative",
  ],
  translations: [
    "id", "content_hash", "word_id", "lang", "word", "sentence",
    "article", "article_plural", "plural",
  ],
  id_aliases: [
    "id", "content_hash", "new_id", "reason",
  ],
};

export function isPhysicalTable(value: string): value is PhysicalTable {
  return ALLOWED_TABLES.has(value);
}
