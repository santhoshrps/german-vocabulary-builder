"""Extended release contracts for stable identity, language metadata, and media packs.

These tests intentionally exercise small pure functions rather than the deployment surface. That
makes the content artefacts reproducible and gives the iOS client a stable protocol to consume.
"""

import hashlib
import json
import re
import struct
import unicodedata

import media_delivery
import registry


def _members():
    return [("word-b", "hash-b", b"BB"), ("word-a", "hash-a", b"A")]


def _unpack(data):
    header_length = struct.unpack(">I", data[:4])[0]
    header_end = 4 + header_length
    return json.loads(data[4:header_end]), data[header_end:]


def test_identity_normalization_composes_unicode_before_hashing():
    """Product purpose: canonically equivalent German spelling keeps learner progress."""
    decomposed = "Gru\u0308n"
    assert decomposed != unicodedata.normalize("NFC", decomposed)
    assert registry.normalize_for_id(decomposed) == registry.normalize_for_id("Gr\u00fcn")


def test_identity_normalization_collapses_spaces_and_nonbreaking_spaces():
    """Product purpose: harmless spreadsheet whitespace must not create a second word."""
    assert registry.normalize_for_id("  Guten\u00a0  Morgen  ") == "guten morgen"


def test_identity_preserves_semantically_distinct_umlauts():
    """Product purpose: distinct German spellings such as schon/sch\u00f6n never share progress."""
    assert registry.compute_word_id("adjective", "schon") != registry.compute_word_id("adjective", "sch\u00f6n")


def test_word_type_is_part_of_stable_identity():
    """Product purpose: a spelling used as different parts of speech receives separate cards."""
    assert registry.compute_word_id("verb", "reisen") != registry.compute_word_id("noun", "Reisen")


def test_noun_article_is_part_of_stable_identity():
    """Product purpose: same-spelling nouns with different grammatical gender stay distinct."""
    assert registry.compute_word_id("noun", "See", "der") != registry.compute_word_id("noun", "See", "die")


def test_sense_is_part_of_stable_identity():
    """Product purpose: homonyms must use different sense values and retain separate progress."""
    assert registry.compute_word_id("noun", "Bank", "die", "bench") != registry.compute_word_id(
        "noun", "Bank", "die", "finance"
    )


def test_word_ids_are_lowercase_sixteen_character_hex():
    """Product purpose: every platform can store and compare compact word identifiers consistently."""
    assert re.fullmatch(r"[0-9a-f]{16}", registry.compute_word_id("verb", "lernen"))


def test_language_registry_contains_exactly_the_launch_languages():
    """Product purpose: app content supports UK/US English, three Spanish variants, and Mandarin."""
    assert set(registry.LANGUAGES) == {"en", "en-US", "es-419", "es-MX", "es-ES", "zh"}


def test_every_language_fallback_points_to_a_registered_base():
    """Product purpose: regional content can always resolve its prescribed base translation."""
    for language in registry.LANGUAGES.values():
        assert language.base is None or language.base in registry.LANGUAGES


def test_language_fallback_graph_is_acyclic():
    """Product purpose: translation fallback can never loop and block initial content sync."""
    for code in registry.LANGUAGES:
        seen = set()
        current = code
        while current is not None:
            assert current not in seen
            seen.add(current)
            current = registry.LANGUAGES[current].base


def test_registry_has_exactly_the_three_content_tables():
    """Product purpose: every launch vocabulary type is routed through one known dataset."""
    assert set(registry.TABLES) == {"verbs", "nouns", "adverbs_adjectives"}


def test_table_type_partitions_match_the_product_word_types():
    """Product purpose: verbs, nouns, adjectives, and adverbs cannot enter the wrong schema."""
    assert registry.TABLES["verbs"].allowed_types == {"verb"}
    assert registry.TABLES["nouns"].allowed_types == {"noun"}
    assert registry.TABLES["adverbs_adjectives"].allowed_types == {"adverb", "adjective"}


def test_noun_registry_requires_article_and_plural():
    """Product purpose: every noun must ship with the two aspects used for learning and mastery."""
    required = set(registry.TABLES["nouns"].required)
    assert {"article", "plural"} <= required


def test_every_content_table_requires_a_german_example_sentence():
    """Product purpose: every launch word provides contextual reading material."""
    assert all("german_sentence" in table.required for table in registry.TABLES.values())


def test_translation_field_registry_matches_the_cross_language_schema():
    """Product purpose: translation packages agree on the complete portable field vocabulary."""
    assert registry.TRANSLATION_FIELDS == ("word", "sentence", "article", "article_plural", "plural")


def test_named_free_pack_is_in_the_free_scope():
    """Product purpose: the curated starter pack is downloadable without premium."""
    assert media_delivery.is_free_pack("free")


def test_category_free_pack_is_in_the_free_scope():
    """Product purpose: free audio, image, sentence, and plural assets follow one naming rule."""
    assert media_delivery.is_free_pack("image/free")


def test_paid_pack_is_not_in_the_free_scope():
    """Product security requirement: paid level packs cannot be classified as starter media."""
    assert not media_delivery.is_free_pack("image/a1")


def test_pack_content_hash_is_independent_of_member_order():
    """Product purpose: rebuilding identical media never causes an unnecessary download."""
    members = _members()
    assert media_delivery.pack_hash(members) == media_delivery.pack_hash(list(reversed(members)))


def test_pack_content_hash_changes_when_a_member_hash_changes():
    """Product purpose: replacing any media asset reliably invalidates the client pack."""
    members = _members()
    changed = [(members[0][0], "replacement", members[0][2]), members[1]]
    assert media_delivery.pack_hash(members) != media_delivery.pack_hash(changed)


def test_pack_bytes_are_deterministic_across_member_order():
    """Product purpose: identical media inputs create byte-for-byte reproducible artefacts."""
    members = _members()
    assert media_delivery.build_pack_bytes(members) == media_delivery.build_pack_bytes(list(reversed(members)))


def test_pack_header_and_payload_are_sorted_and_length_delimited():
    """Product purpose: iOS can safely map each downloaded byte range to the correct media ID."""
    header, payload = _unpack(media_delivery.build_pack_bytes(_members()))
    assert header == {
        "v": media_delivery.PACK_FORMAT_VERSION,
        "files": [{"id": "word-a", "len": 1}, {"id": "word-b", "len": 2}],
    }
    assert payload == b"ABB"


def test_pack_metadata_describes_the_actual_serialized_blob():
    """Product security requirement: clients can verify pack size and SHA-256 before extraction."""
    members = _members()
    data = media_delivery.build_pack_bytes(members)
    metadata = media_delivery.pack_meta(members, data)
    assert metadata["hash"] == media_delivery.pack_hash(members)
    assert metadata["sha"] == hashlib.sha256(data).hexdigest()
    assert metadata["bytes"] == len(data)
    assert metadata["count"] == len(members)


def test_manifest_free_and_full_scopes_are_complete_and_sorted():
    """Product purpose: free users get starter assets while premium users can resolve every pack."""
    packs = {
        "image/a1": {"hash": "c"},
        "free": {"hash": "a"},
        "plural/free": {"hash": "b"},
    }
    manifest = media_delivery.build_manifest(packs)
    assert manifest["scopes"]["free"] == ["free", "plural/free"]
    assert manifest["scopes"]["full"] == ["free", "image/a1", "plural/free"]


def test_manifest_version_is_order_independent_and_changes_with_pack_content():
    """Product purpose: clients sync only when the effective media catalogue changes."""
    packs = {"free": {"hash": "a"}, "image/a1": {"hash": "b"}}
    reordered = dict(reversed(tuple(packs.items())))
    changed = {"free": {"hash": "replacement"}, "image/a1": {"hash": "b"}}
    assert media_delivery.build_manifest(packs)["version"] == media_delivery.build_manifest(reordered)["version"]
    assert media_delivery.build_manifest(packs)["version"] != media_delivery.build_manifest(changed)["version"]
