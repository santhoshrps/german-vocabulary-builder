"""Static app/backend entitlement and environment contract checks."""

import tomllib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PRODUCT_ID = "com.ramapurampalanivel.germanwords.fullaccess.lifetime"
BUNDLE_ID = "com.ramapurampalanivel.germanwords"


def _wrangler():
    with (ROOT / "read-worker" / "wrangler.toml").open("rb") as handle:
        return tomllib.load(handle)


def test_production_verifies_the_exact_lifetime_product_and_bundle():
    """Product purpose: restoration requires matching app and production worker identifiers."""
    variables = _wrangler()["vars"]
    assert variables["APP_BUNDLE_ID"] == BUNDLE_ID
    assert variables["ENTITLEMENT_PRODUCT_IDS"].split(",") == [PRODUCT_ID]


def test_production_can_never_enable_unsigned_xcode_transactions():
    """Product security requirement: production StoreKit and App Attest must fail closed."""
    variables = _wrangler()["vars"]
    assert variables["STOREKIT_ENV"] == "production"
    assert variables["APP_ATTEST_ENV"] == "production"


def test_each_xcode_storekit_environment_is_paired_with_development_attestation():
    """Product security requirement: local transactions exist only outside production."""
    for name, configuration in _wrangler().get("env", {}).items():
        variables = configuration.get("vars", {})
        if variables.get("STOREKIT_ENV") == "xcode":
            assert name != "production"
            assert variables.get("APP_ATTEST_ENV") == "development"
