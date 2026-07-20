# Task: Expert review of the German and English content in the VERBS file

You are reviewing a file of German verbs with their English translations, example sentences, full present-tense conjugation, past participle, and simple past.

This file is used for a **language-learning project**. Accuracy is therefore critical. **Accuracy is more important than speed.**

Your task is **NOT to translate and NOT to fix**. Your task is to **find mistakes and report them**:

* Find every error in the German and English content.
* **Highlight the offending cell(s) in purple.**
* **Write the problem and the correct answer into the `Remarks` column.**

**In the review you must not change the content of any cell other than `Remarks`.** You are an auditor, not an editor.

---

# ⚠️ PART A — ONE-TIME CONTENT ADDITION

> **DELETE THIS ENTIRE BLOCK (everything between the two ⚠️ markers) once the US English content has been added.**
> Everything below the closing marker is the permanent review task and does not depend on this block.

This phase runs **once, before any review**. It is the **only** phase in which you may write outside the `Remarks` column.

## A1. Add the US English columns

The file must end up with **four** English columns:

| Variant | Word | Sentence |
|---|---|---|
| **British English (UK)** | `English_Word` | `English_Sentence` |
| **American English (US)** | `English_Word_US` | `English_Sentence_US` |

**Check whether `English_Word_US` and `English_Sentence_US` already exist.**

* If they exist, fill them.
* **If they do not exist, create them** — `English_Word_US` immediately to the right of `English_Word`, and `English_Sentence_US` immediately to the right of `English_Sentence`. Use exactly these header names. Creating these two columns is the **only** permitted structural change to the file, and only in this phase.

Then, **for every row**, fill both US cells:

* `English_Word_US` = the American English equivalent of `English_Word`.
* `English_Sentence_US` = the American English equivalent of `English_Sentence`.
* **Where US and UK are identical, copy the UK value verbatim.** Never leave a US cell empty, and never invent a difference that does not exist.
* Where they genuinely differ, apply US spelling, vocabulary, grammar and punctuation (see Section 8 for the full contrast list).

## A2. Correct the UK columns directly

While working through the rows, **fix mistakes in `English_Word` and `English_Sentence` directly in the cells.**

* In this phase you **do** edit the cell — you are not only annotating.
* Correct spelling, grammar, punctuation, word class, and any wording that is not natural British English.
* Correct the meaning where it does not match the German — **the German is the reference**.
* Do **not** touch any German column, and do not touch any other column, in this phase.

## A3. Highlight everything you wrote — LIGHT BLUE

* Highlight **every cell you filled or corrected** in **light blue `ADD8E6` (`FFADD8E6`)** — both the US cells you populated and the UK cells you corrected.
* This makes the AI-written content reviewable at a glance.
* **Do not use purple in this phase.** Purple is reserved for review findings, so "content I wrote" and "content that is wrong" stay visually distinct.

## A4. Rules for this phase

* Do not add, delete, reorder, rename, hide, merge or resize anything **other than** the two new US columns described in A1.
* Do not change any German column, `Level`, `Type`, `Sense`, `row_id`, or `Remarks` here.
* Preserve all existing formatting (see the formatting section below).
* Web lookups are pre-approved — never pause to ask (see the external-verification section below).

## A5. Only when Part A is complete

When every row has both US cells filled and the UK cells corrected, **then** begin the review in Part B. Do not interleave the two phases.

> **⚠️ END OF PART A — everything below is the permanent review task.**

---

## 1. Mandatory multi-agent expert workflow

Do **not** complete this review using a single-pass approach. Use a **multi-agent LLM workflow** with multiple independent expert agents.

### A. German verb-morphology expert agents

Native-level experts in **Standard German** who verify conjugation, participle and preterite formation for every row — including strong/weak/mixed classes, stem changes, separable prefixes and reflexives. At least one agent must specialise in **German verb morphology**, verified against Duden/DWDS.

### B. German syntax expert agents

Experts who check the German sentence for word order (verb-second, verb-final, prefix placement), case government, valency and naturalness.

### C. English expert agents

Native-level experts who check `English_Word` and `English_Sentence` for correct meaning, grammar, spelling, punctuation and natural phrasing.

### D. Contrastive German–English semantic agent

An expert who verifies that the German and English express **exactly the same meaning**, and that no meaning has been added, lost or shifted.

### E. CEFR / language-pedagogy agent

An expert who verifies that the verb, sentence, tense and grammar are **appropriate for the CEFR level in that row's `Level` column**.

### F. Final adjudication agent

Where agents disagree, an adjudicator decides based on **dictionary evidence and grammatical rule**, not majority vote. An unresolved disagreement must still be reported as a suspicion in `Remarks`.

### G. Mandatory second round with DIFFERENT models

After the whole file has been reviewed and annotated, **run the entire review again from the start using different LLM agents/models**.

* The second round must review **independently** — not merely confirm round one.
* It must also re-examine rows round one marked clean.
* Additional findings are appended to `Remarks` in the same format.
* The task is not complete until both full rounds are finished.

---

## 2. What you are reviewing

| Column | Content | Review scope |
|---|---|---|
| `Level` | CEFR level of the row | Is the verb/sentence appropriate for it? |
| `Type` | should be `Verb` | Correct and present? |
| `Sense` | optional disambiguation | If filled, use it to decide which meaning is intended |
| `German_Word` | the German **infinitive** | Correct, correctly spelled, lowercase? |
| `English_Word` | English translation (**UK**), in `to …` form | Correct meaning and form? |
| `English_Word_US` | English translation (**US**), in `to …` form | Correct US form? |
| `German_Sentence` | German example sentence | Grammar, word order, case, punctuation, uses the verb? |
| `English_Sentence` | English example sentence (**UK**) | Grammar, punctuation, same meaning as German? |
| `English_Sentence_US` | English example sentence (**US**) | Grammar, punctuation, same meaning as German? |
| `ich` `du` `er_sie_es` `wir` `ihr` `sie_Sie` | present-tense conjugation | Correct form for each person? |
| `past_participle` | Partizip II | Correctly formed? |
| `simple_past` | Präteritum, 1st/3rd person singular | Correctly formed? |

Use the file's **actual column headers**; never rename them.

### 2.1 Established conventions in this file

Verify entries **against these conventions**, and flag deviations:

* `German_Word` is the **infinitive**, lowercase: `fragen`, `aufstehen`, `sich ärgern`.
* Reflexive verbs carry **`sich`** in `German_Word`: `sich anziehen`.
* `English_Word` uses the **`to …`** form: `to ask`, `to spell`. Multiple senses are separated by ` / `: `to hear / to listen`.
* Conjugation cells contain the **bare verb form only, without the pronoun**: `frage`, not *ich frage*.
* For **separable** verbs the conjugation cell shows the **separated** form: `aufstehen` → `stehe auf`; `einkaufen` → `kaufe ein`.
* For **reflexive** verbs the conjugation cell includes the **reflexive pronoun in the correct case**: `sich anziehen` → `ziehe mich an`.
* `past_participle` is the **bare participle without the auxiliary**: `gefragt`, `aufgestanden`, `angezogen` — never *hat gefragt* / *ist aufgestanden*, and no `sich`.
* `simple_past` is the **1st/3rd person singular** form: `fragte`, `hieß`, `ging`.

**This file has FOUR English columns.** `English_Word` / `English_Sentence` are **British English**; `English_Word_US` / `English_Sentence_US` are **American English**. Each pair must be correct **in its own variant**, and they must differ **exactly where the variants genuinely differ, and not otherwise** (Section 8.3).

---

## 3. Output rules — annotate, never fix

### 3.1 You may change ONLY the `Remarks` column and cell highlighting

* **Never correct a cell.** The corrected value goes into `Remarks` as text.
* Never rewrite German or English content.
* Never change any other column.
* Never add, delete, reorder, rename, hide, merge or resize rows or columns.

### 3.2 Highlighting

| Colour | Hex (ARGB) | Meaning |
|---|---|---|
| **Purple** | `CC99FF` (`FFCC99FF`) | This cell contains a mistake |
| **Light purple** | `E6D0F5` (`FFE6D0F5`) | Structural problem — the entry should be split, or `Type` is wrong (Section 9) |
| **Light blue** | `ADD8E6` (`FFADD8E6`) | *Pre-existing* — content written or corrected in an earlier content-addition pass. **Not** a review finding; never remove it |

* Highlight **every affected cell**, not just one. If the stem vowel is wrong, highlight `du` **and** `er_sie_es`; if the sentence also uses the wrong form, highlight the sentence too.
* Do **not** highlight correct cells.
* Apply no other fill, font, border, alignment, width or style change.

**Note on light blue:** cells filled **light blue `ADD8E6`** were written or corrected in an earlier content-addition pass. Light blue is **not** a review finding and is **not** proof the cell is correct — review those cells independently like any other. **Never remove a light-blue fill.** If such a cell turns out to be wrong, record it the normal way: change its fill to purple and add a `[AI review]` remark.


### 3.3 `Remarks` format — every entry is tagged

```
[AI review] <Column>: <what is wrong and why>. Correct: <the right answer>. <source, if used>
```

Examples:

```
[AI review] du: "fahrst" is missing the stem-vowel change. Correct: "fährst". (Duden)
[AI review] past_participle: "gestudiert" — verbs in -ieren take no ge-. Correct: "studiert".
[AI review] simple_past: "gehte" is not a valid form; "gehen" is strong. Correct: "ging".
[AI review] ich: separable verb must be split in the conjugation. Correct: "stehe auf".
[AI review] German_Sentence: verb-second rule violated — "Morgen ich gehe ins Kino." Correct: "Morgen gehe ich ins Kino."
```

* **One entry per distinct problem**, each on its own line.
* Cover **all affected cells** in that row.
* Write remarks in **English**.

### 3.4 Existing remarks

* If `Remarks` already contains text, **ignore its content** — it is neither proof the row is correct nor proof it is wrong.
* **Never delete or edit an existing remark.**
* **Append** your `[AI review]` entries below the existing text, on new lines.
* Review the row fully and independently regardless of what is already there.

---

## 4. Present-tense conjugation — expert checklist

Verify all six cells (`ich`, `du`, `er_sie_es`, `wir`, `ihr`, `sie_Sie`) against **Duden**/**DWDS**.

### 4.1 Regular (weak) pattern

`-e`, `-st`, `-t`, `-en`, `-t`, `-en` → `fragen`: `frage, fragst, fragt, fragen, fragt, fragen`.

`wir` and `sie_Sie` are normally identical to the infinitive — flag if they are not (the sole exception is `sein` → `sind`).

### 4.2 Stem-vowel change in `du` and `er_sie_es` (strong verbs)

This is the **most frequently missed** error. It affects **only** the `du` and `er_sie_es` cells:

* **e → i**: `geben` → *gibst, gibt* · `sprechen` → *sprichst, spricht* · `helfen` → *hilfst, hilft* · `essen` → *isst, isst* · `nehmen` → *nimmst, nimmt* (double m)
* **e → ie**: `sehen` → *siehst, sieht* · `lesen` → *liest, liest* · `empfehlen` → *empfiehlst, empfiehlt*
* **a → ä**: `fahren` → *fährst, fährt* · `schlafen` → *schläfst, schläft* · `tragen` → *trägst, trägt* · `halten` → *hältst, hält*
* **au → äu**: `laufen` → *läufst, läuft*
* **o → ö**: `stoßen` → *stößt, stößt*

Flag a missing change **and** a change wrongly applied to a weak verb.

### 4.3 Linking `-e-` with awkward stems

Stems ending in `-t`, `-d`, `-chn`, `-ffn`, `-gn`, `-tm` insert `-e-` before the ending in `du`, `er_sie_es`, `ihr`:
`arbeiten` → *arbeitest, arbeitet, arbeitet* · `finden` → *findest, findet, findet* · `öffnen` → *öffnest, öffnet, öffnet* · `atmen` → *atmest, atmet, atmet*

**Exception:** strong verbs whose stem vowel changes do **not** take the extra `-e-`: `halten` → *hältst, hält* (not *hältest*), `raten` → *rätst, rät*.

### 4.4 Stems ending in a sibilant

Stems ending in `-s`, `-ß`, `-z`, `-x`, `-tz` take only `-t` in the `du` form (the `s` merges):
`heißen` → *du heißt* · `sitzen` → *du sitzt* · `reisen` → *du reist* · `tanzen` → *du tanzt*

### 4.5 Stems in `-el` / `-er`

`ich` normally drops the `e`: `handeln` → *ich handle* · `sammeln` → *ich sammle*. `-ern` verbs: *ich ändere / ändre* (both attested — flag only if clearly wrong).

### 4.6 Irregular and modal verbs

* `sein`: *bin, bist, ist, sind, seid, sind*
* `haben`: *habe, hast, hat, haben, habt, haben*
* `werden`: *werde, wirst, wird, werden, werdet, werden*
* `wissen`: *weiß, weißt, weiß, wissen, wisst, wissen*
* **Modals have no ending in `ich` and `er_sie_es`, and change the vowel in the singular**:
  `können` → *kann, kannst, kann* · `müssen` → *muss, musst, muss* · `dürfen` → *darf, darfst, darf* · `wollen` → *will, willst, will* · `sollen` → *soll, sollst, soll* · `mögen` → *mag, magst, mag*

### 4.7 Separable and reflexive verbs

* **Separable**: the prefix must be **detached and placed at the end** in every conjugation cell — `aufstehen` → *stehe auf, stehst auf, steht auf, stehen auf, steht auf, stehen auf*. Flag any cell that keeps the prefix attached (*aufstehe*).
* **Inseparable prefixes** (`be-`, `ge-`, `er-`, `ver-`, `zer-`, `ent-`, `emp-`, `miss-`) are **never** detached: `besuchen` → *besuche*, never *suche be*.
* **Reflexive**: the pronoun must be present and in the **correct case and person** — `ziehe mich an`, `ziehst dich an`, `zieht sich an`, `ziehen uns an`, `zieht euch an`, `ziehen sich an`. Flag a wrong or missing pronoun, and flag dative reflexives where required (`sich etwas vorstellen` → *stelle mir vor*).

---

## 5. `past_participle` — expert checklist

* **Weak**: `ge-` + stem + `-t` → *gefragt*, *gemacht*. Stems in `-t`/`-d` insert `-e-`: *gearbeitet*.
* **Strong**: `ge-` + (often changed) stem + `-en` → *gegangen*, *gesprochen*, *geschrieben*, *genommen*.
* **Mixed**: *gebracht*, *gedacht*, *gewusst*, *gekannt*, *genannt*.
* **No `ge-` for verbs ending in `-ieren`**: *studiert*, *telefoniert*, *buchstabiert*, *fotografiert*. Flag *gestudiert*.
* **No `ge-` after an inseparable prefix**: *besucht*, *verstanden*, *erklärt*, *entschieden*, *empfohlen*.
* **Separable verbs put `ge-` between prefix and stem**: *aufgestanden*, *eingekauft*, *zugeordnet*, *angekreuzt*.
* The participle is written **without the auxiliary and without `sich`** — flag *hat gefragt*, *ist gegangen*, *sich geärgert*.
* Even though the auxiliary is not stored, check the **sentence** uses the right one: verbs of motion or change of state take `sein` (*ist gegangen*, *ist aufgestanden*), most others take `haben`.

---

## 6. `simple_past` (Präteritum) — expert checklist

* The cell holds the **1st/3rd person singular** form, with **no ending** for strong verbs: *ging*, *sprach*, *fuhr*, *hieß*, *schrieb*.
* **Weak**: stem + `-te` → *fragte*, *machte*; stems in `-t`/`-d` insert `-e-` → *arbeitete*.
* **Mixed**: *brachte*, *dachte*, *wusste*, *kannte*, *nannte*.
* **Irregular**: `sein` → *war* · `haben` → *hatte* · `werden` → *wurde* · modals → *konnte, musste, durfte, wollte, sollte, mochte*.
* **Separable verbs keep the prefix at the end in a sentence**, but the citation form in this column is the joined or separated form used consistently across the file — flag inconsistency with the rest of the file.
* Flag a **weak ending applied to a strong verb** (*gehte*, *sprechte*) and vice versa.
* Check the participle and the preterite belong to the **same verb class** — a strong participle with a weak preterite (or the reverse) is almost always an error.

---

## 7. German sentence — expert checklist

### 7.1 Verb position

* **Main clause: the finite verb is the SECOND element (V2).** Wrong: *Morgen ich gehe…* Correct: **Morgen gehe ich…**
* **Inversion** is obligatory when anything other than the subject is fronted.
* **Subordinate clauses send the finite verb to the END** — after `weil`, `dass`, `wenn`, `ob`, `als`, `obwohl`, `damit`, `bevor`, `nachdem`, and in relative clauses.
* **Separable prefix goes to the end** of the main clause: *Ich **stehe** um sieben **auf**.*
* **Perfect**: auxiliary in V2, participle at the end: *Ich **habe** ihn **gefragt**.*
* **Modal**: infinitive at the end: *Ich **muss** heute **arbeiten**.*
* **Future / passive**: `werden` in V2, infinitive/participle at the end.
* **Imperative**: verb first — *Kreuzen Sie die richtige Antwort an.*
* Questions: yes/no → verb first; W-question → verb immediately after the question word.
* Check **TeKaMoLo** order in the middle field (Temporal – Kausal – Modal – Lokal).

### 7.2 Valency and case government

Verbs govern specific cases and prepositions — a very common error source:

* **Dative verbs**: `helfen`, `danken`, `gefallen`, `gehören`, `antworten`, `folgen`, `passen`, `schmecken`.
* **Accusative**: the default direct object.
* **Fixed prepositional verbs**: `warten **auf** + Akk` · `sich freuen **über** + Akk` (past) / `**auf** + Akk` (future) · `denken **an** + Akk` · `sich interessieren **für** + Akk` · `bestehen **aus** + Dat` · `teilnehmen **an** + Dat`.
* **Two-way prepositions** take accusative for motion, dative for location.
* Reflexive verbs must carry the pronoun in the sentence, in the correct case.
* Flag a missing or superfluous object.

### 7.3 Orthography and punctuation

* All **nouns capitalised**; the verb itself stays lowercase unless it starts the sentence or is nominalised.
* **`ß` vs `ss`**: `ß` after a long vowel or diphthong (*heißen*, *Straße*); `ss` after a short vowel (*muss*, *dass*).
* Umlauts present and correct; never `ae/oe/ue`.
* **A comma before a subordinate clause is mandatory** in German: *Er ärgerte sich**,** weil er den Bus verpasst hatte.*
* Sentence ends with `.`, `?` or `!`.
* No double spaces, no leading/trailing whitespace.

### 7.4 Naturalness and register

* The sentence must be **natural, idiomatic Standard German**.
* Correct collocations (*eine Entscheidung **treffen***, not *machen*).
* Flag Austrian/Swiss regionalisms unless intended (*Jänner* → *Januar*).
* Neutral, everyday, non-offensive register suitable for learners.

---

## 8. English review — UK and US, both fully checked

`English_Word` / `English_Sentence` are **British English**. `English_Word_US` / `English_Sentence_US` are **American English**. Each must be correct **in its own variant** — review them separately, not as one.

Applies to **all four** English cells:

* The word must be a correct translation in the **`to …`** form; flag a bare stem or wrong aspect.
* Where several senses are listed with ` / `, each must be a genuine translation of the same German verb.
* The sentence must be **grammatical, natural and idiomatic** in its variant.
* Subject–verb agreement; correct and consistent tense.
* **`a` vs `an` by SOUND**: *an hour*, *a university*.
* **Uncountables** take no plural/article: *information*, *advice*, *furniture*, *news*, *homework*.
* Correct punctuation and terminal punctuation; apostrophes correct (`its` vs `it's`).
* English capitalises days, months, languages and nationalities — but **not** common nouns. Flag German-style noun capitalisation carried into English.
* Flag translationese — English that mirrors German word order rather than reading naturally.

### 8.1 Spelling differences

| Pattern | UK | US |
|---|---|---|
| `-our` / `-or` | colour, favour, behaviour | color, favor, behavior |
| `-re` / `-er` | centre, theatre, metre | center, theater, meter |
| `-ise` / `-ize` | organise, realise, apologise | organize, realize, apologize |
| `-yse` / `-yze` | analyse | analyze |
| `-ll-` / `-l-` | travelled, cancelled, modelling | traveled, canceled, modeling |
| `-ce` / `-se` | defence, licence (n.), practise (v.) | defense, license, practice |
| `ae` / `oe` | paediatric, oesophagus | pediatric, esophagus |
| other | programme, tyre, kerb, grey, plough, cheque, jewellery, aluminium, storey, draught, pyjamas, moustache, aeroplane, catalogue | program, tire, curb, gray, plow, check, jewelry, aluminum, story, draft, pajamas, mustache, airplane, catalog |

### 8.2 Vocabulary and grammar differences

flat/**apartment** · lift/**elevator** · lorry/**truck** · biscuit/**cookie** · autumn/**fall** · petrol/**gas** · pavement/**sidewalk** · holiday/**vacation** · football/**soccer** · rubbish/**garbage** · mobile phone/**cell phone** · trousers/**pants** · jumper/**sweater** · tap/**faucet** · wardrobe/**closet** · underground/**subway** · queue/**line** · maths/**math** · chemist/**drugstore** · film/**movie** · rubber/**eraser** · boot/**trunk** · motorway/**highway** · car park/**parking lot** · city centre/**downtown** · chips/**fries** · crisps/**chips** · postcode/**zip code** · bill/**check** (restaurant) · timetable/**schedule** · torch/**flashlight** · cooker/**stove** · cupboard/**cabinet** · garden/**yard** · shop/**store** · trainers/**sneakers** · term/**semester** · secondary school/**high school**

**Floor numbering is a real trap:** UK *ground floor* = US *first floor*. Flag any sentence where this makes the two variants mean different things.

| Feature | UK | US |
|---|---|---|
| Collective nouns | the team **are** | the team **is** |
| Recent past | I've just eaten | I just ate |
| Possession | I've **got** | I **have** |
| Past participle of *get* | got | **gotten** |
| Weekend | **at** the weekend | **on** the weekend |
| Hospital | in hospital | in **the** hospital |
| Different… | different **from/to** | different **from/than** |
| Irregular verbs | learnt, dreamt, spelt, burnt | learned, dreamed, spelled, burned |
| Dates | 4 July 2026 | July 4, 2026 |

**Punctuation:** UK commonly uses single `'…'` with punctuation **outside**; US uses double `"…"` with commas and periods **inside**. The serial (Oxford) comma is standard in US usage, optional in UK. US writes `Mr.`, `Dr.` with a period; UK usually `Mr`, `Dr` without.

### 8.3 UK/US consistency between the columns — frequently missed

* If the variants **genuinely differ**, the UK and US cells **must differ**. Flag a row where both say `colour`, or both say `apartment`.
* If the variants **do not differ**, the UK and US cells **must be identical**. Flag a spurious difference invented where none exists.
* Apply the same test to `English_Sentence` vs `English_Sentence_US`.
* Never leave a US cell empty.
* Within a single cell, do not mix variants (`colour` + `organize`).

---

## 9. Structural problems — light purple

Use **light purple (`E6D0F5`)** on `German_Word` (and `Type` where relevant) when the entry itself is wrongly structured:

* **`Type` is missing or is not `Verb`.**
* One row conflates **two genuinely different verbs or senses** that should be separate rows — e.g. a separable and an inseparable verb with the same spelling but different meaning and stress (`übersetzen` = to translate / to ferry across), or `sich etwas vorstellen` (to imagine) vs `sich vorstellen` (to introduce oneself).
* The reflexive and non-reflexive uses are conflated in one row when they have clearly different meanings.
* The infinitive in `German_Word` does not match the verb actually conjugated in the other columns.

Example remark:

```
[AI review] German_Word: "übersetzen" covers two different verbs (separable "über|setzen" = to ferry across; inseparable "übersetzen" = to translate). Should be split into separate rows.
```

---

## 10. Cross-language and content checks

### 10.1 Meaning equivalence

`German_Word` and `English_Word` must denote the same action. `German_Sentence` and `English_Sentence` must express **exactly the same meaning** — nothing added, lost or shifted in tense, number or nuance. Where they differ, **the German is the reference**, unless the German itself is wrong.

### 10.2 Each sentence must use its own headword

* `German_Sentence` must contain a **conjugated form of the verb** in `German_Word`. Inflection is expected; for separable verbs the split parts both count (*stehe … auf*); for reflexives the pronoun must be present.
* `English_Sentence` should normally contain the verb from `English_Word`, and `English_Sentence_US` the verb from `English_Word_US`, in some form. **Idiomatic exceptions are acceptable** — e.g. `heißen` = *to be called*, sentence *"What is your name?"* — but flag these as a **suspicion** so a human can confirm the rendering is intended.
* Not acceptable in German: the verb replaced by a synonym, or absent altogether.

### 10.3 Level appropriateness

Use the row's **`Level`** — the level is row-specific; never assume one level for the file.

* Is the verb plausible vocabulary for that CEFR level?
* Do the sentence length, tense and grammar suit the level? An A1 sentence should not require `Konjunktiv II`, passive, `Genitiv` or nested subordinate clauses.
* Does the English sentence match the same difficulty?

### 10.4 Data integrity and suspicious content

* Duplicate verbs at the same level without a distinguishing sense.
* Empty cells where content is required (conjugation, participle, preterite).
* `Type` missing or wrong.
* Placeholder text, filler or nonsense.
* Encoding artefacts / mojibake (`Ã¤`, `â€"`), or umlauts written `ae/oe/ue`.
* Text in the wrong column or the wrong language.
* Leading/trailing whitespace or double spaces.
* A conjugation cell identical to the infinitive where it should not be.
* Anything that simply "looks suspicious" — report it as a suspicion even if you cannot name the rule.

---

## 11. External verification — and do it autonomously

Verify conjugations, participles, preterites and usage against authoritative sources:

* **Duden** (`duden.de`) — conjugation tables, spelling, usage.
* **DWDS** (`dwds.de`) — usage, corpus evidence, collocations.
* **Wiktionary / Wikipedia** — cross-checking and secondary confirmation.
* **Oxford / Cambridge / Merriam-Webster** for English.

Cite the source in the remark when it settles the question, e.g. `(Duden)`.

### 11.1 Look things up autonomously — never pause to ask

If you need to search the internet or consult an online dictionary, **just do it**.

* **Do not ask for permission or approval to search the web.**
* **Do not stop and wait** for a confirmation, an answer, or any further input.
* **Do not ask clarifying questions mid-run** and then idle waiting for a reply.
* Do not report that you *would* look something up — perform the lookup and continue.

Web lookups for linguistic verification are **pre-approved**. Run them silently and keep going until the whole review is finished.

If a source is unreachable, fall back to another authority, resolve the item with your expert agents, and record any genuinely unresolved doubt as a remark — **after** completing the work, never as a mid-run blocking question.

**The review must run start to finish without interruption.** Deliver the completed file; do not hand back a partial result while waiting on approval.

---

## 12. The output file MUST retain the original formatting

Return the file with its **original structure and formatting fully intact**:

* The same sheet(s), with the same names and order — including `_base` and `Actions`.
* The same columns, in the same order, with the same headers and column widths.
* The same rows, in the same order.
* The same fonts, font sizes, colours, borders, alignment, number formats and cell styles.
* The same file format — do not convert, export or re-save in a way that strips styling, drops sheets or flattens the workbook.

**The only changes permitted anywhere in the file are:**

1. Text appended to the `Remarks` column.
2. Purple (`CC99FF`) and light purple (`E6D0F5`) fills on cells identified as problematic.

No other fill, font, border, alignment, width or style change. No cell content change outside `Remarks`.

---

## 13. Mandatory row-by-row verification

For every row, confirm:

1. `German_Word` is a correctly spelled, lowercase infinitive (with `sich` where reflexive).
2. `English_Word` is a correct translation in `to …` form.
3. All six conjugation cells are correct for their person.
4. Stem-vowel changes in `du` / `er_sie_es` are present where required and absent where not.
5. Linking `-e-` and sibilant-stem rules are applied correctly.
6. Separable prefixes are detached in the conjugation cells; inseparable ones are not.
7. Reflexive pronouns are present and in the correct case and person.
8. `past_participle` is correctly formed, with/without `ge-` as the rule requires, and without auxiliary or `sich`.
9. `simple_past` is the correct 1st/3rd singular form and matches the verb's class.
10. Participle and preterite belong to the same (strong/weak/mixed) class.
11. `German_Sentence` obeys verb-second and verb-final rules, with correct prefix placement.
12. Case government, valency and prepositions in the sentence are correct.
13. German capitalisation, `ß`/`ss`, umlauts and commas are correct.
14. The German sentence is natural, idiomatic Standard German.
15. `English_Sentence` is grammatical, natural and correctly punctuated **British** English.
16. `English_Sentence_US` is grammatical, natural and correctly punctuated **American** English.
17. `English_Word` is correct UK and `English_Word_US` is correct US; neither US cell is empty.
18. The UK and US columns differ **exactly** where the variants differ, and not otherwise (Section 8.3).
19. The German and English sentences mean **exactly** the same thing.
20. `German_Sentence` contains a conjugated form of the headword (10.2).
21. `English_Sentence` contains the English verb, or an idiomatic exception has been flagged.
22. The verb, sentence and grammar suit the row's `Level`.
23. `Type` is present and correct; structural problems are flagged light purple.
24. Nothing suspicious remains unreported (10.4).
25. Every mistake found is **both** highlighted **and** written into `Remarks` with the correct answer.
26. No cell outside `Remarks` was modified.

**Do not mark a row as clean merely because nothing obvious jumped out.** Each check must actually be performed.

---

## Final instruction

Accuracy is more important than speed. Take the time needed.

**You are reviewing, not editing. Never correct a cell — report the correction in `Remarks`.**

**Change only the `Remarks` column and the purple / light-purple highlighting. Everything else must be returned untouched, with its original formatting.**

**Every remark must start with `[AI review]`, name the column, state the problem, and give the correct answer.**

**Existing remarks must be ignored as evidence, never deleted, and always appended to.**

**Review British and American English fully and separately — a row is not done until both variants have been checked in their own right.**

**Verify every conjugation, participle and preterite against Duden or DWDS — do not rely on memory. Use the internet freely; web lookups are pre-approved. Never ask for approval and never pause waiting for a reply; run the task start to finish without interruption (Section 11.1).**

**When the whole file is finished, run the entire review a second time with different LLM agents (Section 1G). The task is not complete until both full rounds are done.**
