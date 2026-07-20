# Task: Expert review of the German and English content in the noun file

You are reviewing a file of German nouns with their articles, plurals, German example sentences, and English translations in **both UK and US variants**.

This file is used for a **language-learning project**. Accuracy is therefore critical. **Accuracy is more important than speed.**

Your task is **NOT to translate and NOT to fix**. Your task is to **find mistakes and report them**:

* Find every error in the German and English content.
* **Highlight the offending cell(s) in purple.**
* **Write the problem and the correct answer into the `Remarks` column.**

**You must not change the content of any cell other than `Remarks`.** You are an auditor, not an editor.

---

## 1. Mandatory multi-agent expert workflow

Do **not** complete this review using a single-pass approach.

Use a **multi-agent LLM workflow** with multiple independent expert agents.

### A. German language expert agents

Native-level experts in **Standard German** who check the article, plural, sentence grammar, word order, case, orthography and punctuation of every row. At least one agent must specialise in **German grammar and word order**, and one in **German lexicography** (article/plural verification against dictionaries).

### B. British English expert agents

Native-level experts in **British English** who check `English_Word` and `English_Sentence` for UK spelling, vocabulary, grammar, and punctuation conventions.

### C. American English expert agents

Native-level experts in **American English** who check `English_Word_US` and `English_Sentence_US` for US spelling, vocabulary, grammar, and punctuation conventions.

### D. Contrastive German–English semantic agent

An expert who verifies that the German word/sentence and **both** English variants express **exactly the same meaning**, and that no meaning has been added, lost, or shifted.

### E. CEFR / language-pedagogy agent

An expert who verifies that the word, the sentence, the grammar used, and the vocabulary are **appropriate for the CEFR level in that row's `Level` column**.

### F. Final adjudication agent

Where agents disagree, an adjudicator decides based on **dictionary evidence and grammatical rule**, not majority vote. A disagreement that cannot be resolved by evidence must still be reported as a suspicion in `Remarks`.

### G. Mandatory second round with DIFFERENT models

After the entire file has been reviewed and annotated, **run the whole review again from the start using different LLM agents/models** than the first round.

* The second round must review the file **independently** — it must not simply confirm round one.
* The second round must also re-examine rows that round one marked as clean.
* Any additional findings are appended to `Remarks` in the same format.
* Do not consider the task complete until both full rounds are finished.

---

## 2. What you are reviewing

| Column | Content | Review scope |
|---|---|---|
| `Level` | CEFR level of the row | Is the word/sentence appropriate for it? |
| `German_Article` | `der` / `die` / `das` | Correct gender? |
| `German_Word` | the German noun | Correct, correctly spelled, correctly capitalised? |
| `German_Plural` | the German plural | Correct plural form? |
| `German_Sentence` | German example sentence | Grammar, word order, case, punctuation, contains the word? |
| `English_Word` | English translation — **UK** | Correct meaning, UK spelling/vocabulary? |
| `English_Word_US` | English translation — **US** | Correct meaning, US spelling/vocabulary? |
| `English_Sentence` | English example sentence — **UK** | Grammar, punctuation, UK conventions, same meaning as German? |
| `English_Sentence_US` | English example sentence — **US** | Grammar, punctuation, US conventions, same meaning as German? |

Use the file's **actual column headers**. The names above are the expected headers; if a header differs slightly, use the file's version and never rename it.

---

## 3. Output rules — annotate, never fix

### 3.1 You may change ONLY the `Remarks` column and cell highlighting

* **Never correct a cell.** The corrected value goes into `Remarks` as text, not into the cell.
* Never rewrite German or English content.
* Never change any other column.
* Never add, delete, reorder, rename, hide, merge, or resize rows or columns.

### 3.2 Highlighting

Two distinct fills are used:

| Colour | Hex (ARGB) | Meaning |
|---|---|---|
| **Purple** | `CC99FF` (`FFCC99FF`) | This cell contains a mistake |
| **Light purple** | `E6D0F5` (`FFE6D0F5`) | Profession entry that should be split into multiple rows (Section 9) |

Rules:

* Highlight **every cell that is affected** by a mistake — not just one. If the article is wrong, highlight the article cell; if the sentence also uses the wrong article, highlight the sentence cell too.
* A row may have several highlighted cells and several remarks.
* Do **not** highlight cells that are correct.
* Do **not** apply any other fill, font, border, alignment, width, or style change anywhere in the file.

### 3.3 `Remarks` format — every entry is tagged

Every entry you add must begin with the tag **`[AI review]`**, name the column, state the problem, and give the correct answer:

```
[AI review] <Column>: <what is wrong and why>. Correct: <the right answer>. <source, if used>
```

Examples:

```
[AI review] German_Plural: "Anzuge" is missing the umlaut. Correct: "Anzüge". (Duden)
[AI review] German_Article: "das Tür" is wrong; "Tür" is feminine. Correct: "die". (DWDS)
[AI review] German_Sentence: verb-second rule violated — "Heute ich gehe ins Kino." Correct: "Heute gehe ich ins Kino."
[AI review] English_Word_US: "colour" is UK spelling. Correct (US): "color".
[AI review] English_Sentence: sentence does not contain the headword "answer". Correct: rewrite so that "answer" appears.
```

* **One entry per distinct problem.** Put each on its own line.
* Cover **all affected cells in that row** — if three cells are wrong, there must be three entries (or one entry naming all three columns).
* Write remarks in **English**.

### 3.4 Existing remarks

* If `Remarks` already contains text, **ignore its content** — do not treat it as proof the row is correct, and do not treat it as proof it is wrong.
* **Never delete or edit an existing remark.**
* **Append** your `[AI review]` entries below the existing text, on new lines.
* Review the row fully and independently regardless of what the existing remark says.

---

## 4. Per-row control columns

These override the general rules for that row:

* **`AI _Ignores_Article`** (note the space after `AI`) — When this is `x`, **do not review, flag, highlight, or comment on `German_Article` for that row.** Review everything else in the row normally.
* **`AI_Ignores_Plural`** — When this is `x`, **do not review, flag, highlight, or comment on `German_Plural` for that row.** Review everything else in the row normally.
* **`Instructions for AI`** — When this column contains text, it is a **binding instruction for that row** and must be followed. It takes priority over the general guidance in this document.

---

## 5. German review — expert checklist

### 5.1 Article (`der` / `die` / `das`)

* Verify the gender against **Duden** or **DWDS** for every row.
* Check suffix-driven genders: `-ung`, `-heit`, `-keit`, `-schaft`, `-ei`, `-ion`, `-tät`, `-ik`, `-ur` → **die** · `-ling`, `-ismus`, `-or`, `-er` (agent nouns) → **der** · `-chen`, `-lein`, `-ment`, `-um`, `-tum` → **das**.
* **Diminutives are always neuter**: `das Mädchen`, `das Brötchen` — even when the base noun is not.
* **A compound takes the gender of its LAST element**: `das Haus` + `die Tür` → **die** Haustür.
* Watch homographs whose gender changes the meaning — flag if the wrong one is used for the sentence:
  `der See` (lake) / `die See` (sea) · `der Band` (volume) / `das Band` (ribbon) / `die Band` (music group) · `der Tor` (fool) / `das Tor` (gate) · `der Kiefer` (jaw) / `die Kiefer` (pine) · `der Leiter` (leader) / `die Leiter` (ladder) · `der Gehalt` (content) / `das Gehalt` (salary) · `der Verdienst` (earnings) / `das Verdienst` (merit)

### 5.2 Plural

* Verify the plural against **Duden**/**DWDS**.
* Check the plural class and, critically, **whether an umlaut is required**:
  `der Anzug → die Anzüge` · `das Haus → die Häuser` · `der Vater → die Väter` · `die Mutter → die Mütter` · `der Apfel → die Äpfel` · `die Hand → die Hände`
* `-in` → **-innen** (double n): `die Lehrerin → die Lehrerinnen`.
* Loanwords usually take `-s`: `das Auto → die Autos`, `das Hotel → die Hotels`.
* **Weak masculine (n-declension)** nouns: `der Junge → die Jungen`, `der Student → die Studenten`, `der Name → die Namen`, `der Herr → die Herren`.
* **A compound's plural is the plural of its LAST element**: `die Haustür → die Haustüren`.
* **Singularetantum** (no plural) — flag an invented plural: `das Obst`, `die Milch`, `der Schnee`, `das Glück`, `die Musik`, `das Gepäck`, `die Polizei`.
* **Pluraletantum** (plural only) — flag an invented singular: `die Eltern`, `die Ferien`, `die Leute`, `die Geschwister`, `die Kosten`.

### 5.3 Sentence — verb position (the most common error)

* **Main clause: the finite verb is the SECOND element (V2).**
  Wrong: *Heute ich gehe ins Kino.* Correct: **Heute gehe ich ins Kino.**
* **Inversion** is obligatory when anything other than the subject is fronted.
* **Subordinate clauses send the finite verb to the END** — after `weil`, `dass`, `wenn`, `ob`, `als`, `obwohl`, `damit`, `bevor`, `nachdem`, and in relative clauses.
  Correct: *Ich weiß, dass er heute **kommt**.*
* **Separable-prefix verbs**: the prefix goes to the end of the main clause — *Ich **stehe** um sieben Uhr **auf**.*
* **Perfect tense**: auxiliary in V2, participle at the end — *Ich **habe** einen Anzug **gekauft**.* Check `haben` vs `sein` (motion/change of state → `sein`).
* **Modal verbs**: infinitive at the end — *Ich **muss** heute **arbeiten**.*
* **Future / passive**: `werden` in V2, infinitive/participle at the end.
* **Questions**: yes/no questions start with the verb; W-questions put the verb straight after the question word.
* Check **TeKaMoLo** order in the middle field (Temporal – Kausal – Modal – Lokal).

### 5.4 Case, agreement and valency

* Nominative / accusative / dative / genitive used correctly.
* **Adjective endings** (strong / weak / mixed declension) — a frequent error:
  `ein schwarz**er** Anzug` · `der schwarz**e** Anzug` · `einen schwarz**en** Anzug`
* **Two-way prepositions** (`in`, `an`, `auf`, `über`, `unter`, `vor`, `hinter`, `neben`, `zwischen`): accusative for motion/direction, dative for location.
* **Dative-only**: `aus`, `bei`, `mit`, `nach`, `seit`, `von`, `zu`, `gegenüber`.
* **Accusative-only**: `durch`, `für`, `gegen`, `ohne`, `um`.
* **Genitive**: `während`, `wegen`, `trotz`, `statt`.
* **Dative verbs**: `helfen`, `danken`, `gefallen`, `gehören`, `antworten`, `folgen`.
* Pronoun and possessive agreement with the noun's gender and case.

### 5.5 Orthography and punctuation

* **All nouns are capitalised** in German — flag any lowercase noun.
* **`ß` vs `ss`**: `ß` after a long vowel or diphthong (`Straße`, `heiß`, `groß`); `ss` after a short vowel (`Fluss`, `dass`, `muss`). Flag `ss` used where `ß` is required and vice versa.
* Umlauts `ä ö ü` present and correct; never written as `ae/oe/ue` in normal text.
* **A comma before a subordinate clause is mandatory** in German (unlike English): *Ich weiß**,** dass er kommt.*
* Comma before relative clauses; comma between coordinated main clauses.
* No comma before `und` in a simple list.
* Sentence ends with `.`, `?` or `!`.
* German quotation marks `„…"` or `»…«` if quotes are used.
* No stray double spaces, no leading/trailing whitespace.

### 5.6 Word choice, register and naturalness

* The sentence must be **natural, idiomatic German** that a native speaker would actually say.
* Correct collocations (`eine Entscheidung **treffen**`, not *machen*).
* **Standard German** — flag Austrian/Swiss regionalisms unless the entry is explicitly about them (`Jänner` → `Januar`, `Sackerl` → `Tüte`, `Velo` → `Fahrrad`).
* Flag unnecessary Anglicisms where a normal German word exists — unless the headword itself is the loanword.
* Register appropriate for a learner: neutral, everyday, non-offensive.

---

## 6. English review — UK and US, both fully checked

`English_Word` / `English_Sentence` are **British English**. `English_Word_US` / `English_Sentence_US` are **American English**. Each must be correct **in its own variant**.

### 6.1 Spelling differences

| Pattern | UK | US |
|---|---|---|
| `-our` / `-or` | colour, favour, neighbour | color, favor, neighbor |
| `-re` / `-er` | centre, theatre, metre | center, theater, meter |
| `-ise` / `-ize` | organise, realise | organize, realize |
| `-yse` / `-yze` | analyse | analyze |
| `-ll-` / `-l-` | travelled, cancelled | traveled, canceled |
| `-ce` / `-se` | defence, licence (n.) | defense, license |
| `ae` / `oe` | paediatric, oesophagus | pediatric, esophagus |
| other | programme, tyre, kerb, grey, plough, cheque, jewellery, aluminium, storey, draught, pyjamas, moustache, aeroplane, catalogue | program, tire, curb, gray, plow, check, jewelry, aluminum, story, draft, pajamas, mustache, airplane, catalog |

### 6.2 Vocabulary differences

flat/**apartment** · lift/**elevator** · lorry/**truck** · biscuit/**cookie** · autumn/**fall** · petrol/**gas** · pavement/**sidewalk** · holiday/**vacation** · football/**soccer** · rubbish/**garbage** · mobile phone/**cell phone** · trousers/**pants** · jumper/**sweater** · tap/**faucet** · wardrobe/**closet** · underground/**subway** · queue/**line** · maths/**math** · chemist/**drugstore** · film/**movie** · nappy/**diaper** · rubber/**eraser** · bonnet/**hood** · boot/**trunk** · windscreen/**windshield** · motorway/**highway** · car park/**parking lot** · city centre/**downtown** · chips/**fries** · crisps/**chips** · aubergine/**eggplant** · courgette/**zucchini** · postcode/**zip code** · bill/**check** (restaurant) · timetable/**schedule** · torch/**flashlight** · cooker/**stove** · cupboard/**cabinet** · garden/**yard** · shop/**store** · trainers/**sneakers** · plaster/**Band-Aid** · CV/**résumé** · secondary school/**high school** · headmaster/**principal** · term/**semester**

**Floor numbering differs and is a real trap:** UK *ground floor* = US *first floor*; UK *first floor* = US *second floor*. Flag any sentence where this makes the two variants mean different things.

### 6.3 Grammar differences

| Feature | UK | US |
|---|---|---|
| Collective nouns | the team **are** | the team **is** |
| Recent past | I've just eaten | I just ate |
| Possession | I've **got** a car | I **have** a car |
| Past participle of *get* | got | **gotten** |
| Weekend | **at** the weekend | **on** the weekend |
| Hospital | in hospital | in **the** hospital |
| Different… | different **from/to** | different **from/than** |
| Irregular verbs | learnt, dreamt, spelt, burnt | learned, dreamed, spelled, burned |
| Dates | 4 July 2026 | July 4, 2026 |

### 6.4 Punctuation conventions

* **Quotation marks**: UK commonly single `'…'` with punctuation **outside** unless part of the quote; US double `"…"` with commas and periods **inside**.
* **Serial (Oxford) comma**: standard in US usage; optional and less common in UK usage. Flag inconsistency within a variant.
* **Abbreviations**: US writes `Mr.`, `Mrs.`, `Dr.` with a period; UK usually writes `Mr`, `Mrs`, `Dr` without.
* Apostrophes correct — especially `its` (possessive) vs `it's` (it is).
* Sentence ends with correct terminal punctuation.
* No double spaces, no leading/trailing whitespace.

### 6.5 General English quality (both variants)

* Subject–verb agreement.
* **`a` vs `an` is decided by SOUND**, not letter: *an hour*, *a university*, *an MP*.
* **Uncountable nouns** take no plural and no `a/an`: *information*, *advice*, *furniture*, *news*, *luggage*, *homework*.
* Correct and consistent tense.
* Natural collocation — flag translationese and word-for-word renderings of German.
* Capitalisation: English **does** capitalise days, months, languages and nationalities (`Monday`, `July`, `German`) — but **not** common nouns. Flag German-style noun capitalisation carried into English.

### 6.6 Consistency between the UK and US columns

This check is frequently missed:

* If the two variants **genuinely differ**, the UK and US cells **must differ**. Flag a row where both cells are identical but the word or spelling really does differ (e.g. both say `colour`, or both say `apartment`).
* If the two variants **do not differ**, the UK and US cells **must be identical**. Flag a spurious difference invented where none exists.
* Apply the same test to `English_Sentence` vs `English_Sentence_US`.

---

## 7. Cross-language and content checks

### 7.1 Meaning equivalence

* `German_Word` and both English words must denote **the same concept**.
* `German_Sentence` and both English sentences must express **exactly the same meaning** — nothing added, nothing lost, no shift in tense, number, or nuance.
* If the English differs from the German in meaning, **the German is the reference** — report the English as the error, unless the German itself is wrong.

### 7.2 Each sentence must contain its own headword

* `German_Sentence` must contain `German_Word`.
* `English_Sentence` must contain `English_Word`; `English_Sentence_US` must contain `English_Word_US`.
* `Spanish_Sentence_*`, where present, must contain the corresponding Spanish word.

**Inflected and declined forms are fine** — plural, case, verb-derived forms, capitalisation. What is *not* acceptable:

* the word replaced by a **synonym**;
* the word replaced by a **pronoun**;
* the word **omitted** because it is implied;
* only **part** of the word present (see Section 8).

### 7.3 Data integrity and suspicious content

Flag anything that looks wrong, including:

* Duplicate entries (same word at the same level) without a distinguishing sense.
* Empty cells where content is required.
* Placeholder text, obvious filler, or nonsense.
* Encoding artefacts / mojibake (`Ã¤`, `â€"`), or umlauts written as `ae/oe/ue`.
* Text in the wrong column or the wrong language.
* Sentence missing terminal punctuation.
* Leading/trailing whitespace or double spaces.
* Anything that simply "looks suspicious", even if you cannot name the rule — report it as a suspicion.

---

## 8. Compound words

A recurring, high-priority error class.

* **If the sentence uses a compound but the headword is not that compound, it is wrong.**
  Example: `German_Word` = `Tür`, but `German_Sentence` = *Ich öffne die **Haustür**.* → the sentence does not use the headword. Flag both cells.
* Conversely, if `German_Word` is a compound (`Haustür`) but the sentence uses only part of it (`Tür`), flag it.
* If `German_Word` is a compound, `German_Plural` must be the plural of the **whole compound**, formed from its last element (`Haustür → Haustüren`), not the plural of the base word.
* The compound's **article must match its last element** (`die Haustür`, not *das Haustür*).
* Check the linking element (*Fugenelement*) is correct: `Arbeit**s**zimmer`, `Sonne**n**schein`, `Tage**s**zeit`.
* Compounds are written as **one word** in German — flag a compound split into separate words.
* Check the English translations render the compound as a whole concept, not word-by-word.

---

## 9. Professions and gendered person nouns

German profession nouns have distinct masculine and feminine forms: `der Lehrer` / `die Lehrerin`.

* **Each form should be its own row.**
* If a single row tries to cover both — for example `German_Article` contains `der/die`, or `German_Word` contains `Lehrer/Lehrerin` — that entry is **incorrectly structured**.
* In that case: **highlight `German_Word` in LIGHT PURPLE (`E6D0F5`)** and append a remark such as:

```
[AI review] German_Word: profession with masculine and feminine forms in a single entry. Should be split into separate rows: "der Lehrer" and "die Lehrerin".
```

* Also check the feminine form is correctly built (`-in`, plural `-innen`) and that the English translation is appropriately gender-neutral where English has no distinct form.

---

## 10. Level appropriateness

Use the row's **`Level`** value — the level is **row-specific**, never assume one level for the file.

Check that:

* The **word** is plausible vocabulary for that CEFR level.
* The **sentence length and complexity** suit the level.
* The **grammar used** suits the level — e.g. an A1 sentence should not need `Konjunktiv II`, passive voice, `Genitiv`, or nested subordinate clauses.
* The English sentences match the same level of difficulty as the German.

Report a mismatch as a remark; do not rewrite the sentence.

---

## 11. External verification — and do it autonomously

Verify articles, plurals, spellings and usage against authoritative sources:

* **Duden** (`duden.de`) — German articles, plurals, spelling, usage.
* **DWDS** (`dwds.de`) — German usage, corpus evidence, collocations.
* **Wiktionary / Wikipedia** — cross-checking and secondary confirmation.
* **Oxford / Cambridge dictionaries** for British English; **Merriam-Webster** for American English.

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

* The same sheet(s), with the same names and order.
* The same columns, in the same order, with the same headers and column widths.
* The same rows, in the same order.
* The same fonts, font sizes, colours, borders, alignment, number formats, and cell styles.
* The same file format — do not convert, export, or re-save in a way that strips styling, drops sheets, or flattens the workbook.

**The only changes permitted anywhere in the file are:**

1. Text appended to the `Remarks` column.
2. Purple (`CC99FF`) and light purple (`E6D0F5`) fills on cells identified as problematic.

No other fill, font, border, alignment, width, or style change. No cell content change outside `Remarks`.

---

## 13. Mandatory row-by-row verification

For every row, confirm:

1. `German_Article` is correct and dictionary-verified — unless `AI _Ignores_Article` is `x`.
2. `German_Word` is correctly spelled and capitalised.
3. `German_Plural` is correct, including umlaut and n-declension — unless `AI_Ignores_Plural` is `x`.
4. Singularetantum / Pluraletantum handled correctly.
5. `German_Sentence` obeys the verb-second rule and verb-final in subordinate clauses.
6. Separable prefixes, perfect auxiliaries, and modal infinitives are correctly positioned.
7. Case, adjective endings, and preposition government are correct.
8. German capitalisation, `ß`/`ss`, umlauts and commas are correct.
9. The German sentence is natural, idiomatic Standard German.
10. `English_Word` is correct **British** English.
11. `English_Word_US` is correct **American** English.
12. `English_Sentence` is correct British English — spelling, grammar, punctuation.
13. `English_Sentence_US` is correct American English — spelling, grammar, punctuation.
14. The UK and US columns differ **exactly** where the variants differ, and not otherwise (6.6).
15. The German and both English sentences mean **exactly** the same thing.
16. Each sentence contains its own headword (7.2).
17. Compound-word rules are satisfied (Section 8).
18. Profession entries are correctly split, or flagged light purple (Section 9).
19. The word, sentence and grammar suit the row's `Level` (Section 10).
20. `Instructions for AI` for that row was read and followed.
21. Nothing suspicious remains unreported (7.3).
22. Every mistake found is **both** highlighted **and** written into `Remarks` with the correct answer.
23. No cell outside `Remarks` was modified.

**Do not mark a row as clean merely because nothing obvious jumped out.** Each check must actually be performed.

---

## Final instruction

Accuracy is more important than speed. Take the time needed.

**You are reviewing, not editing. Never correct a cell — report the correction in `Remarks`.**

**Change only the `Remarks` column and the purple / light-purple highlighting. Everything else in the file must be returned untouched, with its original formatting.**

**Every remark must start with `[AI review]`, name the column, state the problem, and give the correct answer.**

**Existing remarks must be ignored as evidence, never deleted, and always appended to.**

**Respect `AI _Ignores_Article`, `AI_Ignores_Plural`, and `Instructions for AI` for each row.**

**Review both British and American English fully and separately — a row is not done until both variants have been checked in their own right.**

**Verify articles, plurals and usage against Duden, DWDS and other standard references. Use the internet freely — web lookups are pre-approved. Never ask for approval and never pause waiting for a reply; run the task start to finish without interruption (Section 11.1).**

**When the whole file is finished, run the entire review a second time with different LLM agents (Section 1G). The task is not complete until both full rounds are done.**
