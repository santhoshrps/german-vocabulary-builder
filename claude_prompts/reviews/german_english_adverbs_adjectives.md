# Task: Expert review of the German and English content in the ADVERBS / ADJECTIVES file

You are reviewing a file of German adjectives and adverbs with their English translations, example sentences, and comparative and superlative forms.

This file is used for a **language-learning project**. Accuracy is therefore critical. **Accuracy is more important than speed.**

Your task is **NOT to translate and NOT to fix**. Your task is to **find mistakes and report them**:

* Find every error in the German and English content.
* **Highlight the offending cell(s) in purple.**
* **Write the problem and the correct answer into the `Remarks` column.**

**In the review you must not change the content of any cell other than `Remarks`.** You are an auditor, not an editor.

---

## 1. Mandatory multi-agent expert workflow

Do **not** complete this review using a single-pass approach. Use a **multi-agent LLM workflow** with multiple independent expert agents.

### A. German adjective/adverb morphology expert agents

Native-level experts in **Standard German** who verify comparative and superlative formation, umlaut, irregular gradation, and — critically — **whether the word can be graded at all**. Verified against Duden/DWDS.

### B. German syntax expert agents

Experts who check the German sentence for adjective declension, word order, case, and naturalness, and who verify whether the word is used **attributively, predicatively or adverbially**.

### C. English expert agents

Native-level experts who check `English_Word` and `English_Sentence` for correct meaning, grammar, spelling, punctuation and natural phrasing — including whether an **adjective** has been translated with an adjective and an **adverb** with an adverb.

### D. Contrastive German–English semantic agent

An expert who verifies that the German and English express **exactly the same meaning**, with nothing added, lost or shifted.

### E. CEFR / language-pedagogy agent

An expert who verifies that the word, sentence and grammar are **appropriate for the CEFR level in that row's `Level` column**.

### F. Final adjudication agent

Where agents disagree, an adjudicator decides on **dictionary evidence and grammatical rule**, not majority vote. An unresolved disagreement must still be reported as a suspicion in `Remarks`.

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
| `Level` | CEFR level of the row | Is the word/sentence appropriate for it? |
| `Type` | `Adjective` or `Adverb` | Present and correctly classified? |
| `Sense` | optional disambiguation | If filled, use it to decide which meaning is intended |
| `German_Word` | the German adjective/adverb, base form | Correct, correctly spelled, lowercase? |
| `English_Word` | English translation (**UK**) | Correct meaning **and correct word class**? |
| `English_Word_US` | English translation (**US**) | Correct US form and word class? |
| `German_Sentence` | German example sentence | Declension, word order, case, punctuation, uses the word? |
| `English_Sentence` | English example sentence (**UK**) | Grammar, punctuation, same meaning as German? |
| `English_Sentence_US` | English example sentence (**US**) | Grammar, punctuation, same meaning as German? |
| `German_Comparative` | comparative (Komparativ) | Correctly formed — **or correctly left empty**? |
| `German_Superlative` | superlative (Superlativ) | Correctly formed — **or correctly left empty**? |

Use the file's **actual column headers**; never rename them.

### 2.1 Established conventions in this file

* `German_Word` is the **undeclined base form**, lowercase: `schnell`, `interessant`, `gut`.
* `German_Comparative` is the bare comparative: `schneller`, `besser`.
* `German_Superlative` uses the **`am …sten` form**: `am schnellsten`, `am besten`. Flag any row that instead uses the declined `der/die/das …ste` form — the file must be internally consistent.
* `German_Comparative` and `German_Superlative` are **empty for words that cannot be graded**. In this file roughly 40% of rows are legitimately empty.

**This file has FOUR English columns.** `English_Word` / `English_Sentence` are **British English**; `English_Word_US` / `English_Sentence_US` are **American English**. Each pair must be correct **in its own variant**, and they must differ **exactly where the variants genuinely differ, and not otherwise** (Section 7.3).

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
| **Light purple** | `E6D0F5` (`FFE6D0F5`) | Structural problem — wrong `Type`, or the entry should be split (Section 9) |
| **Light blue** | `ADD8E6` (`FFADD8E6`) | *Pre-existing* — content written or corrected in an earlier content-addition pass. **Not** a review finding; never remove it |

* Highlight **every affected cell**. If a non-gradable word has invented forms, highlight **both** `German_Comparative` **and** `German_Superlative`.
* Do **not** highlight correct cells.
* Apply no other fill, font, border, alignment, width or style change.

**Note on light blue:** cells filled **light blue `ADD8E6`** were written or corrected in an earlier content-addition pass. Light blue is **not** a review finding and is **not** proof the cell is correct — review those cells independently like any other. **Never remove a light-blue fill.** If such a cell turns out to be wrong, record it the normal way: change its fill to purple and add a `[AI review]` remark.


### 3.3 `Remarks` format — every entry is tagged

```
[AI review] <Column>: <what is wrong and why>. Correct: <the right answer>. <source, if used>
```

Examples:

```
[AI review] German_Comparative: "alter" is missing the umlaut. Correct: "älter". (Duden)
[AI review] German_Superlative: "am gutsten" — "gut" is irregular. Correct: "am besten".
[AI review] German_Comparative / German_Superlative: "deutsch" is a classifying adjective and is not gradable. Correct: both cells should be empty.
[AI review] German_Comparative: value is identical to the base form "chinesisch". Correct: the cell should be empty (not gradable).
[AI review] English_Word: German "schnell" as an adverb should be translated "quickly", not "quick".
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

## 4. Gradability — the highest-priority check in this file

**Before checking how a comparative is formed, check whether the word may be graded at all.** Inventing forms for non-gradable words is the single largest error class in this file.

### 4.1 Words that must have EMPTY comparative and superlative

Flag any filled cell for these, and state that both cells should be empty:

* **Nationality / origin / language adjectives** — these classify rather than describe: `deutsch`, `arabisch`, `chinesisch`, `französisch`, `italienisch`, `russisch`, `spanisch`, `bayrisch`. There is no normal *„deutscher / am deutschesten"* in the descriptive sense.
* **Absolute / binary adjectives**: `tot`, `schwanger`, `rund`, `viereckig`, `einzig`, `ganz`, `halb`, `maximal`, `minimal`, `optimal`, `total`, `absolut`, `komplett`, `identisch`.
* **Material adjectives**: `hölzern`, `golden`, `stählern`, `gläsern`.
* **Adjectives already expressing a maximum**: `perfekt`, `ideal`, `endgültig`, `unmöglich`, `tödlich`.
* **Time/place-classifying adverbs**: `heute`, `morgen`, `gestern`, `hier`, `dort`, `jetzt`, `nie`, `immer`.
* **Modal / sentence adverbs**: `vielleicht`, `wahrscheinlich`, `leider`, `natürlich`, `wirklich`.

If a word is used figuratively in a way that *does* permit gradation, say so in the remark rather than simply demanding an empty cell.

### 4.2 Comparative identical to the base form

If `German_Comparative` is **the same string as `German_Word`**, it is always an error. Either the word is gradable (and the comparative is missing) or it is not (and the cell should be empty). Flag it and say which.

### 4.3 Adverbs and gradation

Many adverbs are gradable (`schnell`, `langsam`, `früh`, `weit`, `oft`, `gern`) and legitimately carry forms. Others are not (Section 4.1). Judge each row individually — do **not** assume `Type = Adverb` implies no gradation, nor that it implies gradation.

---

## 5. Comparative and superlative formation — expert checklist

Verify every filled form against **Duden**/**DWDS**.

### 5.1 Regular formation

* Comparative: base + `-er` → `schnell` → *schneller*.
* Superlative: `am` + base + `-sten` → *am schnellsten*.

### 5.2 Superlative `-sten` vs `-esten`

Adjectives ending in **`-d`, `-t`, `-s`, `-ß`, `-x`, `-z`, `-sch`** normally take **`-esten`**:
*am ältesten*, *am heißesten*, *am kürzesten*, *am interessantesten*, *am genauesten*, *am weitesten*, *am frühesten*

Others take `-sten`: *am schnellsten*, *am klarsten*, *am langsamsten*.

This distinction is frequently wrong — check every superlative, and be aware that some `-sch` adjectives take `-esten` (*am deutschesten*) while others take `-sten` (*am arabischsten*). **Verify each against Duden rather than applying the rule blindly.**

### 5.3 Umlaut in the comparative and superlative

Many one-syllable adjectives take an umlaut — a very common omission:

`alt` → *älter, am ältesten* · `jung` → *jünger, am jüngsten* · `groß` → *größer, am größten* · `lang` → *länger, am längsten* · `kurz` → *kürzer, am kürzesten* · `warm` → *wärmer, am wärmsten* · `kalt` → *kälter, am kältesten* · `stark` → *stärker, am stärksten* · `schwach` → *schwächer* · `hart` → *härter* · `scharf` → *schärfer* · `dumm` → *dümmer* · `klug` → *klüger* · `arm` → *ärmer* · `krank` → *kränker*

Equally, flag an umlaut applied where it does not belong: `flach` → *flacher* (not *flächer*), `klar` → *klarer*, `voll` → *voller*, `froh` → *froher*, `bunt` → *bunter*, `stolz` → *stolzer*, `rasch` → *rascher*, `schlank` → *schlanker*.

### 5.4 Irregular gradation

| Base | Comparative | Superlative |
|---|---|---|
| `gut` | besser | am besten |
| `viel` | mehr | am meisten |
| `gern` | lieber | am liebsten |
| `hoch` | höher | am höchsten |
| `nah` | näher | am nächsten |
| `groß` | größer | am größten |
| `bald` | eher | am ehesten |
| `wenig` | weniger / minder | am wenigsten / am mindesten |
| `oft` | öfter / häufiger | am häufigsten (also *am öftesten*) |

Note `hoch` → *höher* drops the `c`, and `groß` → *am größten* has no `-e-`.

### 5.5 Adjectives in `-el`, `-er`, `-en`

The `e` is dropped in the comparative: `dunkel` → *dunkler* · `teuer` → *teurer* · `sauer` → *saurer* · `trocken` → *trockner / trockener*. Flag *dunkeler*, *teuerer*.

---

## 6. German sentence — expert checklist

### 6.1 Adjective declension

Adjectives take endings when used **attributively** (before a noun) and none when used **predicatively**:

* Predicative — **no ending**: *Das Auto ist **schnell**.*
* Attributive after a definite article (weak): *das **schnelle** Auto*, *der **alte** Mann*
* Attributive after an indefinite article (mixed): *ein **schnelles** Auto*, *ein **alter** Mann*
* Attributive with no article (strong): ***schnelles** Auto*, ***guter** Wein*

Check the ending agrees with **gender, number and case**: *Ich esse gern chinesisch**es** Essen.* (neuter, accusative, no article → `-es`).

Flag a missing ending on an attributive adjective, and a superfluous ending on a predicative one.

### 6.2 Adjective vs adverb usage

German uses the **same base form** for the adjective and the adverb (`schnell` = *quick* and *quickly*). Check that:

* The sentence uses the word in the way the `Type` column claims.
* The **English translation matches the word class actually used**: *Er fährt schnell* → *He drives **quickly*** (adverb), not *quick*.
* An `Adverb` row whose sentence uses the word attributively (with a declension ending) is suspect — flag it.

### 6.3 Comparative and superlative inside sentences

* The comparative is declined like a normal adjective when attributive: *ein **schnelleres** Auto*.
* `als` is used for comparison, **not** `wie`: *Er ist größer **als** ich.* Flag *größer wie ich*.
* `so … wie` for equality: *so groß **wie** ich*.
* The `am …sten` form is adverbial/predicative; the attributive superlative is declined with an article: *das **schnellste** Auto*. Flag *das am schnellsten Auto*.

### 6.4 Language names after `sprechen` — check carefully

Both spellings exist with different readings:

* *Ich spreche **Deutsch**.* — the language as a noun (capitalised).
* *Ich spreche **deutsch**.* — adverbial, "in German" (lowercase).

For a learner file the capitalised noun form is usually intended after `sprechen`. Where the row's `German_Word` is a language adjective, check that the sentence's capitalisation matches the intended reading, and flag the mismatch with an explanation rather than assuming one is simply wrong.

### 6.5 Word order

* **Main clause: finite verb second (V2)**; inversion when something else is fronted.
* **Subordinate clause: finite verb last** (`weil`, `dass`, `wenn`, `obwohl`, relative clauses).
* Separable prefixes at the end; participles and infinitives at the end.
* **TeKaMoLo** order in the middle field (Temporal – Kausal – Modal – Lokal).

### 6.6 Orthography and punctuation

* All **nouns capitalised**; adjectives and adverbs stay lowercase unless nominalised (*das Beste*, *im Allgemeinen*).
* **`ß` vs `ss`**: `ß` after a long vowel or diphthong (*groß*, *heiß*); `ss` after a short vowel (*muss*, *dass*).
* Umlauts present and correct; never `ae/oe/ue`.
* **A comma before a subordinate clause is mandatory**; comma before `als`-comparisons only where a clause follows.
* Sentence ends with `.`, `?` or `!`.
* No double spaces, no leading/trailing whitespace.

### 6.7 Naturalness and register

* Natural, idiomatic Standard German; correct collocations.
* Flag Austrian/Swiss regionalisms unless intended.
* Neutral, everyday, non-offensive register suitable for learners.

---

## 7. English review — UK and US, both fully checked

`English_Word` / `English_Sentence` are **British English**. `English_Word_US` / `English_Sentence_US` are **American English**. Each must be correct **in its own variant** — review them separately, not as one.

Applies to **all four** English cells:

* The word must match the **word class actually used**: adjective → adjective (*quick*), adverb → adverb (*quickly*). This is the most common English error in this file.
* Where several senses are listed with ` / `, each must be a genuine translation of the same German word.
* The sentence must be **grammatical, natural and idiomatic** in its variant.
* English comparatives: `-er`/`-est` for short adjectives (*faster, fastest*), `more`/`most` for longer ones (*more interesting*). Flag double comparatives (*more faster*).
* Irregular English gradation: *good → better → best*, *bad → worse → worst*, *much/many → more → most*, *little → less → least*, *far → further/farther → furthest/farthest*.
* Subject–verb agreement; correct and consistent tense.
* **`a` vs `an` by SOUND**: *an hour*, *a university*.
* **Uncountables** take no plural/article: *information*, *advice*, *furniture*, *news*.
* Correct punctuation and terminal punctuation; apostrophes correct (`its` vs `it's`).
* English capitalises days, months, languages and nationalities (*German*, *Arabic*) — but **not** common nouns. Flag German-style noun capitalisation carried into English, and flag a lowercase language name in English.
* Flag translationese — English mirroring German word order rather than reading naturally.

### 7.1 Spelling differences

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

### 7.2 Vocabulary and grammar differences

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

### 7.3 UK/US consistency between the columns — frequently missed

* If the variants **genuinely differ**, the UK and US cells **must differ**. Flag a row where both say `colour`, or both say `apartment`.
* If the variants **do not differ**, the UK and US cells **must be identical**. Flag a spurious difference invented where none exists.
* Apply the same test to `English_Sentence` vs `English_Sentence_US`.
* Never leave a US cell empty.
* Within a single cell, do not mix variants (`colour` + `organize`).

---

## 8. Cross-language and content checks

### 8.1 Meaning equivalence

`German_Word` and `English_Word` must denote the same quality, **in the same word class**. `German_Sentence` and `English_Sentence` must express **exactly the same meaning** — nothing added, lost or shifted. Where they differ, **the German is the reference**, unless the German itself is wrong.

### 8.2 Each sentence must use its own headword

* `German_Sentence` must contain the word from `German_Word`. **Declined and graded forms count** (*schnelles*, *schneller*, *am schnellsten*).
* `English_Sentence` should contain the word from `English_Word`, and `English_Sentence_US` the word from `English_Word_US`, allowing for its adjective/adverb form (*quick* / *quickly*).
* Not acceptable: the word replaced by a synonym, replaced by a pronoun, or absent altogether.

### 8.3 Level appropriateness

Use the row's **`Level`** — the level is row-specific; never assume one level for the file.

* Is the word plausible vocabulary for that CEFR level?
* Do the sentence length and grammar suit the level? An A1 sentence should not require `Konjunktiv II`, passive, `Genitiv` or nested subordinate clauses.
* Comparative/superlative structures are typically introduced around A2 — flag an A1 row whose sentence depends on them.
* Does the English sentence match the same difficulty?

### 8.4 Data integrity and suspicious content

* Duplicate words at the same level without a distinguishing sense.
* **`Type` missing** (at least one row in this file has no `Type`), or set to something other than `Adjective`/`Adverb`.
* Comparative filled but superlative empty, or vice versa — the pair should normally both be present or both be absent.
* Comparative identical to the base form (Section 4.2).
* Placeholder text, filler or nonsense.
* Encoding artefacts / mojibake (`Ã¤`, `â€"`), or umlauts written `ae/oe/ue`.
* Text in the wrong column or the wrong language.
* Leading/trailing whitespace or double spaces.
* Anything that simply "looks suspicious" — report it as a suspicion even if you cannot name the rule.

---

## 9. Structural problems — light purple

Use **light purple (`E6D0F5`)** on `German_Word` (and `Type` where relevant) when the entry itself is wrongly structured:

* **`Type` is missing, or an adverb is labelled `Adjective` (or vice versa)** when the sentence clearly uses the other class.
* One row conflates **two genuinely different words or senses** that should be separate rows — e.g. `gerade` (straight / just now), `schwer` (heavy / difficult), `fest` (firm / fixed).
* The entry mixes an adjective use and an adverb use that translate differently in English and would need separate rows to be taught correctly.

Example remark:

```
[AI review] Type: the sentence uses "schnell" adverbially ("Er fährt schnell"), but Type is "Adjective". Correct: either change Type to "Adverb" or use an attributive example sentence.
```

---

## 10. External verification — and do it autonomously

Verify gradation, spelling and usage against authoritative sources:

* **Duden** (`duden.de`) — comparative/superlative forms, gradability, spelling.
* **DWDS** (`dwds.de`) — usage, corpus evidence, collocations.
* **Wiktionary / Wikipedia** — cross-checking and secondary confirmation.
* **Oxford / Cambridge / Merriam-Webster** for English.

Where Duden lists **no** comparative or superlative for a word, that is strong evidence the word is not gradable — cite it: `(Duden: no comparative listed)`.

### 10.1 Look things up autonomously — never pause to ask

If you need to search the internet or consult an online dictionary, **just do it**.

* **Do not ask for permission or approval to search the web.**
* **Do not stop and wait** for a confirmation, an answer, or any further input.
* **Do not ask clarifying questions mid-run** and then idle waiting for a reply.
* Do not report that you *would* look something up — perform the lookup and continue.

Web lookups for linguistic verification are **pre-approved**. Run them silently and keep going until the whole review is finished.

If a source is unreachable, fall back to another authority, resolve the item with your expert agents, and record any genuinely unresolved doubt as a remark — **after** completing the work, never as a mid-run blocking question.

**The review must run start to finish without interruption.** Deliver the completed file; do not hand back a partial result while waiting on approval.

---

## 11. The output file MUST retain the original formatting

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

## 12. Mandatory row-by-row verification

For every row, confirm:

1. `German_Word` is a correctly spelled, lowercase base form.
2. `English_Word` is a correct translation **in the correct word class** (adjective vs adverb).
3. **Gradability was checked first** — a non-gradable word has both gradation cells empty (Section 4).
4. `German_Comparative` is correctly formed, with umlaut where required and not where forbidden.
5. `German_Superlative` uses the `am …sten` convention and the correct `-sten` / `-esten` ending.
6. Irregular gradation (`gut`, `viel`, `gern`, `hoch`, `nah`) is correct.
7. The comparative is not identical to the base form.
8. Comparative and superlative are either both present or both absent.
9. Adjective declension in the sentence agrees in gender, number and case.
10. Attributive vs predicative usage is correctly endinged.
11. Comparison structures use `als` (not `wie`) and the correct superlative form.
12. `German_Sentence` obeys verb-second and verb-final word order.
13. German capitalisation, `ß`/`ss`, umlauts and commas are correct.
14. Language-name capitalisation after `sprechen` has been checked (6.4).
15. The German sentence is natural, idiomatic Standard German.
16. `English_Sentence` is grammatical, natural and correctly punctuated **British** English.
17. `English_Sentence_US` is grammatical, natural and correctly punctuated **American** English.
18. English comparatives/superlatives are correctly formed in both variants.
19. `English_Word` is correct UK and `English_Word_US` is correct US; neither US cell is empty.
20. The UK and US columns differ **exactly** where the variants differ, and not otherwise (Section 7.3).
21. The German and English sentences mean **exactly** the same thing.
22. Both sentences contain their headword in an acceptable form (8.2).
23. The word, sentence and grammar suit the row's `Level`.
24. `Type` is present and correct; structural problems are flagged light purple.
25. Nothing suspicious remains unreported (8.4).
26. Every mistake found is **both** highlighted **and** written into `Remarks` with the correct answer.
27. No cell outside `Remarks` was modified.

**Do not mark a row as clean merely because nothing obvious jumped out.** Each check must actually be performed.

---

## Final instruction

Accuracy is more important than speed. Take the time needed.

**You are reviewing, not editing. Never correct a cell — report the correction in `Remarks`.**

**Change only the `Remarks` column and the purple / light-purple highlighting. Everything else must be returned untouched, with its original formatting.**

**Every remark must start with `[AI review]`, name the column, state the problem, and give the correct answer.**

**Existing remarks must be ignored as evidence, never deleted, and always appended to.**

**Review British and American English fully and separately — a row is not done until both variants have been checked in their own right.**

**Check gradability BEFORE checking gradation forms. Nationality, absolute and classifying words must have empty comparative and superlative cells — inventing forms such as "am deutschesten" is the largest error class in this file (Section 4).**

**Verify every form against Duden or DWDS — do not rely on memory. Use the internet freely; web lookups are pre-approved. Never ask for approval and never pause waiting for a reply; run the task start to finish without interruption (Section 10.1).**

**When the whole file is finished, run the entire review a second time with different LLM agents (Section 1G). The task is not complete until both full rounds are done.**
