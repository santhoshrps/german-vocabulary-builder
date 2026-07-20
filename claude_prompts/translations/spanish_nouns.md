# Task: Add Spanish translations (Latin America + Mexico + Spain) to the existing German–English noun file

You are working with a file containing German nouns, German plurals, German learning sentences, English translations, and existing translation remarks.

This file is used for a **language-learning project**. Accuracy is therefore critical. **Accuracy is more important than speed.**

Your task is to extend the existing German–English content with **correct, natural Spanish translations in three variants**:

* **Neutral Latin American Spanish** (pan-regional, excluding Mexico-specific usage — Mexico has its own column)
* **Mexican Spanish**
* **Peninsular Spanish (Spain)**

---

## 1. Mandatory multi-agent expert workflow

Do **not** complete this task using a single-pass translation approach.

Use a **multi-agent LLM workflow** with multiple independent agents who are experts in the relevant fields.

The workflow must include:

### A. Primary translation agent

A language-learning and translation expert who:

* Understands German at an expert level.
* Understands Spanish at an expert level.
* Understands the differences between neutral Latin American, Mexican, and Peninsular Spanish.
* Understands the needs of language learners at different proficiency levels.
* Produces the initial Spanish translations for all three variants.

### B. Independent Latin American Spanish verification agents

Use **multiple independent verification agents who are experts in Latin American Spanish**.

These agents must independently check:

* Spanish word choice for **neutral, pan-regional Latin American** usage.
* Grammatical gender and article correctness.
* Plural formation and orthographic accents.
* Spanish grammar and sentence structure.
* Naturalness and standard usage across Latin America.
* Correct use of the `Spanish_Word_LatinAmerican` inside `Spanish_Sentence_LatinAmerican`.
* Spanish punctuation, including `¿ ?` and `¡ !`.
* Whether the Spanish sentence has exactly the same meaning as the German sentence.
* Whether the Spanish is appropriate for the learner level in the `Level` column for that row.
* That **no country-specific regionalism** has been used — including no Mexico-specific term, which belongs in the Mexican column instead (see Section 4).

### C. Independent Mexican Spanish verification agents

Use **multiple independent verification agents who are experts in Mexican Spanish**.

These agents must independently check all of the points in Section B, but specifically for **standard Mexican Spanish as used in Mexico**, including:

* Mexican vocabulary where it differs (e.g. `alberca`, `jitomate`, `chamarra`, `playera`, `elevador`, `recámara`, `renta`, `camión`, `pluma`, `chícharo`).
* Correct use of the `Spanish_Word_Mexican` inside `Spanish_Sentence_Mexican`.
* That the Mexican variant is **standard Mexican usage**, not a narrow local or slang form.

**Important:** Mexican Spanish is **not** simply "Latin American Spanish plus local words". On some items Mexico agrees with **Spain** against the rest of Latin America (see Section 4.6). Each row must be judged on its own.

### D. Independent Peninsular (Spain) Spanish verification agents

Use **multiple independent verification agents who are experts in Peninsular Spanish (Spain)**.

These agents must independently check all of the points in Section B, but specifically for **standard European Spanish as used in Spain**, including:

* Peninsular vocabulary preferences (e.g. `coche`, `móvil`, `ordenador`, `billete`, `zumo`, `patata`).
* Peninsular grammar preferences (`vosotros`, `vuestro`, compound past tense usage).
* Correct use of the `Spanish_Word_Spain` inside `Spanish_Sentence_Spain`.

**At least some verification agents must specifically be Spanish-language experts or Spanish translation/linguistic verification specialists, separately for EACH of the three variants.**

Do not allow the verification agents to simply approve the primary translation without performing an independent review.

### E. German semantic verification agent

Use an independent German-language expert to verify:

* The meaning of the German noun.
* The meaning of the German sentence.
* The grammatical and contextual meaning of the German source.

The German source must be treated as the primary semantic reference.

### F. Final adjudication agent

If the agents disagree, use a final expert adjudication step.

The adjudication agent must:

1. Review the original German source.
2. Review the `Level` value for the row.
3. Review the English meaning as secondary context only.
4. Review the proposed Spanish translations for all three variants.
5. Review the verification agents' objections.
6. Decide the correct final Spanish translations based on linguistic evidence, the German source, and the learner level specified in the row.

**Do not resolve disagreements by majority vote alone. Linguistic correctness and the German source have priority.**

---

## 2. Source of truth and translation priority

For every row:

* Use the `German_Article` and `German_Word` columns as the source for the German article and noun.
* Use the `German_Plural` column as additional German grammatical context where relevant.
* Use the `German_Sentence` column as the source sentence.
* Use the `Level` column to determine the **target learner proficiency level for that specific row**.
* Use the English meaning (`English_Word`, `English_Word_US`, `English_Sentence`, `English_Sentence_US`) as a **secondary reference only**.
* Review the existing `Spanish_Remarks` and `Spanish_Remarks_Scheme_B` columns as an important quality-control reference.

**The learner level is row-specific. Always use the `Level` value from the same row.**

Do not assume that all rows have the same learner level.

### 2.1 Per-row instructions — these override the general rules

* **`Instructions for AI`** — When this column contains text for a row, it is a **direct, binding instruction for that row** and **must be followed**. It takes priority over the general guidance in this document (but never over the requirement to produce linguistically correct Spanish).

### 2.2 Existing remarks are a historical error log

The existing `Spanish_Remarks` and `Spanish_Remarks_Scheme_B` may contain:

* Previously detected translation mistakes.
* Known translation problems.
* Important corrections.
* Recurring error patterns.
* Warnings about word choice, gender, plural, or meaning.

Treat these remarks as a **historical error log and warning source**.

**Previously identified mistakes must not be repeated.**

**Do not assume that an existing translation is correct merely because it already exists in the file.** Treat it as a reference, not as a guaranteed-correct model to copy — a remark on that row often means it was wrong. This does **not** authorise you to change it: already-translated rows must still be left untouched (Section 3.2).

### 2.3 German has priority

If the English meaning and the German meaning differ, or if there is any uncertainty:

> **The German word and German sentence always have priority over the English translation.**

Do not infer a different meaning from the English translation.

Do not invent missing context or add meanings that are not present in the German source.

---

## 3. Strict file and column-editing restrictions

You are **strictly allowed to edit only these fifteen columns** — five fields × three variants:

| Field | Latin America | Mexico | Spain |
|---|---|---|---|
| singular article | `Spanish_Article_LatinAmerican` | `Spanish_Article_Mexican` | `Spanish_Article_Spain` |
| plural article | `Spanish_Article_Plural_LatinAmerican` | `Spanish_Article_Plural_Mexican` | `Spanish_Article_Plural_Spain` |
| singular noun | `Spanish_Word_LatinAmerican` | `Spanish_Word_Mexican` | `Spanish_Word_Spain` |
| plural noun | `Spanish_Plural_LatinAmerican` | `Spanish_Plural_Mexican` | `Spanish_Plural_Spain` |
| sentence | `Spanish_Sentence_LatinAmerican` | `Spanish_Sentence_Mexican` | `Spanish_Sentence_Spain` |

Use the **exact column headers as they appear in the file**. Do not rename, reorder, add, or remove columns.

### 3.1 Columns you must NOT edit

**Do not change any other column or any existing text outside the fifteen columns above.**

This explicitly includes — these are **strictly off-limits**:

* `Spanish_Remarks`, `Spanish_Remarks_Scheme_B` — **read-only reference only** (see Section 2.2).
* All German columns: `German_Article`, `German_Word`, `German_Plural`, `German_Sentence`.
* All English columns: `English_Word`, `English_Word_US`, `English_Sentence`, `English_Sentence_US`.
* All metadata/control columns: `row_id`, `Level`, `Type`, `Instructions for AI`.

Do not:

* Rewrite German text.
* Rewrite English text.
* Correct existing German or English content.
* Reformat the file.
* Reorder rows or columns.
* Rename columns.
* Change cell values outside the fifteen permitted Spanish columns.
* Make stylistic improvements to existing content outside the fifteen permitted columns.

**Change only what is necessary.** If a permitted cell is already correct, leave it exactly as it is.

Before editing, identify and preserve the file structure.

After editing, perform a **file integrity check** to confirm that no unauthorized columns, rows, or existing text were changed.

### 3.2 Scope — translate ONLY the rows that are not yet translated

The file contains a mixture of rows that are **already translated** and rows that are **not yet translated**.

* A row counts as **already translated** when its Spanish variant columns are already filled.
* **Translate only the rows whose Spanish translation is missing.**
* **Do not modify an already-translated row in any way** — not its text, not its formatting, not its highlighting. Leave those rows byte-for-byte as you found them.

**Already-translated rows are present for REFERENCE ONLY.** Use them to:

* Follow the established house style, terminology, and formatting conventions.
* Stay consistent with terminology already chosen for related words.
* **Above all, learn from `Spanish_Remarks`.** Where a reviewer has left a remark on an already-translated row, treat it as a **worked example of a mistake that must not be repeated** in the rows you translate (see Section 12).

Do not re-translate, "improve", correct, or re-highlight a row that is already done — even if you would have chosen different wording — unless that row's `Instructions for AI` explicitly asks for it.

### 3.3 The output file MUST retain the original formatting

Return the file with its **original structure and formatting fully intact**:

* The same sheet(s), with the same names and order.
* The same columns, in the same order, with the same headers and column widths.
* The same rows, in the same order.
* The same fonts, font sizes, colours, borders, alignment, number formats, and cell styles.
* The same file format — do not convert, export, or re-save in a way that strips styling, drops sheets, or flattens the workbook.

Do not add, delete, reorder, rename, hide, merge, or resize any column or row.

**The only formatting change you are permitted to make is the light gray `D9D9D9` fill on the variant cells of rows you translate, exactly as specified in Section 9.2.** No other fill, font, border, alignment, width, or style change anywhere in the file.

---

## 4. The three Spanish variants

### 4.1 All three columns are ALWAYS filled

For every row you complete, **all three** variants — Latin America, Mexico, and Spain — must contain a value.

**When variants are identical, write the same value in each of them.** Never leave a variant blank because it matches another. In the existing data all three are filled on every completed row, and they are identical on about 97% of rows.

(The only case where a Spanish cell is legitimately empty is a noun with no meaningful plural — see Section 2.1 and Section 7.)

### 4.2 Latin American Spanish must be NEUTRAL — and now excludes Mexico

`*_LatinAmerican` must be **standard, neutral, pan-regional Latin American Spanish**.

* Do **not** use words specific to a single country.
* **Because Mexico has its own column, Mexico-specific words must NOT be placed here.** Put `alberca`, `jitomate`, `chamarra`, `playera`, `elevador`, `recámara`, `renta`, `chícharo` in `*_Mexican`, and use the pan-regional term (`piscina`, `tomate`, `chaqueta`, `camiseta`, `ascensor`, `dormitorio`, `alquiler`, `arveja`) in `*_LatinAmerican`.
* Do **not** use `voseo` (`vos tenés`). Use standard `tú` forms.
* Use `ustedes` for the second-person plural (never `vosotros`).
* Prefer the term most widely understood across Latin America.
* Where no single truly neutral term exists, choose the most widely understood and least marked option.

**Critical false friend:** the verb `coger` is vulgar in much of Latin America (Argentina, Mexico, Uruguay and others). In Latin American **and Mexican** sentences use `tomar`, `agarrar`, or another neutral verb instead.

### 4.3 Mexican Spanish

`*_Mexican` must be **standard Mexican Spanish as used in Mexico**.

* Use the standard Mexican term where Mexico differs (`alberca`, `jitomate`, `camión` for a city bus, `chamarra`, `playera`, `elevador`, `recámara`, `renta`, `pluma`, `chícharo`, `lavatrastes`, `carne asada`, `bolsa`, `secadora de pelo`).
* Use `ustedes` for the second-person plural (never `vosotros`).
* Use standard national usage, **not** narrow local, slang, or vulgar forms.
* Where Mexico does not differ, repeat the neutral Latin American value.

### 4.4 Peninsular Spanish (Spain)

`*_Spain` must be **standard European Spanish as used in Spain**.

* Use `vosotros/vosotras` and `vuestro/vuestra` where the second-person plural informal is required.
* Peninsular vocabulary is expected where it differs (see the table in Section 9).
* `coger` is normal and acceptable in Spain.

### 4.5 Grammar differences that affect sentences

| Feature | Latin America | Mexico | Spain |
|---|---|---|---|
| 2nd person plural | `ustedes hablan` | `ustedes hablan` | `vosotros habláis` |
| 2nd person plural possessive | `su` / `de ustedes` | `su` / `de ustedes` | `vuestro/vuestra` |
| Recent past | preterite: `Hoy comí` | preterite: `Hoy comí` | present perfect: `Hoy he comido` |
| Masc. person direct object | `lo vi` | `lo vi` | `le vi` (accepted *leísmo de persona*) — `lo vi` also correct |

Apply these only where the sentence actually requires them. Most sentences will be identical in all three variants.

### 4.6 Mexico does NOT always side with Latin America

This is the most common three-variant mistake. Mexican Spanish is **not** "Latin American plus local words". Judge every row independently — all four patterns occur in the data:

| Pattern | German | Latin America | Mexico | Spain |
|---|---|---|---|---|
| Spain alone differs (most common) | Handy | el celular | el celular | el **móvil** |
| **Mexico sides with Spain** | Banane | la **banana** | el plátano | el plátano |
| **Mexico sides with Spain** | Mittagessen | el **almuerzo** | la comida | la comida |
| **Mexico sides with Spain** | Strumpf | la **media** | el calcetín | el calcetín |
| Mexico alone differs | Schwimmbad | la piscina | la **alberca** | la piscina |
| Mexico alone differs | Tomate | el tomate | el **jitomate** | el tomate |
| All three differ | Auto | el auto | el carro | el coche |
| All three differ | Erbse | la arveja | el chícharo | el guisante |
| All three differ | Zelt | la carpa | la casa de campaña | la tienda de campaña |

Never copy the Latin American value into the Mexican column by default. Verify each row with a Mexican Spanish expert.

---

## 5. Article columns

`Spanish_Article_LatinAmerican` / `Spanish_Article_Spain` contain **only the singular definite article**: `el` or `la`.

`Spanish_Article_Plural_LatinAmerican` / `Spanish_Article_Plural_Spain` contain **only the plural definite article**: `los` or `las`.

Write the article in **lowercase**, with **no noun**, no extra words, and no punctuation.

### 5.1 Spanish gender is independent of German gender

**Never copy the gender from the German article.** German and Spanish genders frequently differ.

Examples: `die Chili` → **el** chile · `das Alphabet` → **el** alfabeto · `der Anzug` → **el** traje.

Determine the Spanish gender from standard Spanish usage for that noun.

### 5.2 The stressed `a-` rule (critical)

Feminine nouns beginning with a **stressed** `a-` or `ha-` take **`el`** in the singular but remain **feminine**, and take **`las`** in the plural.

| Singular article | Noun | Plural article | Plural |
|---|---|---|---|
| `el` | agua | `las` | aguas |
| `el` | águila | `las` | águilas |
| `el` | hacha | `las` | hachas |
| `el` | aula | `las` | aulas |
| `el` | alma | `las` | almas |

So for these nouns the singular article column is `el` while the plural article column is `las`. **This mismatch is correct and intentional.**

This rule applies **only** when the initial `a-`/`ha-` is stressed. It does **not** apply to `la amiga`, `la aduana`, `la avenida`.

Any adjective still agrees in the **feminine**: `el agua fría`, `el aula pequeña`.

### 5.3 Nouns denoting people of either gender

Where the German headword denotes a person and Spanish has distinct masculine and feminine forms, use the established slash convention:

* Article: `el/la`
* Plural article: `los/las`
* Word: `enfermo/enferma`
* Plural: `enfermos/enfermas`

Where alternatives are multi-word, separate them with a space-padded slash: `ser humano / persona`, `seres humanos / personas`.

The **sentence** must use **one** of these forms naturally — never the slash form: `El enfermo está en la cama.`

---

## 6. Word columns

For each row, provide the correct Spanish translation of the German `German_Word`.

`Spanish_Word_LatinAmerican` / `Spanish_Word_Spain` must contain:

* The **bare singular noun only** — no article, no determiner, no extra words.
* Lowercase, unless it is a proper noun.
* Correct orthographic accents and `ñ`/`ü` where required.

The Spanish translation must:

* Represent the correct meaning of the German word.
* Be appropriate for the learner level specified in the `Level` column of that row.
* Use the most natural and standard Spanish word for the German meaning, in the relevant variant.
* Respect the context and grammatical meaning of the German noun.
* Not be blindly translated from English.
* Use correct Unicode encoding.

**The learner level may influence the choice of an appropriate translation or wording, but it must never be used as a reason to change, simplify, or distort the meaning of the German source.**

If multiple Spanish translations are possible, choose the **most standard and natural translation for the given German meaning, context, variant, and row-specific learner level**.

Do not choose a translation merely because it is a literal translation.

---

## 7. Plural columns

`Spanish_Plural_LatinAmerican` / `Spanish_Plural_Spain` contain the **bare plural noun only** — no article.

The plural must be the correct plural **of the Spanish word in the same row's word column**, not a translation of the German plural.

### 7.1 Plural formation rules

| Ending | Rule | Example |
|---|---|---|
| unstressed vowel | `+ s` | casa → casas |
| consonant | `+ es` | papel → papeles |
| `-z` | `-z → -ces` | lápiz → lápices · voz → voces |
| `-y` | `+ es` | rey → reyes |
| stressed `-í`/`-ú` | `+ es` (or `+ s`) | esquí → esquíes |

### 7.2 Accent shifts in the plural (frequent source of errors)

The written accent must be **added or removed** to preserve the original stressed syllable:

| Singular | Plural | Change |
|---|---|---|
| examen | exámenes | accent **added** |
| joven | jóvenes | accent **added** |
| canción | canciones | accent **removed** |
| alemán | alemanes | accent **removed** |
| autobús | autobuses | accent **removed** |

### 7.3 Invariable plurals

Nouns ending in `-s` or `-x` with an unstressed final syllable do not change: `el lunes → los lunes`, `la crisis → las crisis`.

### 7.4 Nouns with no meaningful plural

If the noun is uncountable or otherwise has no natural, commonly used plural in Spanish (e.g. *música*, *arquitectura* as abstract concepts), leave **both** the plural column and the plural-article column **empty** for that variant.

Do not invent an artificial plural merely because the German column contains one.

---

## 8. Sentence columns

Translate `German_Sentence` into **natural, grammatically correct standard Spanish**, once for each variant.

The Spanish sentence must:

* Have **exactly the same meaning as the German sentence**.
* Preserve the meaning, context, and intent of the German sentence.
* Not add information.
* Not remove information.
* Not change the meaning.
* Use natural Spanish sentence structure and word order.
* Be appropriate for the learner level specified in the `Level` column of that row.
* **Contain the Spanish noun from the corresponding word column** (`Spanish_Word_LatinAmerican` in `Spanish_Sentence_LatinAmerican`; `Spanish_Word_Spain` in `Spanish_Sentence_Spain`), used naturally and correctly.
* Use correct accents, `ñ`, and Unicode encoding.
* Use correct Spanish punctuation (Section 10).
* Show correct gender and number agreement across articles, adjectives, and participles.

**The semantic meaning of `German_Sentence` and each Spanish sentence MUST be identical.**

### 8.1 How the noun may appear in the sentence

The noun must appear, but it may be **naturally inflected** as the sentence requires:

* It may be singular or plural (`traje` → `trajes`).
* It may take a definite, indefinite, or no article (`el traje`, `un traje`).
* For gendered person nouns, use the appropriate single form, never the slash form.

It must **not** be replaced by a synonym, a pronoun, or a paraphrase.

Do not perform a word-for-word translation if that would produce unnatural Spanish.

At the same time, do not paraphrase so freely that the meaning changes.

**The learner level may influence vocabulary and phrasing choices, but it must never override the requirement to preserve the exact meaning of the German sentence.**

---

## 9. Variant vocabulary and highlighting

### 9.1 Common differences

These are illustrative, not exhaustive. Always verify per row.

| German | Latin America | Mexico | Spain |
|---|---|---|---|
| Auto | auto | carro | coche |
| Bus | bus | camión | autobús |
| Handy | celular | celular | móvil |
| Computer | computadora | computadora | ordenador |
| Fahrkarte / Ticket | boleto | boleto | billete |
| Jeans | jeans | jeans | vaqueros |
| Tafel | pizarrón | pizarrón | pizarra |
| Saft | jugo | jugo | zumo |
| Kartoffel | papa | papa | patata |
| Wohnung | departamento | departamento | piso |
| S-Bahn | tren suburbano | tren suburbano | tren de cercanías |
| Schwimmbad | piscina | **alberca** | piscina |
| Tomate | tomate | **jitomate** | tomate |
| Jacke | chaqueta | **chamarra** | chaqueta |
| T-Shirt | camiseta | **playera** | camiseta |
| Aufzug | ascensor | **elevador** | ascensor |
| Schlafzimmer | dormitorio | **recámara** | dormitorio |
| Miete | alquiler | **renta** | alquiler |
| Banane | **banana** | plátano | plátano |
| Mittagessen | **almuerzo** | comida | comida |
| Strumpf | **media** | calcetín | calcetín |
| Erbse | arveja | chícharo | guisante |
| Zelt | carpa | casa de campaña | tienda de campaña |

### 9.2 Highlighting rule (three variants)

Highlighting marks the **fields where the variants disagree**.

Use a solid light gray fill — hex `D9D9D9` (ARGB `FFD9D9D9`).

**The rule:**

> For each field, compare its three values (Latin America, Mexico, Spain).
> **If they are not all identical, highlight ALL THREE cells of that field.**
> If all three are identical, highlight nothing.

It does not matter *which* variant differs, or how many differ — any disagreement highlights the whole group of three, so the difference is visible side by side.

| Case | Example (word field) | Highlight |
|---|---|---|
| All three identical | `alfabeto` / `alfabeto` / `alfabeto` | **nothing** |
| One differs | `piscina` / `alberca` / `piscina` | **all three word cells** |
| One differs | `banana` / `plátano` / `plátano` | **all three word cells** |
| All three differ | `auto` / `carro` / `coche` | **all three word cells** |

**The five fields are evaluated separately.** A field is highlighted only because of its *own* values:

| Field | Cells compared and highlighted together |
|---|---|
| singular article | `Spanish_Article_LatinAmerican` · `Spanish_Article_Mexican` · `Spanish_Article_Spain` |
| plural article | `Spanish_Article_Plural_LatinAmerican` · `Spanish_Article_Plural_Mexican` · `Spanish_Article_Plural_Spain` |
| word | `Spanish_Word_LatinAmerican` · `Spanish_Word_Mexican` · `Spanish_Word_Spain` |
| plural | `Spanish_Plural_LatinAmerican` · `Spanish_Plural_Mexican` · `Spanish_Plural_Spain` |
| sentence | `Spanish_Sentence_LatinAmerican` · `Spanish_Sentence_Mexican` · `Spanish_Sentence_Spain` |

So in one row it is normal for some fields to be highlighted and others not — for example the word and sentence differ (highlight those six cells) while the articles are identical (leave those six alone).

**Worked example** — `Tafel`: `el pizarrón` / `el pizarrón` / `la pizarra`

* word field: `pizarrón` / `pizarrón` / `pizarra` → not identical → **highlight all three word cells**
* singular article: `el` / `el` / `la` → not identical → **highlight all three article cells**
* plural article: `los` / `los` / `las` → not identical → **highlight all three plural-article cells**
* plural: `pizarrones` / `pizarrones` / `pizarras` → not identical → **highlight all three plural cells**
* sentence: differs → **highlight all three sentence cells**

**Worked example** — `Schwimmbad`: `la piscina` / `la alberca` / `la piscina`

* word field: not identical → **highlight all three word cells**
* singular article: `la` / `la` / `la` → identical → **do not highlight**
* plural article: `las` / `las` / `las` → identical → **do not highlight**

Further rules:

* **Do not** highlight a field whose three values are identical.
* Do not apply any other formatting, font, colour, border, or width change anywhere in the file.

---

## 10. Spanish orthography, punctuation, and capitalization

### 10.1 Accents and special characters

* Use correct orthographic accents: `á é í ó ú`.
* Use `ñ` and `ü` (as in `pingüino`, `vergüenza`) where required.
* Use correct Unicode (UTF-8). Never use ASCII substitutes (`n~`, `a'`), HTML entities (`&aacute;`), or mojibake (`Ã¡`).
* A missing or misplaced accent is a **mistake**, not a stylistic choice: `esta` ≠ `está`, `el` ≠ `él`, `si` ≠ `sí`, `tu` ≠ `tú`.

### 10.2 Punctuation — Spanish-specific

* Questions **must** be opened with `¿` and closed with `?` — `¿Dónde está el libro?`
* Exclamations **must** be opened with `¡` and closed with `!` — `¡Qué bonito!`
* Omitting the inverted opening mark is an error.
* Every sentence must end with correct terminal punctuation.
* For quotations, use `«…»` (RAE preference) or `"…"`, applied consistently.

### 10.3 Capitalization — differs from German

Unlike German, Spanish does **not** capitalize common nouns.

Written in **lowercase** in Spanish:

* Days of the week: `lunes`, `martes`
* Months: `enero`, `febrero`
* Languages and nationalities: `español`, `alemán`, `alemana`

Capitalize only the first word of a sentence and proper nouns.

---

## 11. Spanish language quality requirements

Every Spanish translation must be checked by Spanish-language verification agents for:

* Semantic accuracy against the German source.
* Correct grammatical gender and article.
* Correct plural formation, including accent shifts.
* Correct word choice for the specific variant.
* Correct grammar and agreement.
* Natural Spanish sentence structure.
* Standard usage (neutral for Latin America; Peninsular for Spain).
* Correct use of the corresponding Spanish word inside the sentence.
* Correct punctuation, including `¿ ?` and `¡ !`.
* Correct accents and Unicode encoding.
* Appropriateness for the learner level specified in the row's `Level` column.

The Spanish must sound like **natural standard Spanish written by a competent native Spanish language expert** of the relevant variant.

**Do not accept a translation merely because it is understandable or technically possible.**

Reject and revise translations that are:

* Awkward.
* Literal but unnatural.
* Grammatically questionable.
* Semantically incomplete.
* Country-specific where a neutral Latin American term is required.
* Inappropriate for the learner level specified in the row.
* Influenced by the English meaning when the German meaning is different.

---

## 12. Known recurring mistakes — DO NOT REPEAT

The following patterns are taken from **331 review remarks written by the project's human Spanish reviewer** on 906 already-translated rows. They are the **actual, observed failure modes** of previous machine translation of this file.

**Every one of these must be actively checked on every row.** A translation that repeats one of these known mistakes must be rejected.

### 12.1 Grammatical gender — the single largest error source (63 remarks)

**A. Never carry the German gender into Spanish** (14 remarks flag exactly this)

| German | Correct Spanish | German | Correct Spanish |
|---|---|---|---|
| die Gurke (f) | **el** pepino (m) | der Honig (m) | **la** miel (f) |
| die Schokolade (f) | **el** chocolate (m) | der Husten (m) | **la** tos (f) |
| die Seife (f) | **el** jabón (m) | der Rücken (m) | **la** espalda (f) |
| die Schraube (f) | **el** tornillo (m) | der Frosch (m) | **la** rana (f) |
| die Periode (f) | **el** período (m) | der Termin (m) | **la** cita (f) |
| die Reise (f) | **el** viaje (m) | das Vitamin (n) | **la** vitamina (f) |
| die Landschaft (f) | **el** paisaje (m) | das Suppenhuhn (n) | **la** gallina (f) |
| die Jugendherberge (f) | **el** albergue (m) | die CD / die DVD (f) | **el** CD / **el** DVD (m) |
| die Bar (f) | **el** bar (m) | die Anforderung (f) | **el** requisito (m) |
| die Bezahlung (f) | **el** pago (m) | die Arbeitswelt (f) | **el** mundo laboral (m) |

**B. Misleading endings** — masculine despite ending in `-a`: `el mapa`, `el tema`, `el problema`, `el día`, `el idioma`, `el especialista`. Also masculine: `el examen`, `el color`, `el orden`.

**C. Gender that changes the meaning — never confuse**

* `la parte` (portion, section) vs. `el parte` (report)
* `el orden` (sequence) vs. `la orden` (command)

**D. The variants can have DIFFERENT genders.** When they do, the article columns must differ too — and **all three article cells must be highlighted** (Section 9.2). This was missed repeatedly: **28 rows** in the existing data have a gender that differs across variants.

| German | Latin America | Mexico | Spain |
|---|---|---|---|
| Computer | **la** computadora (f) | **la** computadora (f) | **el** ordenador (m) |
| Torte | **el** pastel (m) | **el** pastel (m) | **la** tarta (f) |
| Schnitzel | **la** milanesa (f) | **la** milanesa (f) | **el** escalope (m) |
| Sportschuh | **el** zapato deportivo (m) | **el** zapato deportivo (m) | **la** zapatilla deportiva (f) |
| Staubsauger | **la** aspiradora (f) | **la** aspiradora (f) | **el** aspirador (m) |
| Reißverschluss | **el** cierre (m) | **el** cierre (m) | **la** cremallera (f) |
| Wischmopp | **el** trapeador (m) | **el** trapeador (m) | **la** fregona (f) |
| Wohnzimmer | **la** sala (f) | **la** sala (f) | **el** salón (m) |
| Blinker | **la** direccional (f) | **la** direccional (f) | **el** intermitente (m) |
| Mousepad | **el** mousepad (m) | **el** mousepad (m) | **la** alfombrilla del ratón (f) |
| Quad | **la** cuatrimoto (f) | **la** cuatrimoto (f) | **el** quad (m) |
| Gymnasium | **la** escuela secundaria (f) | **la** escuela secundaria (f) | **el** instituto (m) |
| Babysitter | **la** niñera (f) | **la** niñera (f) | **el** canguro (m) |
| Schlafsack | **la** bolsa de dormir (f) | **la** bolsa de dormir (f) | **el** saco de dormir (m) |
| **Mexico is the odd one out:** | | | |
| Kugelschreiber | **el** bolígrafo (m) | **la** pluma (f) | **el** bolígrafo (m) |
| Handtasche | **el** bolso (m) | **la** bolsa (f) | **el** bolso (m) |
| Föhn | **el** secador (m) | **la** secadora de pelo (f) | **el** secador (m) |
| Miete | **el** alquiler (m) | **la** renta (f) | **el** alquiler (m) |
| Schlafzimmer | **el** dormitorio (m) | **la** recámara (f) | **el** dormitorio (m) |
| **Latin America is the odd one out:** | | | |
| Banane | **la** banana (f) | **el** plátano (m) | **el** plátano (m) |
| Mittagessen | **el** almuerzo (m) | **la** comida (f) | **la** comida (f) |
| Strumpf | **la** media (f) | **el** calcetín (m) | **el** calcetín (m) |
| Farbtopf | **la** lata de pintura (f) | **el** bote de pintura (m) | **el** bote de pintura (m) |
| **All three differ:** | | | |
| Erbse | **la** arveja (f) | **el** chícharo (m) | **el** guisante (m) |

### 12.2 Countability — uncountable nouns (63 remarks)

Nouns marked *incontable / sin plural* by the reviewer must have **both the plural column and the plural-article column left empty** (Section 7.4). Do not invent a plural.

Recurring groups:

* **Food/drink:** Milch, Reis, Salz, Zucker, Sahne, Butter, Fleisch, Gemüse, Obst, Knoblauch, Honig, Pfeffer, Mais
* **Abstract:** Glück, Gesundheit, Pünktlichkeit, Stress, Geld, Dank, Nähe, Kälte, Beginn, Selbstbedienung, Kinderbetreuung, Alltag
* **Material/nature:** Regen, Sand, Schnee, Holz
* **Collective clothing/fashion:** Kleidung, Sportkleidung, Abendkleidung, Bademode, Damenmode, Herrenmode
* **Disciplines/fields:** Klassik, Literatur, Wirtschaftsrecht, Technik
* **Sports:** Tennis, Basketball
* **Months** (September, Oktober, November) and **cardinal points** (Osten, Westen)
* **Proper nouns:** Nordsee, Ostsee, Wattenmeer, Nikolaus, Oktoberfest

### 12.3 Spanish plural where German is singular — *pluralia tantum* (29 remarks)

* **Urlaub and every `*urlaub` compound** → `las vacaciones` (Badeurlaub, Campingurlaub, Sommerurlaub, Stadturlaub, Snowboard-Urlaub). There is no countable singular.
* Eltern → `los padres` · Geschwister → `los hermanos` · Großeltern → `los abuelos`
* Lebensmittel → `los alimentos` / `los víveres`
* Lust → `las ganas` · Anleitung → `las instrucciones` · Französischkenntnis → `los conocimientos de francés`
* Kosmetik → `los cosméticos` · Schmuck → `las joyas` · Fotozubehör → plural
* Möbel → `los muebles` (a single piece = `el mueble`)
* Clothing: Jeans, Hose (`los pantalones`), Strumpfhose (`las medias`), Unterhose, Pommes (`las papas/patatas fritas`), Spaghetti (`los espaguetis`), Sonnenbrille (`las gafas` / `los lentes`)

**Reverse case:** German plural → Spanish singular. `Bauchschmerzen` → `el dolor de estómago`.

**Two hard rules for these nouns — both are violated in the existing data:**

1. **The article must agree in number with the noun written in the same cell.** Never pair a singular article with a plural noun.
   * Wrong (present in the file): `el` + `lentes de sol` · `la` + `gafas de sol`
   * Correct: `los lentes de sol` · `las gafas de sol`

2. **Never invent an artificial singular** just to fill the singular cell.
   * Wrong (present in the file): `la vacación`, `la vacación de verano`
   * `vacaciones` has no natural singular in this sense; the same applies to `las gafas`, `los lentes`, `las ganas`, `los víveres`.

If a noun genuinely has no natural singular, do **not** fabricate one. Put the natural plural form in the plural columns with the correct plural article, and follow the row's `Instructions for AI` if it specifies how the singular cells should be handled.

### 12.4 Invariable plurals (6 remarks)

The noun form does not change, but the **plural article still changes**:

`el sacapuntas → los sacapuntas` · `el paraguas → los paraguas` · `el cumpleaños → los cumpleaños` · `el pintalabios → los pintalabios` · `el lavaplatos → los lavaplatos` · Prozent (invariable as a unit)

### 12.5 Wrong sense chosen — false friends and context

**The sense used in `German_Sentence` decides.** Do not default to the most common dictionary gloss.

| German | Correct here | NOT |
|---|---|---|
| der Chef | el jefe | ~~el cocinero~~ |
| das Datum | la fecha | ~~la cita~~ |
| das Kostüm | el disfraz | ~~el traje~~ |
| der Stock | la planta / el piso (storey) | ~~a dwelling~~ |
| das Wetter / Frühling | el tiempo (weather) | ~~el clima~~ (general climate) |
| das Lineal | la regla (measuring tool) | ~~norma / menstruación~~ |
| die Nelke (here) | el clavo (spice) | ~~the flower~~ |
| die Technik (here) | la tecnología | ~~la técnica~~ |
| die Zitrone | el limón amarillo | ~~la lima~~ (in parts of LatAm `limón` = lime) |

Context-dependent pairs — choose per sentence: der Fisch (`el pez` alive / `el pescado` as food) · das Paar (`la pareja` people / `el par` objects) · die Decke (`el techo` / `la manta`) · das Kissen (`la almohada` / `el cojín`) · die Rechnung (`la factura` / `la cuenta` in a restaurant) · das Geschäft (`la tienda` / `el negocio`) · der Mensch (`el ser humano` / `la persona`) · die Brust (`el pecho` / `el seno`) · der Hals (`el cuello` / `la garganta`) · die Karte (`la tarjeta` / `el mapa` / `la carta`) · der Platz (`el asiento` / `el sitio`) · das Rezept (`la receta médica` / `de cocina`) · das Mittel (`el remedio`) · die Größe (`la talla`) · der Vormittag (`la mañana`) · die Uhrzeit (`la hora`)

**No single-word equivalent** — use the natural phrase: Zehe → `el dedo del pie` · Fingernagel → `la uña` (Spanish does not distinguish finger/toe nail) · Samstagabend → a locution.

### 12.6 The headword's function in the sentence may differ from the headword itself

`die Entschuldigung` as a noun is `la disculpa`, **but** in a sentence where it is used as an interjection it must be `«Perdón»`.

Translate the **word column** for the noun; translate the **sentence** for how the word is actually used there.

### 12.7 Over-literal rendering of German constructions

* `Im Oktober gibt es das Oktoberfest` → **`En octubre se celebra el Oktoberfest`**, not ~~`hay el Oktoberfest`~~. `es gibt` is **not** always `hay` — with an event use `celebrarse`, `tener lugar`.
* `Uhrzeit` → render naturally: `Son las diez`.

Translate the meaning idiomatically, never construction-by-construction.

### 12.8 Variant differences inside the SENTENCE (96 remarks name more than one variant)

These make the **sentence** cells differ — and therefore require highlighting — even when the noun itself is identical across variants. This was a frequent oversight. Mexico follows the Latin American column for all of these.

| Concept | Latin America | Mexico | Spain |
|---|---|---|---|
| play a sport | jugar fútbol / tenis | jugar fútbol / tenis | jugar **al** fútbol / **al** tenis |
| take photos | tomar / sacar fotos | tomar / sacar fotos | hacer fotos |
| drive | manejar | manejar | conducir |
| outside | afuera | afuera | fuera |
| broken (*kaputt*) | descompuesto / dañado | descompuesto | estropeado / roto / averiado |
| press a key | presionar | presionar | pulsar |
| take a course | tomar un curso | tomar un curso | hacer un curso |
| storey of a building | el piso | el piso | la planta |
| school | la escuela | la escuela | el colegio |

### 12.9 Country-specific words must NEVER go in the Latin American column (26 remarks)

The reviewer repeatedly flags these as **regional, not neutral**. The Latin American column must hold the pan-regional term.

**Mexican terms now have a home — put them in `*_Mexican`, never in `*_LatinAmerican`:**

| Mexican term (→ `*_Mexican`) | Neutral term (→ `*_LatinAmerican`) |
|---|---|
| alberca | piscina |
| jitomate | tomate |
| chícharo | arveja |
| camión (city bus) | bus |
| elevador | ascensor |
| recámara | dormitorio |
| renta | alquiler |
| chamarra | chaqueta |
| playera | camiseta |
| pluma | bolígrafo |
| desarmador | destornillador |
| lavatrastes | lavaplatos |
| bolsa (handbag) | bolso |

**All other country-specific terms have no column and must never be used in any variant column:**

* **Argentina / Uruguay:** pileta, ananá, frutilla, colectivo, campera, remera, corpiño, valija, manteca, choclo, lapicera, moza, buzo
* **Chile:** polera · **Colombia:** esfero, brasier, pimentón · **Perú:** tajador · **Caribe:** guagua

### 12.10 Register must match the German

Uni → colloquial for `universidad` · Oma / Opa → `la abuelita` / `el abuelito` (informal) · Pulli → informal (`el suéter` / `el jersey`).
Do not use colloquialisms such as `la plata` for `Geld` unless the German is itself colloquial.

### 12.11 Culture-specific items may keep the German word

Oktoberfest, Biergarten, Flammkuchen, Berliner, Stollen, ICE, Nikolaus, Nordsee, Ostsee, Wattenmeer.

Keep the German name (framed naturally in Spanish). **Do not invent a false Spanish equivalent.** Where no exact equivalent exists (e.g. Apfelsaftschorle), describe it naturally rather than forcing a single word.

### 12.12 Person nouns — both gender forms, and sentence agreement

Angestellte, Verlobte, Kellner/Kellnerin, Verkäuferin, Erzieherin, Leiterin, Schaffner (fem. `la revisora`) — use the `el/la` + `masculino/femenino` slash convention from Section 5.3.

The **sentence** uses only one form, and it must agree with the subject of the German sentence — e.g. for Schuhfan the German subject is `Sie` (feminine), so the Spanish sentence must use feminine agreement.

---

## 13. Mandatory row-by-row verification

For every row, the multi-agent workflow must verify all of the following:

1. The German `German_Word` was correctly understood.
2. The German article and grammatical context were considered where relevant.
3. The German sentence was correctly understood.
4. The row-specific `Level` value was reviewed and correctly applied.
5. `Instructions for AI` (if present) was read and followed.
6. The existing `Spanish_Remarks` / `Spanish_Remarks_Scheme_B` were reviewed.
7. Previously identified mistakes were not repeated.
8. The English meaning was used only as secondary context.
9. The German source was prioritized in any conflict or ambiguity.
10. All three variant columns (Latin America, Mexico, Spain) are filled — identical values where the variants agree.
11. The singular articles are correct (`el`/`la`) and contain only the article.
12. The plural articles are correct (`los`/`las`) and agree with the noun's true gender, including the stressed `a-` rule (`el agua` → `las aguas`).
13. All three word columns contain the bare noun with no article.
14. All three plural columns are the correct plural of that row's Spanish word, with correct accent shifts.
15. Plural and plural-article cells are empty where the noun has no meaningful plural.
16. Each Spanish sentence has exactly the same meaning as `German_Sentence`.
17. Each Spanish sentence contains its corresponding Spanish word, naturally inflected.
18. Gender and number agreement is correct throughout each sentence.
19. Latin American text is neutral, free of `voseo`, and free of country-specific regionalisms — **including Mexico-specific words, which belong in `*_Mexican`**.
20. Mexican text uses standard Mexican usage, and was judged independently — not copied from Latin America by default (Section 4.6).
21. Spain text uses standard Peninsular usage.
22. Spanish punctuation is correct, including `¿ ?` and `¡ !`.
23. Capitalization follows Spanish rules (lowercase days, months, languages, nationalities).
24. Accents, `ñ`, `ü`, and Unicode encoding are correct.
25. Highlighting follows Section 9.2: for each of the five fields, if its three values are not all identical, **all three cells of that field** are highlighted `D9D9D9`; if identical, none are.
26. No unnecessary meaning or information was added.
27. No meaning or information from the German sentence was omitted.
28. No unauthorized file content was changed — in particular, no German, English, remarks, or metadata column was touched.
29. The row was **not already translated** — already-translated rows were left completely untouched (Section 3.2).
30. The original file formatting was preserved; the only formatting change is the `D9D9D9` highlight on translated rows (Section 3.3).
31. **The row was checked against every known recurring mistake in Section 12**, specifically:
    * Gender was decided from Spanish usage, not copied from German (12.1 A–C).
    * Where variants have different genders, the article columns differ **and** all three article cells are highlighted (12.1 D).
    * Uncountable nouns have **empty** plural and plural-article cells (12.2).
    * *Pluralia tantum* (especially `Urlaub` → `las vacaciones`) are in the plural (12.3).
    * Invariable plurals keep the noun form but change the article (12.4).
    * The sense matches the **sentence**, not the default dictionary gloss (12.5, 12.6).
    * No over-literal German construction (`es gibt` ≠ always `hay`) (12.7).
    * Variant-specific verbs/prepositions inside the sentence were applied, and all three sentence cells are highlighted when they differ (12.8).
    * The Latin American column contains **no country-specific word** (12.9).
    * Register matches the German (12.10).

**A translation must not be approved merely because it looks plausible.**

---

## 14. Final independent verification

After all translations have been completed, review the **entire file again, word by word — at least three to four complete passes**. Each pass must be an independent review, not a re-reading of previous conclusions.

1. Review the entire file again row by row.
2. Perform an independent German-to-Spanish semantic comparison for all three variants.
3. Perform an independent Spanish grammar and naturalness review for neutral Latin America.
4. Perform an independent Spanish grammar and naturalness review for Mexico.
5. Perform an independent Spanish grammar and naturalness review for Spain.
6. Re-check every Spanish word against its German `German_Word`.
7. Re-check every article against the noun's true grammatical gender.
8. Re-check every plural, including accent shifts and invariable forms.
9. Re-check every Spanish sentence against its `German_Sentence`.
10. Re-check that every Spanish sentence contains its corresponding Spanish word.
11. Re-check the row-specific `Level` value.
12. Re-check `Instructions for AI` handling.
13. Re-check the existing remarks for previously identified mistakes and confirm none has been repeated.
14. Re-check highlighting field by field: any field whose three values differ has **all three** of its cells filled `D9D9D9`; identical fields have none.
15. Perform a final file integrity check confirming no unauthorized column, row, or cell was modified.

The final verification must include **Spanish-language expert LLM agents specifically focused on Spanish translation and linguistic correctness, separately for neutral Latin American, Mexican, and Peninsular Spanish**.

If any agent identifies a possible issue, investigate it before finalizing.

**The output will be independently reviewed by another AI model. It must withstand a detailed, adversarial, word-by-word review.**

---

## 15. External verification

If there is any uncertainty about a Spanish word, gender, plural, phrase, grammar point, or standard regional usage, use reliable linguistic references to double-check the issue, for example:

* The *Diccionario de la lengua española* (RAE/ASALE).
* The *Diccionario panhispánico de dudas* for regional and normative questions.
* Reputable bilingual dictionaries and standard translation resources.

External references may be used to resolve linguistic uncertainty, and should be consulted whenever gender, plural, or regional distribution is not certain.

However, the **German source remains the primary semantic authority** whenever the English meaning conflicts with the German meaning.

---

## Final instruction

Accuracy is more important than speed.

Use a **multi-agent expert translation and verification workflow**, including separate neutral Latin American, Mexican, and Peninsular Spanish experts.

**Do not change any existing content outside the fifteen permitted Spanish columns listed in Section 3.**

Only provide correct Spanish translations in the fifteen permitted columns, and apply light gray highlighting per Section 9.2 — **whenever a field's three values are not all identical, highlight all three cells of that field**.

**Mexican Spanish is a full third variant. It must be filled on every row and judged independently — it does not always agree with Latin America (Section 4.6).**

**The `Level` column is the authoritative source for the target learner level of each individual row. Do not assume a fixed level for the entire file.**

**`Instructions for AI` is a binding per-row control and must be honoured.**

**Existing `Spanish_Remarks` must be actively reviewed as a historical error log so that previously identified mistakes and recurring translation errors are not repeated.**

**Section 12 lists the mistakes a human Spanish reviewer actually found in previous machine translations of this file. Repeating any of them is a failure. Check every row against Section 12 before finalizing.**

**Translate ONLY rows that are not yet translated. Already-translated rows are reference material — especially their `Spanish_Remarks` — and must be left completely unchanged (Section 3.2).**

**The output file MUST retain the original formatting. The only permitted formatting change is the light gray `D9D9D9` highlight defined in Section 9.2 (Section 3.3).**

**The meaning of `German_Sentence` and of each Spanish sentence MUST be identical.**

**The final output must be independently verified by multiple agents, including Spanish-language experts specifically responsible for neutral Latin American, Mexican, and Peninsular Spanish translation and linguistic verification.**
