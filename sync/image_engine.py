"""
Image engine — turn one noun into a slot-ready picture for MANUAL review (or a blank).

The funnel (generation-first):
  generate via Azure Foundry (photo + illustration) → process (smart-crop → HEIC master + JPEG
  rendition) → Content-Safety screen → collect EVERY image for human review. There is no stock
  search and no automated verify/auto-approve — a person approves each image in image_review.py.

The stock-source adapters (image_sources), the CLIP pre-rank, and the GPT-4o verifier remain in this
module but are NOT used by process_noun; they are kept for reference / possible re-enable.

Every heavy / external dependency (Pillow, the Microsoft Foundry SDKs) is imported LAZILY inside its
helper and degrades gracefully:
  - no generation (key) → nothing to review; the noun records a blank
  - no Content Safety   → a one-time warning; relies on human review
  - no smart-crop       → deterministic center-crop to the target ratio (Pillow only)
Pillow + pillow-heif are the hard requirements (HEIC encode); a clear error is raised if missing.

This module is pure orchestration: it returns an Outcome and never writes the decisions store or R2
(that is image_sync.py).
"""

from __future__ import annotations

import base64
import hashlib
import logging
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import image_config as cfg
import image_sources
from image_sources import Candidate

logger = logging.getLogger("image_engine")


class GenerationError(RuntimeError):
    """A generation attempt FAILED (HTTP error, timeout, unusable response) — as opposed to a clean
    'no image'. Callers must leave the noun UNSETTLED so it is retried, never mark it completed."""


# How many CLIP-ranked candidates we actually process + verify per noun (bounds API cost).
VERIFY_BUDGET = 3


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------

@dataclass
class ProcessedCandidate:
    candidate: Candidate
    master: bytes                               # the shipped HEIC bytes (slot-sized, ≤ cap)
    content_hash: str
    kind: str                                   # "photo" | "illustration"
    verifier: dict[str, float] | None = None    # {correct, natural, appeal}
    clip: float | None = None

    def score(self) -> float:
        """A single sortable quality score for the review queue (verifier-weighted, CLIP as tiebreak)."""
        v = self.verifier or {}
        base = 0.5 * v.get("correct", 0.0) + 0.3 * v.get("natural", 0.0) + 0.2 * v.get("appeal", 0.0)
        return base + 0.001 * (self.clip or 0.0)


@dataclass
class Outcome:
    status: str                                              # "approved" | "review" | "none" | "error"
    chosen: ProcessedCandidate | None = None                # set when approved
    candidates: list[ProcessedCandidate] = field(default_factory=list)  # ranked, set when review


# ---------------------------------------------------------------------------
# Query
# ---------------------------------------------------------------------------

def build_query(noun: dict[str, Any]) -> str:
    """Search subject = the English gloss, lightly de-parenthesised ('letter (of alphabet)' →
    'letter of alphabet') for better stock coverage."""
    gloss = (noun.get("english") or "").strip()
    return gloss.replace("(", " ").replace(")", " ").replace("  ", " ").strip()


# ---------------------------------------------------------------------------
# Image processing (Pillow required; Azure Vision smart-crop optional)
# ---------------------------------------------------------------------------

def _pil():
    try:
        from PIL import Image  # noqa: F401
        return Image
    except ModuleNotFoundError as exc:
        raise RuntimeError("Pillow is required for image processing — add it to requirements and install.") from exc


def _smart_crop_box(image_bytes: bytes, target_w: int, target_h: int) -> tuple[int, int, int, int] | None:
    """Ask Azure AI Vision for a smart-crop box at the target aspect ratio. Returns (l,t,r,b) in
    pixels, or None when not configured / unavailable (caller falls back to center crop)."""
    endpoint = cfg.env("AZURE_VISION_ENDPOINT")
    key = cfg.env("AZURE_VISION_KEY")
    if not endpoint or not key:
        return None
    try:
        from azure.ai.vision.imageanalysis import ImageAnalysisClient
        from azure.ai.vision.imageanalysis.models import VisualFeatures
        from azure.core.credentials import AzureKeyCredential

        client = ImageAnalysisClient(endpoint, AzureKeyCredential(key))
        ratio = round(target_w / target_h, 3)
        result = client.analyze(image_data=image_bytes, visual_features=[VisualFeatures.SMART_CROPS],
                                smart_crops_aspect_ratios=[ratio])
        crops = getattr(result, "smart_crops", None)
        if crops and crops.list:
            box = crops.list[0].bounding_box
            return (box.x, box.y, box.x + box.width, box.y + box.height)
    except Exception as exc:  # noqa: BLE001 — degrade to center crop
        logger.debug("smart-crop unavailable (%s) — using center crop", exc)
    return None


def _sips_encode_heic(img, quality: int) -> bytes:
    """Encode a PIL image to **Apple-conformant** HEIC via macOS `sips` (the same ImageIO/HEVC encoder
    Photos and Camera use). This is the real fix for the 'Invalid value for reserved bit' warning:
    libheif/x265-encoded HEIC sets a reserved HEVC bit Apple's decoder rejects, whereas sips produces
    a stream Apple decodes cleanly. macOS-only — the image build runs on a Mac. `quality` is 0–100."""
    img = img.convert("RGB")
    with tempfile.TemporaryDirectory() as td:
        src, dst = f"{td}/in.png", f"{td}/out.heic"
        img.save(src, format="PNG")
        subprocess.run(
            ["sips", "-s", "format", "heic", "-s", "formatOptions", str(quality), src, "--out", dst],
            check=True, capture_output=True,
        )
        return Path(dst).read_bytes()


def _crop_to_slot(image_bytes: bytes):
    """Crop the source to the fixed slot aspect ratio (subject-aware when possible, else centered).
    Returns a PIL.Image; both the HEIC master and the JPEG rendition are derived from this one crop so
    they are pixel-identical in framing."""
    Image = _pil()
    import io

    target_w, target_h = cfg.target_size()
    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    w, h = img.size
    box = _smart_crop_box(image_bytes, target_w, target_h)
    if box is None:
        target_ratio = target_w / target_h
        if w / h > target_ratio:               # too wide → crop width
            new_w = int(h * target_ratio)
            left = (w - new_w) // 2
            box = (left, 0, left + new_w, h)
        else:                                   # too tall → crop height
            new_h = int(w / target_ratio)
            top = (h - new_h) // 2
            box = (0, top, w, top + new_h)
    return img.crop(box)


def encode_master(cropped) -> bytes:
    """Resize the slot-cropped image to the target size and encode Apple-conformant HEIC (via sips)
    UNDER the hard cap: lower quality first, then downscale if still over — so every shipped image is
    ≤ MAX_FILE_BYTES (IMG-FR-QUAL-2). HEIC = hardware-accelerated decode on iOS. The bytes that ship."""
    Image = _pil()
    w, h = cfg.target_size()
    last = b""
    for _ in range(5):  # a few downscale rounds is plenty at this resolution
        resized = cropped.resize((w, h), Image.LANCZOS)
        q = cfg.IMAGE_QUALITY
        while q >= cfg.MIN_IMAGE_QUALITY:
            last = _sips_encode_heic(resized, q)
            if len(last) <= cfg.MAX_FILE_BYTES:
                return last
            q -= 8
        w, h = max(1, int(w * 0.85)), max(1, int(h * 0.85))  # still too big → shrink and retry
    logger.warning("  image still %.0f KB after min quality + downscale", len(last) / 1e3)
    return last


def _to_jpeg(cropped) -> bytes:
    """A JPEG rendition of the slot-cropped image — for the cloud verifier, Content Safety, and the
    browser review tool, NONE of which accept HEIC. Transient; never shipped."""
    Image = _pil()
    import io
    w, h = cfg.target_size()
    out = io.BytesIO()
    cropped.resize((w, h), Image.LANCZOS).save(out, format="JPEG", quality=cfg.PREVIEW_JPEG_QUALITY)
    return out.getvalue()


def process_to_slot(image_bytes: bytes) -> bytes:
    """Crop to the fixed slot and encode the size-capped HEIC master (the exact bytes that ship)."""
    return encode_master(_crop_to_slot(image_bytes))


def autotrim_borders(image_bytes: bytes, tol: int = 12) -> bytes:
    """Strip a uniform solid-colour matte/letterbox border (e.g. the white bars on a downloaded
    image saved into a 3:2 canvas) so the photo fills the slot instead of shipping baked-in bars.

    The border colour is taken from the four corners; any edge row/column within `tol` of it is
    trimmed. Returns the original bytes unchanged when there's nothing to trim (the common case for
    full-bleed generated images), so it's safe to call on any source.
    """
    Image = _pil()
    from PIL import ImageChops
    import io

    im = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    corners = [im.getpixel((0, 0)), im.getpixel((im.width - 1, 0)),
               im.getpixel((0, im.height - 1)), im.getpixel((im.width - 1, im.height - 1))]
    bg_color = tuple(sum(c[i] for c in corners) // 4 for i in range(3))
    bg = Image.new("RGB", im.size, bg_color)
    mask = ImageChops.difference(im, bg).convert("L").point(lambda p: 255 if p > tol else 0)
    bbox = mask.getbbox()
    if not bbox or bbox == (0, 0, im.width, im.height):
        return image_bytes                       # nothing uniform to trim
    if (bbox[2] - bbox[0]) < im.width // 2 or (bbox[3] - bbox[1]) < im.height // 2:
        return image_bytes                       # suspiciously aggressive → leave the image alone
    logger.info("  trimmed solid border %dx%d → %dx%d (rgb%s matte)",
                im.width, im.height, bbox[2] - bbox[0], bbox[3] - bbox[1], bg_color)
    out = io.BytesIO()
    im.crop(bbox).save(out, format="PNG")        # lossless intermediate; re-encoded by encode_master
    return out.getvalue()


def process_for_approval(image_bytes: bytes) -> tuple[bytes, bytes]:
    """For the direct-approve paths (regen --image / --generate): one crop → (HEIC master to ship,
    JPEG rendition for the Content-Safety screen)."""
    cropped = _crop_to_slot(image_bytes)
    return encode_master(cropped), _to_jpeg(cropped)


def reencode_master(old_heic_bytes: bytes) -> bytes:
    """Re-encode an existing HEIC master to **Apple-conformant** HEIC WITHOUT re-sourcing or
    regenerating — used to migrate legacy x265 (pillow-heif) masters to sips so the device decoder
    stops warning. Decodes via sips (Apple) to a lossless PNG, then re-encodes via `encode_master`
    (sips, size-capped). Same picture; one transcode generation of compression."""
    Image = _pil()
    with tempfile.TemporaryDirectory() as td:
        src, png = f"{td}/in.heic", f"{td}/mid.png"
        Path(src).write_bytes(old_heic_bytes)
        subprocess.run(["sips", "-s", "format", "png", src, "--out", png], check=True, capture_output=True)
        return encode_master(Image.open(png))


def heic_to_jpeg(heic_bytes: bytes) -> bytes:
    """Decode a stored HEIC master back to JPEG (via sips) — used by the review server so a browser can
    show it. Keeps the pipeline free of any HEIC Python codec (encode + decode both go through sips)."""
    with tempfile.TemporaryDirectory() as td:
        src, dst = f"{td}/in.heic", f"{td}/out.jpg"
        Path(src).write_bytes(heic_bytes)
        subprocess.run(
            ["sips", "-s", "format", "jpeg", "-s", "formatOptions", str(cfg.PREVIEW_JPEG_QUALITY),
             src, "--out", dst],
            check=True, capture_output=True,
        )
        return Path(dst).read_bytes()


def _content_hash(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


# ---------------------------------------------------------------------------
# CLIP pre-rank (open-clip, local; optional)
# ---------------------------------------------------------------------------

_clip_cache: dict[str, Any] = {}


def _load_clip():
    if "model" in _clip_cache:
        return _clip_cache
    try:
        import open_clip
        import torch
    except ModuleNotFoundError:
        _clip_cache["model"] = None
        return _clip_cache
    device = "cuda" if _torch_cuda() else ("mps" if _torch_mps() else "cpu")
    model, _, preprocess = open_clip.create_model_and_transforms("ViT-B-32", pretrained="laion2b_s34b_b79k")
    model = model.to(device).eval()
    _clip_cache.update(model=model, preprocess=preprocess, tokenizer=open_clip.get_tokenizer("ViT-B-32"),
                       torch=torch, device=device)
    return _clip_cache


def _torch_cuda() -> bool:
    try:
        import torch
        return torch.cuda.is_available()
    except Exception:  # noqa: BLE001
        return False


def _torch_mps() -> bool:
    try:
        import torch
        return torch.backends.mps.is_available()
    except Exception:  # noqa: BLE001
        return False


def clip_rank(candidates: list[tuple[Candidate, bytes]], gloss: str) -> list[tuple[Candidate, bytes, float]]:
    """Return (candidate, bytes, similarity) sorted best-first. Drops clearly off-topic candidates
    (< CLIP_MIN_SIMILARITY). If open-clip/torch are unavailable, keeps source order with clip=None."""
    c = _load_clip()
    if c.get("model") is None:
        logger.debug("CLIP unavailable — keeping source order")
        return [(cand, data, None) for cand, data in candidates]

    import io
    torch = c["torch"]
    model, preprocess, tokenizer, device = c["model"], c["preprocess"], c["tokenizer"], c["device"]
    with torch.no_grad():
        text = tokenizer([gloss]).to(device)
        tfeat = model.encode_text(text)
        tfeat = tfeat / tfeat.norm(dim=-1, keepdim=True)
        scored: list[tuple[Candidate, bytes, float]] = []
        for cand, data in candidates:
            try:
                from PIL import Image
                img = preprocess(Image.open(io.BytesIO(data)).convert("RGB")).unsqueeze(0).to(device)
                ifeat = model.encode_image(img)
                ifeat = ifeat / ifeat.norm(dim=-1, keepdim=True)
                sim = float((ifeat @ tfeat.T).item())
            except Exception as exc:  # noqa: BLE001 — unreadable image → drop
                logger.debug("CLIP skip %s/%s: %s", cand.source, cand.source_id, exc)
                continue
            if sim >= cfg.CLIP_MIN_SIMILARITY:
                scored.append((cand, data, sim))
    scored.sort(key=lambda t: t[2], reverse=True)
    return scored


# ---------------------------------------------------------------------------
# Microsoft Foundry — Content Safety + GPT-4o verifier + DALL·E generation
# ---------------------------------------------------------------------------

def content_safe(image_bytes: bytes) -> bool:
    """True if the image (a JPEG rendition) passes Azure Content Safety. When screening is not
    configured it's a no-op (returns True) — every image is human-reviewed anyway."""
    endpoint = cfg.env("AZURE_CONTENT_SAFETY_ENDPOINT")
    key = cfg.env("AZURE_CONTENT_SAFETY_KEY")
    if not endpoint or not key:
        logger.debug("Content Safety not configured — skipping screen (images are human-reviewed).")
        return True
    try:
        from azure.ai.contentsafety import ContentSafetyClient
        from azure.ai.contentsafety.models import AnalyzeImageOptions, ImageData
        from azure.core.credentials import AzureKeyCredential

        client = ContentSafetyClient(endpoint, AzureKeyCredential(key))
        result = client.analyze_image(AnalyzeImageOptions(image=ImageData(content=image_bytes)))
        # Reject if any category reaches a non-trivial severity (0..7 scale; 2+ = flagged).
        for cat in result.categories_analysis:
            if (cat.severity or 0) >= 2:
                logger.info("  content-safety rejected (%s severity %s)", cat.category, cat.severity)
                return False
        return True
    except Exception as exc:  # noqa: BLE001 — on error, do NOT auto-pass unsafe content
        logger.warning("  content-safety check errored (%s) — treating as unsafe", exc)
        return False


def _foundry_chat_client():
    endpoint = cfg.env("AZURE_FOUNDRY_ENDPOINT")
    key = cfg.env("AZURE_FOUNDRY_KEY")
    if not endpoint or not key:
        return None
    from openai import AzureOpenAI
    return AzureOpenAI(azure_endpoint=endpoint, api_key=key,
                       api_version=cfg.env("AZURE_FOUNDRY_API_VERSION", "2024-10-21"))


def verify(image_bytes: bytes, noun: dict[str, Any]) -> dict[str, float] | None:
    """GPT-4o vision verdict on the FINAL framing (a JPEG rendition of the slot-cropped image, which
    the API accepts; HEIC is not): correctness, natural-photo look, and appeal — each 0..1. Returns
    None when the verifier is not configured (→ route to review)."""
    client = _foundry_chat_client()
    deployment = cfg.env("AZURE_FOUNDRY_VERIFY_DEPLOYMENT", "gpt-4o")
    if client is None:
        return None
    word = (noun.get("word") or "").strip()
    gloss = (noun.get("english") or "").strip()
    sentence = (noun.get("german_sentence") or "").strip()
    prompt = (
        "You are vetting a single picture for a PREMIUM German vocabulary flashcard. "
        f'German word: "{word}" — meaning: "{gloss}". Example sentence: "{sentence}".\n'
        "Rate the picture and reply with ONLY a compact JSON object:\n"
        '{"correct": 0..1, "natural": 0..1, "appeal": 0..1, "reason": "short"}\n'
        "correct = clearly depicts THIS meaning of the word (consistent with the sentence), not another sense.\n"
        "natural = looks like a real photograph, NOT AI-generated, NOT an illustration/cartoon/clipart.\n"
        "appeal  = premium quality: sharp, well-lit, clean composition, a single clear subject, uncluttered."
    )
    data_url = "data:image/jpeg;base64," + base64.b64encode(image_bytes).decode("ascii")
    try:
        resp = client.chat.completions.create(
            model=deployment,
            messages=[{"role": "user", "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": data_url}},
            ]}],
            response_format={"type": "json_object"},
            max_tokens=200,
            temperature=0,
        )
        import json
        data = json.loads(resp.choices[0].message.content)
        return {k: max(0.0, min(1.0, float(data.get(k, 0.0)))) for k in ("correct", "natural", "appeal")}
    except Exception as exc:  # noqa: BLE001 — verifier hiccup → treat as "unknown" (review)
        logger.warning("  verifier errored (%s) — routing to review", exc)
        return None


def generate(noun: dict[str, Any], style: str, *, prompt: str | None = None,
             use_sentence: bool = True, note: str | None = None) -> bytes | None:
    """Generate an image via Azure AI Foundry — Black Forest Labs FLUX (REST). style='photo'
    (realistic) or 'illustration' (clean flat style); `prompt` overrides the built prompt
    (per-word regen). Returns raw PNG bytes, or None when not configured / on error.

    Request mirrors the Foundry FLUX inference API:
      POST {endpoint}/providers/blackforestlabs/v1/<model>?api-version=<ver>
      Authorization: Bearer <key>; body {"prompt","model","width","height","n"}; reply data[0].b64_json
    """
    import httpx  # lazy

    endpoint = cfg.env("AZURE_FOUNDRY_IMAGE_ENDPOINT")
    key = cfg.env("AZURE_FOUNDRY_IMAGE_KEY")
    if not endpoint or not key:
        return None

    gloss = (noun.get("english") or "").strip()
    word = (noun.get("word") or "").strip()
    de = f' (German: "{word}")' if word else ""            # give the model the German reference word
    region = f" {cfg.IMAGE_REGION_HINT}" if cfg.IMAGE_REGION_HINT else ""
    aw, ah = cfg.TARGET_ASPECT
    frame = (f" Composed for a {aw}:{ah} landscape frame, the whole subject fully visible and centered "
             "with comfortable margins — nothing cropped at the edges (heads, tops, sides).")
    sentence = (noun.get("english_sentence") or "").strip()
    scene = f" Scene: {sentence}" if (sentence and use_sentence) else ""
    if prompt:
        prompt = prompt.strip()
    else:
        if style == "photo":
            prompt = (f"A realistic, natural photograph of {gloss}{de}.{scene}{region}{frame} "
                      "Natural lighting, real-world, single clear subject, no text, no watermark, no border.")
        else:
            prompt = (f"A clean, modern flat vector illustration of {gloss}{de}.{scene}{region}{frame} "
                      "Simple background, single clear subject, consistent minimal style, no text, no watermark.")
        # Reviewer feedback (highest priority) — steers a corrected regeneration.
        if note and note.strip():
            prompt += f" Important, must follow: {note.strip()}."

    model = cfg.env("AZURE_FOUNDRY_IMAGE_MODEL", cfg.IMAGE_GEN_MODEL)
    path = cfg.env("AZURE_FOUNDRY_IMAGE_PROVIDER_PATH", cfg.IMAGE_GEN_PROVIDER_PATH)
    api_version = cfg.env("AZURE_FOUNDRY_IMAGE_API_VERSION", cfg.IMAGE_GEN_API_VERSION)
    # The BFL provider route lives on the BARE resource host — NOT under /api/projects/<proj>
    # (that path returns "API version not supported"). Normalise to scheme://host so it works
    # whether the endpoint env includes a project path or not.
    from urllib.parse import urlparse
    u = urlparse(endpoint)
    base = f"{u.scheme}://{u.netloc}" if u.scheme and u.netloc else endpoint.rstrip("/")
    url = f"{base}/{path.lstrip('/')}?api-version={api_version}"
    gen_w, gen_h = cfg.gen_size()
    body = {
        "prompt": prompt, "model": model,
        "width": gen_w, "height": gen_h, "n": 1,
    }
    try:
        resp = httpx.post(
            url,
            headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            json=body, timeout=cfg.IMAGE_GEN_TIMEOUT,
        )
        resp.raise_for_status()
        payload = resp.json()
        # FLUX/Foundry responses vary: {data:[{b64_json|url}]}, {image:"b64"}, or {result:{sample:"url"}}.
        item = (payload.get("data") or [{}])[0] if isinstance(payload.get("data"), list) else {}
        b64 = item.get("b64_json") or payload.get("b64_json") or payload.get("image")
        if b64:
            return base64.b64decode(b64)
        img_url = item.get("url") or (payload.get("result") or {}).get("sample") or payload.get("url")
        if img_url:
            return image_sources.fetch_image_bytes(img_url)
        logger.warning("  generation (%s): unrecognised response shape: %s",
                       style, str(payload)[:300])
        raise GenerationError("unrecognised response shape")
    except GenerationError:
        raise                                       # already classified — propagate as-is
    except httpx.HTTPStatusError as exc:
        # Surface the API's explanation — a 400 body says exactly which field is wrong.
        logger.warning("  generation (%s) %s: %s", style, exc.response.status_code,
                       exc.response.text[:500])
        raise GenerationError(f"HTTP {exc.response.status_code}") from exc
    except Exception as exc:  # noqa: BLE001 — network/timeout/decode → a (retryable) failure, not a clean miss
        logger.warning("  generation (%s) errored: %s", style, exc)
        raise GenerationError(str(exc)) from exc


# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

def _passes_auto_approve(v: dict[str, float] | None, *, require_natural: bool = True) -> bool:
    if not v:
        return False
    if v.get("correct", 0) < cfg.AUTO_APPROVE["correct"]:
        return False
    if v.get("appeal", 0) < cfg.AUTO_APPROVE["appeal"]:
        return False
    if require_natural and v.get("natural", 0) < cfg.AUTO_APPROVE["natural"]:
        return False
    return True


def _process_and_judge(candidate: Candidate, raw: bytes, *, kind: str, clip: float | None,
                       noun: dict[str, Any], require_natural: bool) -> tuple[ProcessedCandidate | None, bool]:
    """Crop once → HEIC master (ship) + JPEG rendition (for safety/verify) → safety → verify one
    candidate. Returns (ProcessedCandidate or None if unsafe, auto_approved)."""
    cropped = _crop_to_slot(raw)
    master = encode_master(cropped)        # HEIC, shipped
    vision = _to_jpeg(cropped)             # JPEG, for the cloud APIs (HEIC not accepted)
    if not content_safe(vision):
        return None, False
    v = verify(vision, noun)
    pc = ProcessedCandidate(candidate=candidate, master=master, content_hash=_content_hash(master),
                            kind=kind, verifier=v, clip=clip)
    return pc, _passes_auto_approve(v, require_natural=require_natural)


def process_noun(noun: dict[str, Any], *, allow_generation: bool | None = None,
                 use_sentence: bool = True, note: str | None = None) -> Outcome:
    """Generation-FIRST funnel: generate the image(s) for one noun via Azure Foundry,
    skip the automated verifier, and route EVERY image to MANUAL review — nothing
    auto-approves. `use_sentence` controls whether the example sentence is fed to the
    prompt; `note` is reviewer feedback appended to steer a corrected regeneration.
    Returns an Outcome (review / none).
    """
    if allow_generation is None:
        allow_generation = cfg.ENABLE_GENERATION_FALLBACK
    label = f'{noun.get("word")} ({noun.get("english")})'

    if not allow_generation:
        logger.debug("  generation disabled — ∅ no image for %s", label)
        return Outcome(status="none")

    model = cfg.env("AZURE_FOUNDRY_IMAGE_MODEL", cfg.IMAGE_GEN_MODEL)
    review: list[ProcessedCandidate] = []
    errored = False                                 # a style FAILED (vs. cleanly produced no image)
    for style in cfg.GENERATION_STYLES:
        try:
            raw = generate(noun, style, use_sentence=use_sentence, note=note)
        except GenerationError as exc:              # transient/API failure → must be retried
            errored = True
            logger.warning("  generation (%s) failed for %s: %s", style, label, exc)
            continue
        if raw is None:
            continue                                # not configured (no key) — nothing to do
        # Crop once → HEIC master (ship) + JPEG rendition (Content-Safety screen). No verify.
        try:
            cropped = _crop_to_slot(raw)
            master = encode_master(cropped)
            vision = _to_jpeg(cropped)
        except Exception as exc:  # noqa: BLE001 — bad bytes from generation → treat as a retryable failure
            errored = True
            logger.warning("  process failed for %s (%s): %s", label, style, exc)
            continue
        if not content_safe(vision):
            continue
        cand = Candidate(source=f"generated:{model}",
                         source_id=hashlib.sha256(f"{noun['id']}:{style}".encode()).hexdigest()[:16],
                         image_url="", page_url="", license="generated")
        review.append(ProcessedCandidate(
            candidate=cand, master=master, content_hash=_content_hash(master),
            kind=("photo" if style == "photo" else "illustration"), verifier=None, clip=None,
        ))

    # Every generated image goes to manual review; nothing is auto-approved.
    if review:
        logger.debug("  → review %s (%d generated image(s))", label, len(review))
        return Outcome(status="review", candidates=review)
    # No usable image. If a style FAILED, this is an error → leave the noun UNSETTLED so it retries.
    # Only a clean run that simply produced nothing (e.g. content-safety blocked) settles as "none".
    if errored:
        logger.warning("  ⚠ generation errored for %s — left unsettled, will retry next run", label)
        return Outcome(status="error")
    logger.debug("  ∅ no image generated for %s", label)
    return Outcome(status="none")
