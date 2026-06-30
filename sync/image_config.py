"""
Central configuration for the noun-image pipeline.

One place for every tunable: the card image shape/quality, the redistribution-safe
source priority, the verifier auto-approve thresholds, the local cache / decisions
paths, and the pack naming. The "open decisions" from
Others/Docs/image_generation.md §16 live here as defaults so they are trivial to change.

Delivery (the shared manifest, packs, R2 client) is handled by media_delivery.py;
this module only adds image-specific naming + knobs.

Credentials (sync/.env) — never committed:
  PIXABAY_API_KEY
  PEXELS_API_KEY
  AZURE_FOUNDRY_IMAGE_ENDPOINT / AZURE_FOUNDRY_IMAGE_KEY   (image generation — Black Forest Labs FLUX on Foundry,
                                                           e.g. https://<name>.services.ai.azure.com)
  AZURE_FOUNDRY_IMAGE_MODEL          (e.g. "FLUX.2-pro")    generation model (also the request body "model")
  AZURE_FOUNDRY_ENDPOINT / AZURE_FOUNDRY_KEY              (optional — GPT-4o verify; unused in generation-first mode)
  AZURE_VISION_ENDPOINT / AZURE_VISION_KEY              (smart crop; optional — falls back to center crop)
  AZURE_CONTENT_SAFETY_ENDPOINT / AZURE_CONTENT_SAFETY_KEY
  R2_* (shared with the audio pipeline)
"""

from __future__ import annotations

import os
from pathlib import Path

# ── Paths ───────────────────────────────────────────────────────────────────
SYNC_DIR = Path(__file__).resolve().parent
CACHE_DIR = SYNC_DIR / "image_cache"                 # content-addressed masters (<hash>.heic) + raw candidates
DECISIONS_PATH = SYNC_DIR / "image_decisions.json"   # COMMITTED: per-noun approval + provenance (durable review work)
REVIEW_DIR = SYNC_DIR / "image_review"               # generated contact-sheet HTML + staged candidate previews

# ── R2: content-addressed image masters (packs/manifest are media_delivery's) ──
# Image packs ride the shared pack space (media_delivery.PACKS_PREFIX) under the names below; only the
# durable masters get an image-specific prefix.
FILES_PREFIX = "image/files"                          # image/files/<content_hash>.heic
FILE_EXT = "heic"                                     # device master: HEIC (hardware-accelerated decode on iOS)

# ── Pack naming (the image category in the shared media manifest) ──
# Names match what the iOS MediaSyncManager.category(ofPack:) classifies as the image category, and
# what media_sync.md MS-FR-CAT expects: per-level packs + a starter "image/free" pack.
def pack_name(level: str) -> str:
    """Full-tier image pack for a CEFR level, e.g. 'image/a1.1'."""
    return f"image/{level.strip().lower()}"

FREE_PACK_NAME = "image/free"                         # starter (free-tier) image pack — always downloaded

def owns_pack(name: str) -> bool:
    """media_delivery.publish predicate: this producer owns the image category only."""
    return name.startswith("image/")

# ── Card image slot (Others/Docs/image_generation.md §16; final UI sign-off pending) ──
# ONE fixed shape for ALL nouns so the iOS slot is uniform (IMG-FR-DISPLAY-1/2). Change here AND in
# the card UI together.
TARGET_ASPECT = (3, 2)                                # width : height — wider than 4:3 (set (16,9) for wider still)
TARGET_LONG_EDGE = 1024                               # master px (long edge) — slot spans card width: ~width×3 on phone @3x
IMAGE_QUALITY = 80                                    # starting HEIC quality (lowered adaptively to honour MAX_FILE_BYTES)
MIN_IMAGE_QUALITY = 55                                # quality floor before downscaling, to keep under the size cap
PREVIEW_JPEG_QUALITY = 85                             # transient JPEG rendition for the cloud verifier + browser review (not shipped)
MAX_FILE_BYTES = 500_000                              # HARD per-image cap (~500 KB); displayed small, so good enough (IMG-FR-QUAL-2)
MIN_SOURCE_LONG_EDGE = 800                            # reject candidates smaller than this (never upscale)

def target_size() -> tuple[int, int]:
    """Output (width, height) in px for the fixed slot, derived from TARGET_ASPECT + TARGET_LONG_EDGE."""
    aw, ah = TARGET_ASPECT
    if aw >= ah:
        return TARGET_LONG_EDGE, round(TARGET_LONG_EDGE * ah / aw)
    return round(TARGET_LONG_EDGE * aw / ah), TARGET_LONG_EDGE

# ── Sourcing: redistribution-safe, NO-ATTRIBUTION sources only (IMG-FR-SRC-1/2) ──
# Priority order; the engine queries them in turn and pools candidates. Unsplash and CC-BY/CC-BY-SA
# are intentionally excluded (would need a credits screen / share-alike).
SOURCE_PRIORITY = ["pixabay", "pexels", "openverse", "wikimedia"]
CANDIDATES_PER_SOURCE = 5                             # top-N high-res candidates fetched per source
MAX_CANDIDATES = 8                                    # cap on pooled candidates passed to ranking/verify

# ── Selection thresholds (premium bar → strict auto-approve; IMG-FR-REVIEW-1/4) ──
# The GPT-4o verifier returns 0..1 confidences; a candidate auto-approves only when ALL clear these.
AUTO_APPROVE = {
    "correct": 0.90,    # depicts the gloss's sense, consistent with the example sentence
    "natural": 0.85,    # reads as a real photograph (not obviously AI / illustration)
    "appeal": 0.75,     # clean, premium composition (clear single subject)
}
CLIP_MIN_SIMILARITY = 0.22                            # drop candidates the pre-rank deems clearly off-topic

# ── Generation (generation-FIRST: every flagged noun is generated, then manually reviewed) ──
ENABLE_GENERATION_FALLBACK = True                    # master switch for image generation
GENERATION_STYLES = ["photo", "illustration"]        # one generated image per style → reviewer picks

# Default cultural/regional context added to every generation prompt, so subjects look German/European
# rather than American — e.g. "highway" → a German Autobahn, not a US freeway. Empty string disables it.
IMAGE_REGION_HINT = (
    "Show it as it typically looks in Germany / Europe nowadays"
)

# ── Image generation backend: Azure AI Foundry — Black Forest Labs FLUX ──
# REST: POST {AZURE_FOUNDRY_IMAGE_ENDPOINT}/{IMAGE_GEN_PROVIDER_PATH}?api-version={IMAGE_GEN_API_VERSION}
#   headers: Authorization: Bearer {AZURE_FOUNDRY_IMAGE_KEY},  Content-Type: application/json
#   body:    {"prompt": ..., "model": IMAGE_GEN_MODEL, "width": W, "height": H, "n": 1}
#   reply:   data[0].b64_json  (base64-encoded PNG)
IMAGE_GEN_MODEL = "FLUX.2-pro"
IMAGE_GEN_PROVIDER_PATH = "providers/blackforestlabs/v1/flux-2-pro"
IMAGE_GEN_API_VERSION = "preview"
IMAGE_GEN_TIMEOUT = 180.0                            # seconds — generation is slower than a normal API call

# Generate at the CARD's aspect ratio (TARGET_ASPECT) so the model composes for the slot — instead
# of generating a square and cropping it (which cut off the tops of heads). Long edge in px;
# dimensions are rounded to multiples of 32 (a FLUX requirement). Kept LARGER than TARGET_LONG_EDGE
# so the shipped master is a clean downscale (supersampled, never upscaled).
IMAGE_GEN_LONG_EDGE = 1280


def gen_size() -> tuple[int, int]:
    """(width, height) to request from the generator, at TARGET_ASPECT + IMAGE_GEN_LONG_EDGE,
    rounded to multiples of 32. e.g. 3:2 @ 1280 -> (1280, 864)."""
    aw, ah = TARGET_ASPECT
    le = IMAGE_GEN_LONG_EDGE
    def r32(x: float) -> int:
        return max(32, int(round(x / 32)) * 32)
    return (r32(le), r32(le * ah / aw)) if aw >= ah else (r32(le * aw / ah), r32(le))

# ── HTTP / resilience ──
HTTP_TIMEOUT = 30.0                                   # seconds per source/AI request
MAX_RETRIES = 3                                       # per request, exponential backoff

# ── Env helpers ──
def env(name: str, default: str | None = None) -> str | None:
    v = os.environ.get(name)
    return v if v not in (None, "") else default

def require_env(name: str) -> str:
    v = os.environ.get(name)
    if not v:
        raise RuntimeError(f"{name} must be set in sync/.env")
    return v
