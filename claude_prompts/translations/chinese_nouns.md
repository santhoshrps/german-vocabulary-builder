# Task: Add Chinese translations to the existing German–English noun file

You are working with a file containing German nouns, English translations, German learning sentences, and existing Chinese translation remarks.

This file is used for a **language-learning project**. Accuracy is therefore critical. **Accuracy is more important than speed.**

Your task is to extend the existing German–English content with **correct, natural Chinese translations**.

---

## 1. Mandatory multi-agent expert workflow

Do **not** complete this task using a single-pass translation approach.

Use a **multi-agent LLM workflow** with multiple independent agents who are experts in the relevant fields.

The workflow must include:

### A. Primary translation agent

A language-learning and translation expert who:

* Understands German at an expert level.
* Understands Chinese at an expert level.
* Understands the needs of language learners at different proficiency levels.
* Produces the initial Chinese translations.

### B. Independent Chinese verification agents

Use **multiple independent verification agents who are experts in Chinese language verification**.

These agents must independently check:

* Chinese word choice.
* Chinese grammar.
* Chinese sentence structure.
* Naturalness and standard Chinese usage.
* Correct use of the `Chinese_Word`.
* Chinese punctuation.
* Whether the Chinese sentence has exactly the same meaning as the German sentence.
* Whether the Chinese is appropriate for the learner level specified in the `Level` column for that row.

**At least some verification agents must specifically be Chinese-language experts or Chinese translation/linguistic verification specialists.**

Do not allow the verification agents to simply approve the primary translation without performing an independent review.

### C. German semantic verification agent

Use an independent German-language expert to verify:

* The meaning of the German noun.
* The meaning of the German sentence.
* The grammatical and contextual meaning of the German source.

The German source must be treated as the primary semantic reference.

### D. Final adjudication agent

If the agents disagree, use a final expert adjudication step.

The adjudication agent must:

1. Review the original German source.
2. Review the `Level` value for the row.
3. Review the English meaning as secondary context only.
4. Review the proposed Chinese translation.
5. Review the verification agents' objections.
6. Decide the correct final Chinese translation based on linguistic evidence, the German source, and the learner level specified in the row.

**Do not resolve disagreements by majority vote alone. Linguistic correctness and the German source have priority.**

---

## 2. Source of truth and translation priority

For every row:

* Use the `article` and `word` columns as the source for the German article and noun.
* Use the `plural` column as additional German grammatical context where relevant.
* Use the `German_Sentence` column as the source sentence.
* Use the `Level` column to determine the **target learner proficiency level for that specific row**.
* Use the English meaning as a **secondary reference only**.
* Review the existing `Chinese_Remarks` column as an important quality-control reference.

**The learner level is row-specific. Always use the `Level` value from the same row.**

Do not assume that all rows have the same learner level.

The existing `Chinese_Remarks` may contain:

* Previously detected translation mistakes.
* Known translation problems.
* Important corrections.
* Recurring error patterns.
* Warnings about word choice, grammar, or meaning.

Treat `Chinese_Remarks` as a **historical error log and warning source**.

**Previously identified mistakes must not be repeated.**

If the English meaning and the German meaning differ, or if there is any uncertainty:

> **The German word and German sentence always have priority over the English translation.**

Do not infer a different meaning from the English translation.

Do not invent missing context or add meanings that are not present in the German source.

---

## 3. Strict file and column-editing restrictions

You are **strictly allowed to edit only these three columns**:

* `Chinese_Word`
* `Chinese_Sentence`
* `Chinese_Remarks`

**Do not change any other column or any existing text outside these three columns.**

Do not:

* Rewrite German text.
* Rewrite English text.
* Correct existing German or English content.
* Reformat the file.
* Reorder rows or columns.
* Rename columns.
* Change cell values outside the three Chinese columns.
* Make stylistic improvements to existing content outside the Chinese columns.

Before editing, identify and preserve the file structure.

After editing, perform a **file integrity check** to confirm that no unauthorized columns, rows, or existing text were changed.

### 3.1 Scope — translate ONLY the rows that are not yet translated

The file contains a mixture of rows that are **already translated** and rows that are **not yet translated**.

* A row counts as **already translated** when `Chinese_Word` and `Chinese_Sentence` are already filled.
* **Translate only the rows whose Chinese translation is missing.**
* **Do not modify an already-translated row in any way** — not its text and not its formatting. Leave those rows exactly as you found them.

**Already-translated rows are present for REFERENCE ONLY.** Use them to:

* Follow the established house style, terminology, and formatting conventions.
* Stay consistent with terminology already chosen for related words.
* **Above all, learn from `Chinese_Remarks`.** Where a reviewer has left a remark on an already-translated row, treat it as a **worked example of a mistake that must not be repeated** in the rows you translate.

Do not re-translate, "improve", or correct a row that is already done — even if you would have chosen different wording — unless that row's instructions explicitly ask for it.

### 3.2 The output file MUST retain the original formatting

Return the file with its **original structure and formatting fully intact**:

* The same sheet(s), with the same names and order.
* The same columns, in the same order, with the same headers and column widths.
* The same rows, in the same order.
* The same fonts, font sizes, colours, borders, alignment, number formats, and cell styles.
* The same file format — do not convert, export, or re-save in a way that strips styling, drops sheets, or flattens the workbook.

Do not add, delete, reorder, rename, hide, merge, or resize any column or row.

**Make no formatting changes at all.** Your output must differ from the input only in the text you add to `Chinese_Word`, `Chinese_Sentence`, and `Chinese_Remarks` on the rows you translate.

---

## 4. Chinese_Word requirements

For each row, provide the correct Chinese translation of the German `word`.

The Chinese translation must:

* Represent the correct meaning of the German word.
* Be appropriate for the learner level specified in the `Level` column of that row.
* Use the most natural and standard Chinese word for the German meaning.
* Respect the context and grammatical meaning of the German noun.
* Not be blindly translated from English.
* Use correct Chinese characters.
* Use correct Unicode encoding.

**The learner level may influence the choice of an appropriate translation or wording, but it must never be used as a reason to change, simplify, or distort the meaning of the German source.**

If multiple Chinese translations are possible, choose the **most standard and natural translation for the given German meaning, context, and row-specific learner level**.

Do not choose a translation merely because it is a literal translation.

---

## 5. Chinese_Sentence requirements

Translate `German_Sentence` into **natural, grammatically correct standard Chinese**.

The Chinese sentence must:

* Have **exactly the same meaning as the German sentence**.
* Preserve the meaning, context, and intent of the German sentence.
* Not add information.
* Not remove information.
* Not change the meaning.
* Use natural Chinese sentence structure and word order.
* Use standard Chinese phrasing.
* Be appropriate for the learner level specified in the `Level` column of that row.
* **Contain the word from the `Chinese_Word` column**, used naturally and correctly — see Section 5.1 for exactly what counts as containing it.
* Use correct Chinese characters and Unicode encoding.
* Use correct Chinese punctuation.

**The semantic meaning of `German_Sentence` and `Chinese_Sentence` MUST be identical.**

### 5.1 How the word must appear in the sentence

The word from `Chinese_Word` **must be present in `Chinese_Sentence`**, but it may appear in a naturally modified form as the sentence requires.

The following are **allowed**, because the word itself is still there:

* Preceded by a measure word / classifier: `书` → `一本书`.
* Preceded by a number, demonstrative, or possessive: `这本书`, `我的书`.
* Modified by an attribute with `的`: `我买的书`.
* Pluralised or collectivised where natural: `朋友` → `朋友们`.
* Occurring as part of a longer compound or set phrase that contains it, where that is the natural way to express the sentence.

The following are **not allowed**:

* Replacing the word with a **synonym** or a different word.
* Replacing it with a **pronoun** (`它`, `他`) so that the word never actually appears.
* Dropping the word entirely because it is implied by context.
* Using only **part** of a multi-character word (e.g. writing `书` when `Chinese_Word` is `图书馆`).

In short: the noun may carry classifiers, modifiers, or plural markers, and may sit inside a larger phrase — **but the characters of `Chinese_Word` must actually occur in the sentence.**

Do not perform a word-for-word translation if that would produce unnatural Chinese.

At the same time, do not paraphrase so freely that the meaning changes.

**The learner level may influence vocabulary and phrasing choices, but it must never override the requirement to preserve the exact meaning of the German sentence.**

---

## 6. Chinese language quality requirements

Every Chinese translation must be checked by Chinese-language verification agents for:

* Semantic accuracy.
* Correct Chinese characters.
* Correct word choice.
* Correct grammar.
* Natural Chinese sentence structure.
* Standard Chinese usage.
* Correct use of `Chinese_Word`.
* Correct punctuation.
* Correct Unicode encoding.
* Appropriateness for the learner level specified in the row's `Level` column.

The Chinese must sound like **natural standard Chinese written by a competent Chinese language expert**.

**Do not accept a translation merely because it is understandable or technically possible.**

Reject and revise translations that are:

* Awkward.
* Literal but unnatural.
* Grammatically questionable.
* Semantically incomplete.
* Inappropriate for the learner level specified in the row.
* Influenced by the English meaning when the German meaning is different.

---

## 7. Mandatory review of existing Chinese_Remarks

Before translating or validating each row, review the existing `Chinese_Remarks`.

Use the remarks to:

* Identify previous translation mistakes.
* Detect recurring error patterns.
* Understand known problems with word choice.
* Understand known grammar or sentence-structure problems.
* Avoid repeating the same or similar mistakes.

**Do not assume that an existing translation is correct merely because it already exists in the file.**

The existing remarks are a warning and quality-control source, not an automatic source of truth.

Existing `Chinese_Remarks` may be reviewed and used as reference.

**Do not delete or alter existing remarks unless a change is necessary within the permitted Chinese columns.**

---

## 8. Mandatory row-by-row verification

For every row, the multi-agent workflow must verify all of the following:

1. The German `word` was correctly understood.
2. The German article and grammatical context were considered where relevant.
3. The German sentence was correctly understood.
4. The row-specific `Level` value was reviewed and correctly applied.
5. The existing `Chinese_Remarks` were reviewed.
6. Previously identified mistakes were not repeated.
7. The English meaning was used only as secondary context.
8. The German source was prioritized in any conflict or ambiguity.
9. `Chinese_Word` is the correct Chinese translation.
10. `Chinese_Sentence` has exactly the same meaning as `German_Sentence`.
11. `Chinese_Sentence` contains `Chinese_Word` — classifiers, modifiers and plural markers are fine, but the characters themselves must appear (Section 5.1).
12. `Chinese_Word` is used naturally and correctly in the sentence.
13. Chinese grammar and word order are correct.
14. The Chinese is natural standard Chinese.
15. The Chinese is appropriate for the row-specific learner level in `Level`.
16. Chinese punctuation is correct.
17. Unicode encoding and Chinese characters are correct.
18. No unnecessary meaning or information was added.
19. No meaning or information from the German sentence was omitted.
20. No unauthorized file content was changed.
21. The row was **not already translated** — already-translated rows were left completely untouched (Section 3.1).
22. The original file formatting was preserved exactly; no formatting change of any kind was made (Section 3.2).

**A translation must not be approved merely because it looks plausible.**

---

## 9. Final independent verification

After all translations have been completed:

1. Review the entire file again row by row.
2. Perform an independent German-to-Chinese semantic comparison.
3. Perform an independent Chinese-language grammar and naturalness review.
4. Re-check every `Chinese_Word` against its German `word`.
5. Re-check every `Chinese_Sentence` against its `German_Sentence`.
6. Re-check that every `Chinese_Sentence` actually contains its `Chinese_Word` (Section 5.1).
7. Re-check the row-specific `Level` value.
8. Re-check the existing `Chinese_Remarks` for previously identified mistakes.
9. Confirm that no known mistake has been repeated.
10. Confirm that no already-translated row was modified.
11. Confirm the original formatting is fully preserved.
12. Perform a final file integrity check.

The final verification must include **Chinese-language expert LLM agents specifically focused on Chinese translation and linguistic correctness**.

If any agent identifies a possible issue, investigate it before finalizing.

---

## 10. External verification

If there is any uncertainty about a Chinese word, phrase, grammar point, or standard usage, use reliable linguistic references, standard dictionaries, or reputable translation resources to double-check the issue.

External references may be used to resolve linguistic uncertainty.

However, the **German source remains the primary semantic authority** whenever the English meaning conflicts with the German meaning.

---

## Final instruction

Accuracy is more important than speed.

Use a **multi-agent expert translation and verification workflow**.

**Do not change any existing content outside `Chinese_Word`, `Chinese_Sentence`, and `Chinese_Remarks`.**

**Translate ONLY rows that are not yet translated. Already-translated rows are reference material — especially their `Chinese_Remarks` — and must be left completely unchanged (Section 3.1).**

**The output file MUST retain the original formatting exactly; make no formatting changes at all (Section 3.2).**

Only provide correct Chinese translations and necessary Chinese remarks.

**The `Level` column is the authoritative source for the target learner level of each individual row. Do not assume a fixed level for the entire file.**

**Existing `Chinese_Remarks` must be actively reviewed as a historical error log so that previously identified mistakes and recurring translation errors are not repeated.**

**The final output must be independently verified by multiple agents, including Chinese-language experts specifically responsible for Chinese translation and linguistic verification.**
