"""MS2-FR-32 — the test-world harness: backend truths no stub can fake, executed
against the REAL `test` environment (its own D1 pair + bucket, wrangler.toml).

Gated: set WORLD_TESTS=1 to run (network + credentials required); everything
skips cleanly otherwise, so the ordinary unit-test run stays offline.

    WORLD_TESTS=1 .venv/bin/python3 -m pytest tests/test_world_integration.py -v

Optional depth:
    WORLD_TEST_PROMO=<a free-tier code seeded in the TEST D1> unlocks the
    session-mint + rate-limit-counter cases.
    READ_WORKER_TEST_URL overrides the read worker's test URL.

Fixture doctrine (MS2-FR-32): worlds are seeded BEFORE a suite (world.py seed
--env test) and wiped only at the START of the next run — a failed run's world
stays intact for inspection. This harness only READS and mints sessions; it
never publishes.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import httpx
import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

if os.environ.get("WORLD_TESTS") != "1":
    pytest.skip("WORLD_TESTS=1 not set — test-world harness skipped (offline run)",
                allow_module_level=True)

import envs
import world

READ_URL = os.environ.get(
    "READ_WORKER_TEST_URL",
    "https://german-vocabulary-read-worker-test.heidelberg-techlabs.workers.dev",
).rstrip("/")


@pytest.fixture(scope="module")
def test_env() -> envs.Environment:
    return envs.load_environment("test")


def _identity(body: dict) -> str | None:
    return body.get("env") or body.get("environment")


def test_write_worker_health_identity(test_env):
    """MS2-FR-30: workers report their environment identity on /health — and the
    TEST world must answer as itself, never as dev/prod."""
    response = httpx.get(f"{test_env.worker_url}/health", timeout=30.0)
    assert response.status_code == 200
    assert _identity(response.json()) == "test", response.text[:200]


def test_read_worker_health_identity():
    try:
        response = httpx.get(f"{READ_URL}/health", timeout=30.0)
    except httpx.HTTPError:
        pytest.skip(f"read worker test env unreachable at {READ_URL} — deploy it "
                    f"(read-worker: scripts/deploy.sh test) to enable this case")
    assert response.status_code == 200
    assert _identity(response.json()) == "test", response.text[:200]


def test_signed_state_roundtrip_serves_rows(test_env):
    """The HMAC-signed /state contract against real platform semantics: the seeded
    test world answers with real rows (drift/seed depend on exactly this)."""
    state = world._state(test_env, "nouns")
    assert state is not None, "/state/nouns absent — was the test world seeded? (world.py seed --env test)"
    assert len(state) > 0
    sample_hash = next(iter(state.values()))
    assert isinstance(sample_hash, str) and len(sample_hash) >= 8


def test_invalid_promo_is_rejected_not_served():
    """The auth gate on the real worker: a wrong code must be a clean 4xx —
    never a session, never a 5xx."""
    try:
        response = httpx.post(f"{READ_URL}/v1/session",
                              json={"promoCode": "harness-definitely-wrong"}, timeout=30.0)
    except httpx.HTTPError:
        pytest.skip(f"read worker test env unreachable at {READ_URL}")
    assert 400 <= response.status_code < 500, response.text[:200]


def test_fixture_promo_mints_and_rate_limit_counts():
    """The rate-limit COUNTER on real D1 (the atomic upsert no stub can prove):
    a minted session hammering the catalog route must hit the documented
    60/600 limiter within 70 calls. Needs WORLD_TEST_PROMO seeded in test D1."""
    code = os.environ.get("WORLD_TEST_PROMO")
    if not code:
        pytest.skip("WORLD_TEST_PROMO not set — seed a free promo in the TEST D1 "
                    "(read-worker/schema/extra.sql shows the INSERT) to enable")
    minted = httpx.post(f"{READ_URL}/v1/session", json={"promoCode": code}, timeout=30.0)
    assert minted.status_code == 200, minted.text[:200]
    token = minted.json()["token"]
    saw_429 = False
    for _ in range(70):
        response = httpx.get(f"{READ_URL}/v1/media/catalog/audio",
                             headers={"Authorization": f"Bearer {token}"}, timeout=30.0)
        assert response.status_code != 200 or response.headers.get("Content-Type", "").startswith("application/json")
        assert response.status_code < 500, response.text[:200]
        if response.status_code == 429:
            saw_429 = True
            break
    assert saw_429, "70 catalog calls never hit the documented 60/600 limiter"
