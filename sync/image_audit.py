"""Audit the approved noun-image catalogue without changing production data.

This tool is deliberately read-only with respect to ``nouns.xlsx``,
``image_decisions.json`` and ``image_cache``.  It creates an audit workspace
containing a manifest, structural checks, contact sheets and a findings
template.  Reviewers can then export individual candidates at full resolution
and turn the completed CSV into a Markdown report.

Typical workflow::

    python image_audit.py prepare --output image_review/audit
    python image_audit.py inspect 71 263 3692 --audit-dir image_review/audit
    # Fill in image_review/audit/findings.csv
    python image_audit.py report --audit-dir image_review/audit

Historical orphan decisions can be identified from earlier committed versions
of the workbook::

    python image_audit.py recover-history --audit-dir image_review/audit

The default audit directory is under ``image_review/``, which is ignored by
Git because contact sheets and JPEG inspection copies are generated artifacts.
The CLI itself is retained in the repository so the audit is reproducible.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path
from typing import Any, Iterable, Sequence


SYNC_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SYNC_DIR.parent
TOOL_VERSION = "1.0.0"
DEFAULT_WORKBOOK = PROJECT_ROOT / "data" / "nouns.xlsx"
DEFAULT_DECISIONS = SYNC_DIR / "image_decisions.json"
DEFAULT_CACHE = SYNC_DIR / "image_cache"
DEFAULT_AUDIT_DIR = SYNC_DIR / "image_review" / "audit"

MANIFEST_FIELDS = [
    "audit_index",
    "noun_id",
    "row",
    "level",
    "article",
    "german",
    "english",
    "german_sentence",
    "english_sentence",
    "image_hash",
    "kind",
    "source",
    "approved_by",
    "updated",
    "width",
    "height",
    "path",
    "decode_error",
    "hash_error",
    "duplicate_workbook_rows",
]

FINDING_FIELDS = [
    "audit_index",
    "noun",
    "disposition",
    "severity",
    "category",
    "reason",
    "recommendation",
]

REQUIRED_FINDING_FIELDS = [field for field in FINDING_FIELDS if field != "noun"]

ALLOWED_DISPOSITIONS = {"reject", "review", "data-error"}
ALLOWED_SEVERITIES = {"high", "medium", "low"}


class AuditError(RuntimeError):
    """A user-actionable audit input or consistency error."""


def _dependencies():
    """Load optional image/workbook dependencies only for commands needing them."""
    try:
        import openpyxl  # type: ignore
        from PIL import Image, ImageDraw, ImageFont, ImageOps  # type: ignore
        from pillow_heif import register_heif_opener  # type: ignore
    except ImportError as exc:  # pragma: no cover - depends on local environment
        raise AuditError(
            "Missing audit dependencies. Run this with sync/.venv/bin/python or "
            "install the packages from sync/requirements.txt."
        ) from exc
    register_heif_opener()
    return openpyxl, Image, ImageDraw, ImageFont, ImageOps


def clean(value: Any) -> str:
    """Normalise spreadsheet text while keeping the manifest CSV deterministic."""
    if value is None:
        return ""
    return str(value).replace("\xa0", " ").strip()


def compute_legacy_id(level: str, word: str) -> str:
    """Return the v1 media ID still used by the image decision store."""
    payload = f"{level.lower()}|{word.lower()}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:16]


def workbook_rows(workbook: Path | io.BytesIO) -> dict[str, list[dict[str, Any]]]:
    """Map legacy media IDs to workbook rows, retaining identity collisions."""
    openpyxl, *_ = _dependencies()
    book = openpyxl.load_workbook(workbook, read_only=True, data_only=True)
    sheet = book.active
    iterator = sheet.iter_rows(values_only=True)
    try:
        headers = [clean(value) for value in next(iterator)]
    except StopIteration as exc:
        book.close()
        raise AuditError("The noun workbook is empty.") from exc

    required = {
        "Level",
        "German_Word",
        "English_Word",
        "German_Sentence",
        "English_Sentence",
    }
    missing = sorted(required.difference(headers))
    if missing:
        book.close()
        raise AuditError(f"Workbook is missing required column(s): {', '.join(missing)}")

    columns = {header: index for index, header in enumerate(headers) if header}
    rows: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row_number, raw in enumerate(iterator, start=2):
        level = clean(raw[columns["Level"]])
        word = clean(raw[columns["German_Word"]])
        if not level or not word:
            continue
        noun_id = compute_legacy_id(level, word)
        article_index = columns.get("German_Article")
        rows[noun_id].append(
            {
                "row": row_number,
                "level": level,
                "article": clean(raw[article_index]) if article_index is not None else "",
                "german": word,
                "english": clean(raw[columns["English_Word"]]),
                "german_sentence": clean(raw[columns["German_Sentence"]]),
                "english_sentence": clean(raw[columns["English_Sentence"]]),
            }
        )
    book.close()
    return rows


def _load_decisions(path: Path) -> dict[str, dict[str, Any]]:
    try:
        value = json.loads(path.read_text("utf-8"))
    except FileNotFoundError as exc:
        raise AuditError(f"Decision store not found: {path}") from exc
    except json.JSONDecodeError as exc:
        raise AuditError(f"Decision store is invalid JSON: {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise AuditError("Decision store root must be a JSON object.")
    return value


def _file_sha256(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(chunk_size), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_manifest(
    *,
    workbook: Path,
    decisions_path: Path,
    cache_dir: Path,
    verify_hashes: bool = False,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Build the approved-image manifest and structural audit summary."""
    _, Image, *_ = _dependencies()
    decisions = _load_decisions(decisions_path)
    rows = workbook_rows(workbook)
    approved = {
        noun_id: record
        for noun_id, record in decisions.items()
        if record.get("status") == "approved"
    }

    dimensions: Counter[str] = Counter()
    content_hashes: Counter[str] = Counter()
    manifest: list[dict[str, Any]] = []
    for noun_id, record in approved.items():
        choices = rows.get(noun_id, [])
        row = choices[0] if choices else {
            "row": "",
            "level": "",
            "article": "",
            "german": "[unmapped]",
            "english": "",
            "german_sentence": "",
            "english_sentence": "",
        }
        image_hash = clean(record.get("content_hash"))
        content_hashes[image_hash] += 1
        path = cache_dir / f"{image_hash}.heic"
        item: dict[str, Any] = {
            "noun_id": noun_id,
            **row,
            "duplicate_workbook_rows": [choice["row"] for choice in choices[1:]],
            "image_hash": image_hash,
            "path": str(path.resolve()),
            "kind": clean(record.get("kind")),
            "source": clean(record.get("source")),
            "approved_by": clean(record.get("approved_by")),
            "updated": clean(record.get("updated")),
            "width": "",
            "height": "",
            "decode_error": "",
            "hash_error": "",
        }
        if not image_hash:
            item["decode_error"] = "decision has no content_hash"
        elif not path.exists():
            item["decode_error"] = "missing file"
        else:
            try:
                with Image.open(path) as image:
                    item["width"], item["height"] = image.size
                    dimensions[f"{image.width}x{image.height}"] += 1
            except Exception as exc:  # noqa: BLE001 - report every bad media file
                item["decode_error"] = f"{type(exc).__name__}: {exc}"
            if verify_hashes:
                actual_hash = _file_sha256(path)
                if actual_hash != image_hash:
                    item["hash_error"] = f"expected {image_hash}, got {actual_hash}"
        manifest.append(item)

    manifest.sort(key=lambda item: (item["german"].casefold(), item["level"], item["noun_id"]))
    for audit_index, item in enumerate(manifest, start=1):
        item["audit_index"] = audit_index

    status_counts = Counter(clean(record.get("status")) for record in decisions.values())
    approver_counts = Counter(clean(record.get("approved_by")) for record in approved.values())
    duplicate_hashes = sorted(
        image_hash for image_hash, count in content_hashes.items() if image_hash and count > 1
    )
    summary = {
        "generated_on": date.today().isoformat(),
        "decision_counts": dict(sorted(status_counts.items())),
        "approved": len(approved),
        "mapped": sum(item["german"] != "[unmapped]" for item in manifest),
        "unmapped": sum(item["german"] == "[unmapped]" for item in manifest),
        "approved_by": dict(sorted(approver_counts.items())),
        "missing_or_decode_errors": sum(bool(item["decode_error"]) for item in manifest),
        "hash_errors": sum(bool(item["hash_error"]) for item in manifest),
        "dimensions": dict(sorted(dimensions.items())),
        "duplicate_content_hashes": duplicate_hashes,
        "workbook_identity_collisions": sum(
            bool(item["duplicate_workbook_rows"]) for item in manifest
        ),
        "hashes_verified": verify_hashes,
    }
    return manifest, summary


def _write_csv(path: Path, fields: Sequence[str], rows: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def _font(ImageFont, size: int):
    candidates = (
        "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Supplemental/Arial Unicode.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    )
    for candidate in candidates:
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    return ImageFont.load_default()


def _fit_lines(draw, text: str, width: int, font_object, max_lines: int = 2) -> list[str]:
    words = text.split()
    lines: list[str] = []
    current = ""
    consumed = 0
    for word in words:
        proposed = word if not current else f"{current} {word}"
        if draw.textlength(proposed, font=font_object) <= width:
            current = proposed
            consumed += 1
            continue
        if current:
            lines.append(current)
        current = word
        consumed += 1
        if len(lines) == max_lines - 1:
            break
    if current and len(lines) < max_lines:
        remainder = " ".join(words[consumed - len(current.split()):])
        current = remainder
        while current and draw.textlength(current, font=font_object) > width:
            current = current[:-1]
        if current != remainder:
            current = current.rstrip() + "…"
        lines.append(current)
    return lines


def create_contact_sheets(
    manifest: Sequence[dict[str, Any]],
    sheets_dir: Path,
    *,
    columns: int,
    rows: int,
    tile_width: int,
    image_height: int,
    label_height: int,
    quality: int,
) -> int:
    """Render compact, numbered contact sheets in manifest order."""
    _, Image, ImageDraw, ImageFont, ImageOps = _dependencies()
    sheets_dir.mkdir(parents=True, exist_ok=True)
    main_font = _font(ImageFont, max(14, tile_width // 16))
    small_font = _font(ImageFont, max(12, tile_width // 20))
    index_font = _font(ImageFont, max(11, tile_width // 22))
    per_sheet = columns * rows
    count = math.ceil(len(manifest) / per_sheet)
    sheet_width = columns * tile_width
    tile_height = image_height + label_height
    for sheet_number in range(count):
        sheet = Image.new("RGB", (sheet_width, rows * tile_height), "#ececec")
        draw = ImageDraw.Draw(sheet)
        batch = manifest[sheet_number * per_sheet:(sheet_number + 1) * per_sheet]
        for position, item in enumerate(batch):
            column = position % columns
            row = position // columns
            x = column * tile_width
            y = row * tile_height
            draw.rectangle((x, y, x + tile_width - 1, y + tile_height - 1), outline="#555", width=2)
            try:
                with Image.open(item["path"]) as source:
                    source = ImageOps.exif_transpose(source).convert("RGB")
                    fitted = ImageOps.contain(
                        source,
                        (tile_width - 8, image_height - 8),
                        Image.Resampling.LANCZOS,
                    )
                    sheet.paste(
                        fitted,
                        (x + (tile_width - fitted.width) // 2, y + (image_height - fitted.height) // 2),
                    )
            except Exception:  # noqa: BLE001 - the red tile is the audit result
                draw.rectangle(
                    (x + 4, y + 4, x + tile_width - 4, y + image_height - 4),
                    fill="#7c1f1f",
                )
                draw.text((x + 14, y + image_height // 2), "MISSING / DECODE ERROR", fill="white", font=small_font)

            label_y = y + image_height + 4
            article_word = " ".join(part for part in (item["article"], item["german"]) if part)
            draw.text(
                (x + 8, label_y),
                f"#{int(item['audit_index']):04d}  {article_word}",
                fill="#111",
                font=main_font,
            )
            for line_number, line in enumerate(
                _fit_lines(draw, item["english"], tile_width - 16, small_font, 2)
            ):
                draw.text(
                    (x + 8, label_y + main_font.size + 7 + line_number * (small_font.size + 4)),
                    line,
                    fill="#1f4f78",
                    font=small_font,
                )
            draw.text(
                (x + tile_width - 76, y + 8),
                item["level"],
                fill="#111",
                stroke_width=3,
                stroke_fill="white",
                font=index_font,
            )
        sheet.save(sheets_dir / f"sheet_{sheet_number + 1:03d}.jpg", quality=quality, subsampling=0)
        if (sheet_number + 1) % 20 == 0 or sheet_number + 1 == count:
            print(f"contact sheets: {sheet_number + 1}/{count}", flush=True)
    return count


def read_manifest(path: Path) -> list[dict[str, str]]:
    try:
        with path.open(newline="", encoding="utf-8") as handle:
            return list(csv.DictReader(handle))
    except FileNotFoundError as exc:
        raise AuditError(f"Manifest not found: {path}. Run the prepare command first.") from exc


def _select_manifest_rows(
    manifest: Sequence[dict[str, str]], selectors: Sequence[str]
) -> list[dict[str, str]]:
    selected: list[dict[str, str]] = []
    seen: set[str] = set()
    for raw_selector in selectors:
        selector = raw_selector.removeprefix("#").strip()
        exact = [
            row
            for row in manifest
            if selector in {row["audit_index"], row["noun_id"], row["image_hash"]}
            or selector.casefold() == row["german"].casefold()
        ]
        matches = exact or [
            row for row in manifest if selector.casefold() in row["german"].casefold()
        ]
        if not matches:
            raise AuditError(f"No manifest item matches selector {raw_selector!r}.")
        for row in matches:
            if row["audit_index"] not in seen:
                seen.add(row["audit_index"])
                selected.append(row)
    return selected


def command_prepare(args: argparse.Namespace) -> int:
    output = args.output.resolve()
    manifest, summary = build_manifest(
        workbook=args.workbook.resolve(),
        decisions_path=args.decisions.resolve(),
        cache_dir=args.cache.resolve(),
        verify_hashes=args.verify_hashes,
    )
    output.mkdir(parents=True, exist_ok=True)
    _write_csv(output / "manifest.csv", MANIFEST_FIELDS, manifest)
    (output / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", "utf-8"
    )
    findings_path = output / "findings.csv"
    if not findings_path.exists():
        _write_csv(findings_path, FINDING_FIELDS, [])
    if not args.no_contact_sheets:
        summary["contact_sheets"] = create_contact_sheets(
            manifest,
            output / "sheets",
            columns=args.columns,
            rows=args.rows,
            tile_width=args.tile_width,
            image_height=args.image_height,
            label_height=args.label_height,
            quality=args.jpeg_quality,
        )
    else:
        summary["contact_sheets"] = 0
    (output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n", "utf-8")
    print(json.dumps(summary, indent=2))
    print(f"Audit workspace: {output}")
    return 0


def command_inspect(args: argparse.Namespace) -> int:
    _, Image, _, _, ImageOps = _dependencies()
    audit_dir = args.audit_dir.resolve()
    manifest = read_manifest(audit_dir / "manifest.csv")
    rows = _select_manifest_rows(manifest, args.selectors)
    if args.metadata_only:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return 0
    output = (args.output or audit_dir / "inspection").resolve()
    output.mkdir(parents=True, exist_ok=True)
    for row in rows:
        source_path = Path(row["path"])
        if not source_path.exists():
            print(f"skip missing #{row['audit_index']}: {source_path}", file=sys.stderr)
            continue
        safe_word = "".join(character if character.isalnum() or character in "-_" else "_" for character in row["german"])
        destination = output / f"{int(row['audit_index']):04d}_{safe_word}_{row['image_hash'][:12]}.jpg"
        with Image.open(source_path) as image:
            image = ImageOps.exif_transpose(image).convert("RGB")
            image.save(destination, quality=args.jpeg_quality, subsampling=0)
        print(f"#{row['audit_index']} {row['article']} {row['german']} -> {destination}")
        print(f"  {row['german_sentence']}")
        print(f"  {row['english_sentence']}")
    return 0


def _read_findings(path: Path) -> list[dict[str, str]]:
    try:
        with path.open(newline="", encoding="utf-8") as handle:
            reader = csv.DictReader(handle)
            missing = [
                field for field in REQUIRED_FINDING_FIELDS if field not in (reader.fieldnames or [])
            ]
            if missing:
                raise AuditError(f"Findings CSV is missing column(s): {', '.join(missing)}")
            rows = [
                {key: clean(value) for key, value in row.items()}
                for row in reader
                if any(clean(value) for value in row.values())
            ]
    except FileNotFoundError as exc:
        raise AuditError(f"Findings CSV not found: {path}") from exc
    return rows


def validate_findings(
    findings: Sequence[dict[str, str]], manifest: Sequence[dict[str, str]]
) -> list[tuple[dict[str, str], dict[str, str]]]:
    """Validate findings and join them to their manifest records."""
    by_index = {row["audit_index"]: row for row in manifest}
    joined: list[tuple[dict[str, str], dict[str, str]]] = []
    seen: set[str] = set()
    for line_number, finding in enumerate(findings, start=2):
        index = finding["audit_index"].removeprefix("#")
        if index not in by_index:
            raise AuditError(f"Findings line {line_number}: unknown audit_index {index!r}.")
        if index in seen:
            raise AuditError(f"Findings line {line_number}: duplicate audit_index {index}.")
        seen.add(index)
        disposition = finding["disposition"].lower()
        severity = finding["severity"].lower()
        if disposition not in ALLOWED_DISPOSITIONS:
            raise AuditError(
                f"Findings line {line_number}: disposition must be one of "
                f"{', '.join(sorted(ALLOWED_DISPOSITIONS))}."
            )
        if severity not in ALLOWED_SEVERITIES:
            raise AuditError(
                f"Findings line {line_number}: severity must be one of "
                f"{', '.join(sorted(ALLOWED_SEVERITIES))}."
            )
        if not finding["category"] or not finding["reason"]:
            raise AuditError(f"Findings line {line_number}: category and reason are required.")
        finding = dict(finding)
        finding["audit_index"] = index
        noun = " ".join(
            value for value in (by_index[index]["article"], by_index[index]["german"]) if value
        )
        supplied_noun = finding.get("noun", "")
        if supplied_noun and supplied_noun != noun:
            raise AuditError(
                f"Findings line {line_number}: noun {supplied_noun!r} does not match "
                f"audit_index {index} ({noun!r})."
            )
        finding["noun"] = noun
        finding["disposition"] = disposition
        finding["severity"] = severity
        joined.append((finding, by_index[index]))
    joined.sort(key=lambda pair: ("high medium low".split().index(pair[0]["severity"]), int(pair[0]["audit_index"])))
    return joined


def _escape_table(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", " ")


def command_report(args: argparse.Namespace) -> int:
    audit_dir = args.audit_dir.resolve()
    manifest = read_manifest(audit_dir / "manifest.csv")
    findings_path = (args.findings or audit_dir / "findings.csv").resolve()
    joined = validate_findings(_read_findings(findings_path), manifest)
    _write_csv(
        findings_path,
        FINDING_FIELDS,
        [
            finding
            for finding, _ in sorted(joined, key=lambda pair: int(pair[0]["audit_index"]))
        ],
    )
    summary_path = audit_dir / "summary.json"
    summary = json.loads(summary_path.read_text("utf-8")) if summary_path.exists() else {}
    counts = Counter(finding["severity"] for finding, _ in joined)
    dispositions = Counter(finding["disposition"] for finding, _ in joined)
    output = (args.output or audit_dir / "image_audit_report.md").resolve()
    approvers = summary.get("approved_by", {})
    approver_text = ", ".join(
        f"{name or '[blank]'}: {count}" for name, count in approvers.items()
    ) or "unknown"
    hash_status = (
        f"verified ({summary.get('hash_errors', 0)} mismatch(es))"
        if summary.get("hashes_verified")
        else "not verified in this run"
    )

    lines = [
        f"# {args.title}",
        "",
        f"Audit date: {args.audit_date}",
        "",
        "## Scope and result",
        "",
        f"- Approved image decisions reviewed: {summary.get('approved', len(manifest)):,}",
        f"- Mapped to the current noun workbook: {summary.get('mapped', 'unknown')}",
        f"- Unmapped approved decisions: {summary.get('unmapped', 'unknown')}",
        f"- Findings: {len(joined)} (high {counts['high']}, medium {counts['medium']}, low {counts['low']})",
        f"- Recommended reject/data correction: {dispositions['reject'] + dispositions['data-error']}",
        f"- Needs human/content review: {dispositions['review']}",
        f"- Approval provenance: {approver_text}",
        f"- Missing or undecodable approved files: {summary.get('missing_or_decode_errors', 'unknown')}",
        f"- File content hashes: {hash_status}",
        f"- Duplicate approved content hashes: {len(summary.get('duplicate_content_hashes', []))}",
        f"- Legacy workbook identity collisions affecting approved records: {summary.get('workbook_identity_collisions', 'unknown')}",
        "",
        "The audit is a visual and semantic review of the approved noun-image set. "
        "A finding means the image is incorrect, misleading, materially ambiguous, "
        "contains a generation artifact, or cannot be tied to the current workbook. "
        "It does not mean every abstract noun must have a literal photograph.",
        "",
        "Disposition meanings: **reject** is a clear visual/content defect; "
        "**data-error** must be corrected in the catalogue or decision mapping; "
        "**review** is materially ambiguous or pedagogically weak and should receive "
        "a content-reviewer decision before release.",
        "",
        "## Method",
        "",
        "1. Joined every approved decision to the current noun workbook using the legacy media ID.",
        "2. Checked file presence, decodeability, dimensions, uniqueness and (when requested) SHA-256 content hashes.",
        "3. Reviewed numbered contact sheets for the complete approved set.",
        "4. Re-opened ambiguous candidates at full resolution and compared them with the exact noun sense and example sentence.",
        "5. Recorded only images that are wrong, misleading, materially ambiguous, contain generation artifacts, or cannot be safely mapped.",
        "",
        "Limitations: this is a visual/content audit, not legal advice or a factual provenance audit. "
        "Generated landmark and extinct-species images are flagged when their identity cannot be established visually. "
        "The nine orphaned approvals cannot be semantically reviewed until their noun/sense mapping is recovered.",
        "",
        "## Findings",
        "",
        "| # | Noun | Meaning | Level | Severity | Action | Category | Reason | Recommended replacement | Hash |",
        "|---:|---|---|---|---|---|---|---|---|---|",
    ]
    for finding, item in joined:
        noun = " ".join(value for value in (item["article"], item["german"]) if value)
        lines.append(
            "| "
            + " | ".join(
                _escape_table(value)
                for value in (
                    finding["audit_index"],
                    noun,
                    item["english"],
                    item["level"],
                    finding["severity"],
                    finding["disposition"],
                    finding["category"],
                    finding["reason"],
                    finding["recommendation"] or "Replace with an unambiguous image matching the example sentence.",
                    item["image_hash"],
                )
            )
            + " |"
        )
    lines.extend(
        [
            "",
            "## Reproduction",
            "",
            "```bash",
            "cd sync",
            ".venv/bin/python image_audit.py prepare --verify-hashes",
            ".venv/bin/python image_audit.py inspect 71 263 3692",
            ".venv/bin/python image_audit.py report --findings ../reports/image_audit_findings_2026-07-20.csv \\",
            "  --output ../reports/image_audit_approved_nouns_2026-07-20.md",
            "```",
            "",
        ]
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(lines), "utf-8")
    print(f"Wrote {output} ({len(joined)} findings)")
    return 0


def _git(args: Sequence[str], *, cwd: Path) -> bytes:
    try:
        return subprocess.check_output(["git", *args], cwd=cwd, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.CalledProcessError) as exc:
        raise AuditError(f"Git command failed: git {' '.join(args)}") from exc


def command_recover_history(args: argparse.Namespace) -> int:
    """Find the most recent historical workbook row for current orphan IDs."""
    audit_dir = args.audit_dir.resolve()
    manifest = read_manifest(audit_dir / "manifest.csv")
    orphans = {row["noun_id"]: row for row in manifest if row["german"] == "[unmapped]"}
    if not orphans:
        print("No unmapped approved decisions.")
        return 0
    try:
        relative_workbook = args.workbook.resolve().relative_to(PROJECT_ROOT.resolve()).as_posix()
    except ValueError as exc:
        raise AuditError("Historical recovery requires a workbook inside the project repository.") from exc
    commits = _git(["log", "--format=%H", "--", relative_workbook], cwd=PROJECT_ROOT).decode().splitlines()
    recovered: dict[str, dict[str, Any]] = {}
    for position, commit in enumerate(commits, start=1):
        try:
            workbook_bytes = _git(["show", f"{commit}:{relative_workbook}"], cwd=PROJECT_ROOT)
            historical_rows = workbook_rows(io.BytesIO(workbook_bytes))
        except AuditError:
            continue
        for noun_id in set(orphans).difference(recovered):
            choices = historical_rows.get(noun_id)
            if choices:
                commit_date = _git(["show", "-s", "--format=%cs", commit], cwd=PROJECT_ROOT).decode().strip()
                recovered[noun_id] = {
                    "noun_id": noun_id,
                    "audit_index": orphans[noun_id]["audit_index"],
                    **choices[0],
                    "commit": commit,
                    "commit_date": commit_date,
                }
        if len(recovered) == len(orphans):
            break
        if position % 25 == 0:
            print(f"history: checked {position}/{len(commits)} commits", file=sys.stderr)
    rows = sorted(recovered.values(), key=lambda row: int(row["audit_index"]))
    unresolved = sorted(set(orphans).difference(recovered))
    payload = {
        "history_commits_checked": len(commits),
        "recovered": rows,
        "unresolved_noun_ids": unresolved,
    }
    if args.output:
        destination = args.output.resolve()
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", "utf-8")
        print(f"Wrote {destination}")
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 1 if unresolved else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Prepare, inspect and report a read-only audit of approved noun images.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {TOOL_VERSION}")
    subparsers = parser.add_subparsers(dest="command", required=True)

    prepare = subparsers.add_parser("prepare", help="validate approved images and make contact sheets")
    prepare.add_argument("--workbook", type=Path, default=DEFAULT_WORKBOOK)
    prepare.add_argument("--decisions", type=Path, default=DEFAULT_DECISIONS)
    prepare.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    prepare.add_argument("--output", type=Path, default=DEFAULT_AUDIT_DIR)
    prepare.add_argument("--verify-hashes", action="store_true", help="SHA-256 every approved HEIC")
    prepare.add_argument("--no-contact-sheets", action="store_true")
    prepare.add_argument("--columns", type=int, default=6)
    prepare.add_argument("--rows", type=int, default=6)
    prepare.add_argument("--tile-width", type=int, default=360)
    prepare.add_argument("--image-height", type=int, default=300)
    prepare.add_argument("--label-height", type=int, default=92)
    prepare.add_argument("--jpeg-quality", type=int, choices=range(50, 101), default=91, metavar="50..100")
    prepare.set_defaults(func=command_prepare)

    inspect = subparsers.add_parser("inspect", help="export selected HEIC files as full-size JPEGs")
    inspect.add_argument("selectors", nargs="+", help="audit index, noun ID, image hash or German noun")
    inspect.add_argument("--audit-dir", type=Path, default=DEFAULT_AUDIT_DIR)
    inspect.add_argument("--output", type=Path)
    inspect.add_argument("--metadata-only", action="store_true")
    inspect.add_argument("--jpeg-quality", type=int, choices=range(50, 101), default=95, metavar="50..100")
    inspect.set_defaults(func=command_inspect)

    report = subparsers.add_parser("report", help="validate findings.csv and render a Markdown report")
    report.add_argument("--audit-dir", type=Path, default=DEFAULT_AUDIT_DIR)
    report.add_argument("--findings", type=Path)
    report.add_argument("--output", type=Path)
    report.add_argument("--title", default="Approved noun image audit")
    report.add_argument("--audit-date", default=date.today().isoformat())
    report.set_defaults(func=command_report)

    history = subparsers.add_parser("recover-history", help="map orphan decisions using workbook Git history")
    history.add_argument("--audit-dir", type=Path, default=DEFAULT_AUDIT_DIR)
    history.add_argument("--workbook", type=Path, default=DEFAULT_WORKBOOK)
    history.add_argument("--output", type=Path)
    history.set_defaults(func=command_recover_history)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    numeric_fields = ("columns", "rows", "tile_width", "image_height", "label_height")
    for field in numeric_fields:
        if hasattr(args, field) and getattr(args, field) <= 0:
            parser.error(f"--{field.replace('_', '-')} must be greater than zero")
    try:
        return int(args.func(args))
    except AuditError as exc:
        parser.error(str(exc))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
