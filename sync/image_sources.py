"""
Image source adapters — redistribution-safe, NO-ATTRIBUTION stock/CC photos only.

Each adapter turns a search query (the noun's English gloss) into a list of high-resolution
`Candidate`s with provenance + license. Only sources whose licence permits commercial use AND
bundling into our own storage WITHOUT attribution are used (IMG-FR-SRC-1/2):

  - Pixabay   — Pixabay Content License (commercial, redistribution, no attribution)
  - Pexels    — Pexels License           (commercial, no attribution)
  - Openverse — filtered to CC0 / Public-Domain-Mark results only
  - Wikimedia — filtered to Public Domain / CC0 results only

Explicitly excluded: Unsplash (API terms hostile to bundling) and CC-BY / CC-BY-SA (would require an
in-app credits screen / share-alike). Each adapter degrades gracefully — a missing key or an API
error logs a warning and yields no candidates, so the pipeline keeps working with whatever is
configured.

Keys (sync/.env): PIXABAY_API_KEY, PEXELS_API_KEY. Openverse/Wikimedia are keyless (rate-limited).
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable

import httpx

import image_config as cfg

logger = logging.getLogger("image_sources")

# Hard cap on a single downloaded image to protect against a hostile/huge response.
MAX_IMAGE_BYTES = 25 * 1024 * 1024


@dataclass
class Candidate:
    """One sourced image, with everything needed to rank, fetch, and record provenance."""
    source: str            # "pixabay" | "pexels" | "openverse" | "wikimedia"
    source_id: str         # provider id (stable — pins a human pick across search drift)
    image_url: str         # direct, high-resolution image URL to download
    page_url: str          # landing page (provenance)
    license: str           # normalized short name (redistribution-safe, no-attribution)
    width: int = 0
    height: int = 0
    title: str = ""        # alt/tags/title — a weak textual relevance hint
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def long_edge(self) -> int:
        return max(self.width, self.height)


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------

def _get_json(url: str, *, headers: dict | None = None, params: dict | None = None) -> dict[str, Any]:
    """GET JSON with retry + backoff. Raises on final failure (caller catches per-source)."""
    last: Exception | None = None
    for attempt in range(cfg.MAX_RETRIES):
        try:
            resp = httpx.get(url, headers=headers, params=params, timeout=cfg.HTTP_TIMEOUT,
                             follow_redirects=True)
            resp.raise_for_status()
            return resp.json()
        except Exception as exc:  # noqa: BLE001
            last = exc
            if attempt < cfg.MAX_RETRIES - 1:
                time.sleep(2 ** attempt)
    raise RuntimeError(f"GET {url} failed after {cfg.MAX_RETRIES} tries: {last}")


def fetch_image_bytes(url: str, *, max_bytes: int = MAX_IMAGE_BYTES) -> bytes:
    """Download one image's bytes (size-capped, with retry). Raises on failure."""
    last: Exception | None = None
    for attempt in range(cfg.MAX_RETRIES):
        try:
            with httpx.stream("GET", url, timeout=cfg.HTTP_TIMEOUT, follow_redirects=True) as resp:
                resp.raise_for_status()
                buf = bytearray()
                for chunk in resp.iter_bytes():
                    buf.extend(chunk)
                    if len(buf) > max_bytes:
                        raise RuntimeError(f"image exceeds {max_bytes} bytes")
                return bytes(buf)
        except Exception as exc:  # noqa: BLE001
            last = exc
            if attempt < cfg.MAX_RETRIES - 1:
                time.sleep(2 ** attempt)
    raise RuntimeError(f"download {url} failed after {cfg.MAX_RETRIES} tries: {last}")


# ---------------------------------------------------------------------------
# Adapters (each returns [] on missing key / error — never raises to the caller)
# ---------------------------------------------------------------------------

def _pixabay(query: str, limit: int) -> list[Candidate]:
    key = cfg.env("PIXABAY_API_KEY")
    if not key:
        return []
    data = _get_json("https://pixabay.com/api/", params={
        "key": key, "q": query, "image_type": "photo", "safesearch": "true",
        "order": "popular", "per_page": max(3, min(limit, 200)), "lang": "en",
    })
    out: list[Candidate] = []
    for h in data.get("hits", []):
        out.append(Candidate(
            source="pixabay", source_id=str(h.get("id")),
            image_url=h.get("largeImageURL") or h.get("webformatURL") or "",
            page_url=h.get("pageURL", ""), license="Pixabay",
            width=int(h.get("imageWidth") or 0), height=int(h.get("imageHeight") or 0),
            title=str(h.get("tags") or ""),
        ))
    return [c for c in out if c.image_url]


def _pexels(query: str, limit: int) -> list[Candidate]:
    key = cfg.env("PEXELS_API_KEY")
    if not key:
        return []
    data = _get_json("https://api.pexels.com/v1/search", headers={"Authorization": key}, params={
        "query": query, "per_page": max(1, min(limit, 80)), "orientation": "landscape",
    })
    out: list[Candidate] = []
    for p in data.get("photos", []):
        src = p.get("src", {}) or {}
        out.append(Candidate(
            source="pexels", source_id=str(p.get("id")),
            image_url=src.get("large2x") or src.get("large") or src.get("original") or "",
            page_url=p.get("url", ""), license="Pexels",
            width=int(p.get("width") or 0), height=int(p.get("height") or 0),
            title=str(p.get("alt") or ""),
        ))
    return [c for c in out if c.image_url]


# Openverse licences we accept (no attribution required).
_OPENVERSE_LICENSES = "cc0,pdm"


def _openverse(query: str, limit: int) -> list[Candidate]:
    # Keyless (anonymous, rate-limited). Restrict to no-attribution licences + exclude mature.
    data = _get_json("https://api.openverse.org/v1/images/", params={
        "q": query, "license": _OPENVERSE_LICENSES, "page_size": max(1, min(limit, 20)),
        "mature": "false",
    })
    out: list[Candidate] = []
    for r in data.get("results", []):
        lic = str(r.get("license") or "").lower()
        if lic not in ("cc0", "pdm"):
            continue
        out.append(Candidate(
            source="openverse", source_id=str(r.get("id")),
            image_url=r.get("url") or "", page_url=r.get("foreign_landing_url", ""),
            license=lic.upper(),
            width=int(r.get("width") or 0), height=int(r.get("height") or 0),
            title=str(r.get("title") or ""),
        ))
    return [c for c in out if c.image_url]


def _is_no_attribution_license(short: str) -> bool:
    s = (short or "").lower()
    return ("public domain" in s) or ("cc0" in s) or s.strip() in ("pd", "pdm")


def _wikimedia(query: str, limit: int) -> list[Candidate]:
    # Search the File namespace, then read imageinfo (url, size, license metadata). Keep only
    # Public-Domain / CC0 results (no attribution).
    data = _get_json("https://commons.wikimedia.org/w/api.php", params={
        "action": "query", "format": "json", "generator": "search",
        "gsrsearch": f'filetype:bitmap {query}', "gsrnamespace": "6",
        "gsrlimit": max(1, min(limit, 20)),
        "prop": "imageinfo", "iiprop": "url|size|extmetadata", "iiurlwidth": cfg.TARGET_LONG_EDGE,
    })
    pages = (data.get("query", {}) or {}).get("pages", {}) or {}
    out: list[Candidate] = []
    for page in pages.values():
        info = (page.get("imageinfo") or [{}])[0]
        meta = info.get("extmetadata", {}) or {}
        short = (meta.get("LicenseShortName", {}) or {}).get("value", "")
        if not _is_no_attribution_license(short):
            continue
        out.append(Candidate(
            source="wikimedia", source_id=str(page.get("pageid")),
            image_url=info.get("thumburl") or info.get("url") or "",
            page_url=info.get("descriptionurl", ""), license=short or "Public domain",
            width=int(info.get("thumbwidth") or info.get("width") or 0),
            height=int(info.get("thumbheight") or info.get("height") or 0),
            title=str(page.get("title") or ""),
        ))
    return [c for c in out if c.image_url]


_ADAPTERS: dict[str, Callable[[str, int], list[Candidate]]] = {
    "pixabay": _pixabay,
    "pexels": _pexels,
    "openverse": _openverse,
    "wikimedia": _wikimedia,
}


# ---------------------------------------------------------------------------
# Public: pooled candidate fetch
# ---------------------------------------------------------------------------

def fetch_candidates(
    query: str,
    *,
    per_source: int = cfg.CANDIDATES_PER_SOURCE,
    max_total: int = cfg.MAX_CANDIDATES,
    sources: list[str] | None = None,
) -> list[Candidate]:
    """Pool high-resolution candidates for `query` across the configured no-attribution sources, in
    priority order, dropping too-small images and duplicates. Returns at most `max_total`.

    A failing source is logged and skipped — never fatal — so the pipeline runs with whatever keys
    are configured.
    """
    chosen = sources or cfg.SOURCE_PRIORITY
    pooled: list[Candidate] = []
    seen: set[tuple[str, str]] = set()
    seen_urls: set[str] = set()
    for name in chosen:
        adapter = _ADAPTERS.get(name)
        if adapter is None:
            continue
        try:
            cands = adapter(query, per_source)
        except Exception as exc:  # noqa: BLE001 — degrade: skip this source
            logger.warning("  source %s failed for %r: %s", name, query, exc)
            continue
        for c in cands:
            if c.long_edge and c.long_edge < cfg.MIN_SOURCE_LONG_EDGE:
                continue  # too small for the premium slot (IMG-FR-QUAL-2)
            key = (c.source, c.source_id)
            if key in seen or c.image_url in seen_urls:
                continue
            seen.add(key)
            seen_urls.add(c.image_url)
            pooled.append(c)
    if not pooled:
        logger.info("  no candidates for %r across %s", query, ", ".join(chosen))
    return pooled[:max_total]
