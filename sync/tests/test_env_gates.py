"""MEDIA-022: every R2-mutating command must route through the environment registry
and hit the typed production gate — with no bypass, including image_sync's --yes.

These tests drive the real argparse mains with monkeypatched envs/network layers, so
the DISPATCH is proven (gate called, registry consulted) without touching R2.
"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

import envs


def _fake_env(name: str) -> envs.Environment:
    return envs.Environment(
        name=name,
        worker_url=f"https://german-vocabulary-worker{'' if name == 'prod' else '-' + name}.example.workers.dev",
        api_key="k",
        r2_bucket=f"german-media-{name}",
    )


class GateCalled(Exception):
    """Raised by the fake confirm gate so the test proves the gate fired FIRST."""


@pytest.fixture
def gate_recorder(monkeypatch):
    calls: list[str] = []

    def fake_confirm(env, *, action):
        calls.append(action)
        raise GateCalled(action)   # stop before any client/network work

    monkeypatch.setattr(envs, "confirm_production", fake_confirm)
    return calls


# ---- audio_sync -------------------------------------------------------------

def test_audio_sync_rejects_unknown_environment(monkeypatch, capsys):
    import audio_sync
    monkeypatch.setattr(sys, "argv", ["audio_sync.py", "--env", "prod", "--dry-run"])

    def failing_load(name):
        raise envs.EnvironmentError_("no overlay")

    monkeypatch.setattr(audio_sync.envs, "load_environment", failing_load)
    with pytest.raises(SystemExit) as exc:
        audio_sync.main()
    assert exc.value.code == 1


def test_audio_sync_prod_mutation_hits_typed_gate(monkeypatch, gate_recorder):
    import audio_sync
    monkeypatch.setattr(sys, "argv", ["audio_sync.py", "--env", "prod", "--no-synth"])
    monkeypatch.setattr(audio_sync.envs, "load_environment", lambda name: _fake_env("prod"))
    with pytest.raises(GateCalled):
        audio_sync.main()
    assert gate_recorder and "PRODUCTION" in gate_recorder[0]


def test_audio_sync_prune_names_the_destructive_action(monkeypatch, gate_recorder):
    import audio_sync
    monkeypatch.setattr(sys, "argv", ["audio_sync.py", "--env", "prod", "--no-synth", "--prune-files"])
    monkeypatch.setattr(audio_sync.envs, "load_environment", lambda name: _fake_env("prod"))
    with pytest.raises(GateCalled):
        audio_sync.main()
    assert "PRUNE" in gate_recorder[0]


# ---- image_sync -------------------------------------------------------------

def test_image_sync_yes_cannot_bypass_prod_gate(monkeypatch, gate_recorder):
    import image_sync
    monkeypatch.setattr(sys, "argv",
                        ["image_sync.py", "--env", "prod", "--delete-all", "--yes"])
    monkeypatch.setattr(image_sync.envs, "load_environment", lambda name: _fake_env("prod"))
    with pytest.raises(GateCalled):
        image_sync.main()
    assert "DELETE ALL" in gate_recorder[0]


def test_image_sync_dev_delete_all_needs_no_typed_gate(monkeypatch):
    import image_sync
    # dev + dry-run: neither the typed gate nor any client should be needed.
    monkeypatch.setattr(sys, "argv",
                        ["image_sync.py", "--env", "dev", "--delete-all", "--dry-run"])
    monkeypatch.setattr(image_sync.envs, "load_environment", lambda name: _fake_env("dev"))
    called = []
    monkeypatch.setattr(image_sync.envs, "confirm_production",
                        lambda env, *, action: called.append(action))
    monkeypatch.setattr(image_sync, "reset_all",
                        lambda *, client, bucket, dry_run: called.append(f"reset:{bucket}:{dry_run}"))
    image_sync.main()
    assert called == ["reset:german-media-dev:True"], "dev dry-run resets without a prod gate"


# ---- media_publish mirror-masters ------------------------------------------

def test_mirror_masters_is_gated(monkeypatch, gate_recorder):
    import media_publish
    monkeypatch.setattr(sys, "argv", ["media_publish.py", "mirror-masters", "--env", "prod"])
    monkeypatch.setattr(media_publish.envs, "load_environment", lambda name: _fake_env("prod"))
    with pytest.raises(SystemExit):
        # main() catches EnvironmentError_/PublishError; GateCalled is neither, so it
        # propagates — but argparse/main wiring differences make either exit acceptable
        # as long as the gate fired first.
        try:
            media_publish.main()
        except GateCalled:
            raise SystemExit(3)
    assert gate_recorder and "mirror media masters" in gate_recorder[0]
