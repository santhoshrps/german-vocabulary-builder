"""Environment registry for the publish pipeline (MS2-FR-30/30g).

Environments are DATA, not branches: every pipeline command resolves its target
through this registry — never through ad-hoc env vars — so a half-dev-half-prod
configuration is unrepresentable.

Layout:
  sync/.env          shared, environment-independent secrets (Azure TTS, image APIs).
  sync/.env.<name>   the per-environment overlay: WORKER_URL, API_KEY, R2_BUCKET
                     (+ optional R2_* credential overrides). Gitignored, like .env.

Rules enforced here (fail before any network request):
  - the environment name must be registered (dev | test | prod);
  - the overlay file must exist and provide every required key;
  - R2_BUCKET must be EXACTLY the registered bucket for that environment;
  - WORKER_URL must be https and carry the environment's expected suffix
    (so a prod URL pasted into .env.dev aborts instead of publishing);
  - prod requires the typed confirmation gate (confirm_production).

Default environment is ALWAYS dev: production is only ever reached by an explicit
--env prod plus the typed confirmation.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from pathlib import Path

from dotenv import dotenv_values, load_dotenv

_SYNC_DIR = Path(__file__).parent

DEFAULT_ENV = "dev"

# name -> (expected R2 bucket, expected write-worker URL suffix before ".workers.dev")
_REGISTRY: dict[str, dict[str, str]] = {
    "dev": {"bucket": "german-media-dev", "url_marker": "german-vocabulary-worker-dev"},
    "test": {"bucket": "german-media-test", "url_marker": "german-vocabulary-worker-test"},
    "prod": {"bucket": "german-media-prod", "url_marker": "german-vocabulary-worker"},
}


@dataclass(frozen=True)
class Environment:
    name: str
    worker_url: str
    api_key: str
    r2_bucket: str

    @property
    def is_prod(self) -> bool:
        return self.name == "prod"


class EnvironmentError_(RuntimeError):
    pass


def environment_names() -> list[str]:
    return list(_REGISTRY)


def load_environment(name: str | None) -> Environment:
    """Resolve and validate the target environment. Loads shared .env into the
    process environment (Azure/image credentials), then reads the per-env overlay."""
    name = (name or DEFAULT_ENV).strip().lower()
    if name not in _REGISTRY:
        raise EnvironmentError_(
            f"unknown environment {name!r}; registered: {', '.join(_REGISTRY)}"
        )

    load_dotenv(_SYNC_DIR / ".env")  # shared, env-independent secrets

    overlay_path = _SYNC_DIR / f".env.{name}"
    if not overlay_path.exists():
        raise EnvironmentError_(
            f"missing {overlay_path.name} — create it with WORKER_URL, API_KEY, R2_BUCKET "
            f"for the {name} environment (see envs.py docstring)"
        )
    overlay = {k: (v or "") for k, v in dotenv_values(overlay_path).items()}

    missing = [k for k in ("WORKER_URL", "API_KEY", "R2_BUCKET") if not overlay.get(k)]
    if missing:
        raise EnvironmentError_(f"{overlay_path.name} is missing: {', '.join(missing)}")

    worker_url = overlay["WORKER_URL"].rstrip("/")
    bucket = overlay["R2_BUCKET"]
    expected = _REGISTRY[name]

    if not worker_url.startswith("https://"):
        raise EnvironmentError_(f"{overlay_path.name}: WORKER_URL must use https:// (got {worker_url!r})")
    host = worker_url.removeprefix("https://").split("/")[0]
    subdomain = host.split(".")[0]
    if subdomain != expected["url_marker"]:
        raise EnvironmentError_(
            f"{overlay_path.name}: WORKER_URL host {host!r} does not look like the {name} "
            f"write worker (expected subdomain {expected['url_marker']!r}) — refusing a "
            f"cross-environment configuration"
        )
    if bucket != expected["bucket"]:
        raise EnvironmentError_(
            f"{overlay_path.name}: R2_BUCKET is {bucket!r} but the {name} environment "
            f"publishes to {expected['bucket']!r} — refusing a cross-environment configuration"
        )

    # Per-env R2 credential overrides (bucket-scoped tokens); fall back to shared .env.
    for key in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"):
        if overlay.get(key):
            os.environ[key] = overlay[key]
    # Export the resolved trio so existing consumers (media_delivery) read one source.
    os.environ["R2_BUCKET"] = bucket
    os.environ["WORKER_URL"] = worker_url
    os.environ["API_KEY"] = overlay["API_KEY"]

    return Environment(name=name, worker_url=worker_url, api_key=overlay["API_KEY"], r2_bucket=bucket)


def confirm_production(env: Environment, *, action: str) -> None:
    """Typed gate (MS2-FR-30): interactive prod actions require literally typing 'prod'.
    Non-interactive stdin (cron/CI) refuses outright — production publishes are a
    deliberate human act until a CI pipeline with its own approvals exists."""
    if not env.is_prod:
        return
    if not sys.stdin.isatty():
        raise EnvironmentError_(f"refusing non-interactive PRODUCTION {action}")
    answer = input(f"About to {action} in PRODUCTION. Type 'prod' to continue: ").strip()
    if answer != "prod":
        raise EnvironmentError_("production action not confirmed — aborted")


if __name__ == "__main__":
    # Self-check: validate whichever overlays exist, without touching the network.
    for env_name in environment_names():
        overlay = _SYNC_DIR / f".env.{env_name}"
        if not overlay.exists():
            print(f"{env_name}: (no overlay yet)")
            continue
        try:
            e = load_environment(env_name)
            print(f"{env_name}: ok — worker={e.worker_url} bucket={e.r2_bucket}")
        except EnvironmentError_ as err:
            print(f"{env_name}: INVALID — {err}")
            sys.exit(1)
