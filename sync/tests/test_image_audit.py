"""Tests for the reusable, read-only approved-noun image audit CLI.

Product purpose: reviewers must be able to repeat a complete image audit without
changing production decisions, inspect the exact approved asset, and publish a
traceable report whose findings cannot silently point at the wrong noun.
"""

import csv
import json
import sys
from argparse import Namespace
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

import image_audit


def _manifest_row(index: str, word: str = "Hund", severity_hint: str = "") -> dict[str, str]:
    """Return the minimum complete manifest record used by report tests."""
    row = {field: "" for field in image_audit.MANIFEST_FIELDS}
    row.update(
        {
            "audit_index": index,
            "noun_id": f"id-{index}",
            "level": "A1.1",
            "article": "der",
            "german": word,
            "english": "dog",
            "german_sentence": "Der Hund schläft.",
            "english_sentence": "The dog sleeps.",
            "image_hash": f"hash-{index}",
            "path": f"/tmp/{index}.heic",
            "kind": "photo",
            "source": "generated:test",
            "approved_by": "human",
            "severity_hint": severity_hint,
        }
    )
    return row


def _finding(index: str, severity: str = "high") -> dict[str, str]:
    return {
        "audit_index": index,
        "disposition": "reject",
        "severity": severity,
        "category": "wrong-object",
        "reason": "The image shows a cat.",
        "recommendation": "Use an unmistakable dog.",
    }


def test_legacy_id_matches_the_production_v1_media_identity():
    """Product: the audit must join an approval to the same noun as image delivery."""
    assert image_audit.compute_legacy_id("A1.1", "Hund") == "220bc40d8153b8b4"
    assert image_audit.compute_legacy_id("A1.1", "Hund") == image_audit.compute_legacy_id(
        "a1.1", "hund"
    )


def test_selector_accepts_index_hash_id_exact_word_and_word_fragment():
    """Product: a reviewer can reliably reopen any flagged asset from the report."""
    manifest = [_manifest_row("1", "Hund"), _manifest_row("2", "Hundehütte")]
    manifest[0]["noun_id"] = "noun-one"
    manifest[0]["image_hash"] = "hash-one"

    assert [row["audit_index"] for row in image_audit._select_manifest_rows(manifest, ["#1"])] == ["1"]
    assert [row["audit_index"] for row in image_audit._select_manifest_rows(manifest, ["noun-one"])] == ["1"]
    assert [row["audit_index"] for row in image_audit._select_manifest_rows(manifest, ["hash-one"])] == ["1"]
    assert [row["audit_index"] for row in image_audit._select_manifest_rows(manifest, ["Hund"])] == ["1"]
    assert [row["audit_index"] for row in image_audit._select_manifest_rows(manifest, ["hütte"])] == ["2"]


def test_selector_rejects_unknown_asset():
    """Product: a typo must fail loudly instead of inspecting or reporting another image."""
    with pytest.raises(image_audit.AuditError, match="No manifest item matches"):
        image_audit._select_manifest_rows([_manifest_row("1")], ["Katze"])


def test_validate_findings_joins_and_orders_by_release_severity():
    """Product: release-blocking defects appear before subjective review items."""
    manifest = [_manifest_row("1"), _manifest_row("2", "Katze")]
    joined = image_audit.validate_findings(
        [_finding("1", "medium"), _finding("2", "high")], manifest
    )
    assert [finding["audit_index"] for finding, _ in joined] == ["2", "1"]
    assert [finding["noun"] for finding, _ in joined] == ["der Katze", "der Hund"]


def test_validate_findings_rejects_a_stale_noun_name():
    """Product: a visible noun label cannot silently point at the wrong approved image."""
    finding = _finding("1")
    finding["noun"] = "die Katze"
    with pytest.raises(image_audit.AuditError, match="does not match audit_index"):
        image_audit.validate_findings([finding], [_manifest_row("1")])


@pytest.mark.parametrize(
    ("change", "message"),
    [
        ({"audit_index": "999"}, "unknown audit_index"),
        ({"disposition": "accept"}, "disposition must be one of"),
        ({"severity": "critical"}, "severity must be one of"),
        ({"category": ""}, "category and reason are required"),
    ],
)
def test_validate_findings_rejects_invalid_review_data(change, message):
    """Product: malformed manual findings cannot produce a misleading audit report."""
    finding = _finding("1")
    finding.update(change)
    with pytest.raises(image_audit.AuditError, match=message):
        image_audit.validate_findings([finding], [_manifest_row("1")])


def test_validate_findings_rejects_duplicate_index():
    """Product: each approved image receives one unambiguous final disposition."""
    with pytest.raises(image_audit.AuditError, match="duplicate audit_index"):
        image_audit.validate_findings(
            [_finding("1"), _finding("1", "medium")], [_manifest_row("1")]
        )


def test_report_is_self_contained_and_includes_integrity_results(tmp_path):
    """Product: the retained report explains scope, severity and how to reproduce the audit."""
    image_audit._write_csv(
        tmp_path / "manifest.csv", image_audit.MANIFEST_FIELDS, [_manifest_row("1")]
    )
    image_audit._write_csv(
        tmp_path / "findings.csv", image_audit.FINDING_FIELDS, [_finding("1")]
    )
    (tmp_path / "summary.json").write_text(
        json.dumps(
            {
                "approved": 1,
                "mapped": 1,
                "unmapped": 0,
                "approved_by": {"human": 1},
                "missing_or_decode_errors": 0,
                "hashes_verified": True,
                "hash_errors": 0,
                "duplicate_content_hashes": [],
                "workbook_identity_collisions": 0,
            }
        ),
        encoding="utf-8",
    )
    destination = tmp_path / "report.md"
    result = image_audit.command_report(
        Namespace(
            audit_dir=tmp_path,
            findings=None,
            output=destination,
            title="Test image audit",
            audit_date="2026-07-20",
        )
    )

    report = destination.read_text(encoding="utf-8")
    assert result == 0
    assert "Approved image decisions reviewed: 1" in report
    assert "File content hashes: verified (0 mismatch(es))" in report
    assert "der Hund" in report and "The image shows a cat." in report
    assert "image_audit.py prepare --verify-hashes" in report
    with (tmp_path / "findings.csv").open(newline="", encoding="utf-8") as handle:
        enriched = next(csv.DictReader(handle))
    assert enriched["noun"] == "der Hund"


def test_csv_writer_preserves_commas_and_unicode(tmp_path):
    """Product: German text and explanatory reasons survive the reviewer handoff intact."""
    path = tmp_path / "findings.csv"
    finding = _finding("1")
    finding["reason"] = "Falsch, missverständlich: zeigt Größe statt Größe."
    image_audit._write_csv(path, image_audit.FINDING_FIELDS, [finding])
    with path.open(newline="", encoding="utf-8") as handle:
        restored = next(csv.DictReader(handle))
    assert restored["reason"] == finding["reason"]


def test_parser_exposes_the_complete_reviewer_workflow():
    """Product: preparation, inspection, reporting and orphan recovery remain stable CLI commands."""
    parser = image_audit.build_parser()
    for command in ("prepare", "inspect", "report", "recover-history"):
        assert command in parser._subparsers._group_actions[0].choices
