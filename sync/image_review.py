"""
Image review tool — a fast, keyboard-driven contact sheet for the LOW-CONFIDENCE nouns only.

`python image_sync.py` auto-approves the confident images and queues the rest (review_queue.json). This
tool serves a tiny local web page showing, per queued noun, its article+word, gloss and example
sentence alongside the candidate images AS THEY WILL SHIP (the final cropped/encoded WebP). You pick
one, mark none, or skip — and the choice is written straight into image_decisions.json (and the chosen
master mirrored to R2 if credentials are present), so the next `image_sync.py` packs it.

  python image_review.py            # open the review sheet in your browser
  python image_review.py --port 8765

Keyboard: 1–9 select a candidate · a/Enter approve the selected one · n = none (ships blank) · s/→ skip · ←  previous.
Candidates and previews live in the local image_cache (written by image_sync), so run this on the same
machine as image_sync.
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import threading
from html import escape as _esc
import webbrowser
from datetime import date
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from dotenv import load_dotenv

import image_config as cfg
import image_decisions
import image_engine
import image_sync
import media_delivery
import sync

load_dotenv(Path(__file__).parent / ".env")
logger = logging.getLogger("image_review")

# Queue IO lives in image_decisions — one implementation for every tool.
_load_queue = image_decisions.load_review_queue
_save_queue = image_decisions.save_review_queue


def _page(queue: dict, opts: dict) -> bytes:
    """Render the contact sheet. Each noun is a card; each candidate an image with its scores."""
    items = list(queue.items())
    rows = []
    for nid, e in items:
        cands = "".join(
            f'''<figure class="cand" data-id="{nid}" data-hash="{c['content_hash']}" tabindex="0">
                  <img src="/img/{c['content_hash']}" loading="lazy"/>
                  <figcaption>{c.get('source','')} · {c.get('kind','')}<br/>
                  {_fmt_scores(c.get('verifier'))}</figcaption>
                </figure>'''
            for c in e.get("candidates", [])
        ) or '<p class="empty">No candidates — mark “none”.</p>'
        no_sent = bool(opts.get(nid, {}).get("no_sentence"))
        de = e.get("german_sentence", "") or ""
        en = e.get("english_sentence", "") or ""
        sent = f'<p class="sent">🇩🇪 {de}</p>' if de else ""
        if en:
            badge = ' <span class="off">⊘ sentence OFF for next generation</span>' if no_sent else ""
            sent += f'<p class="sent en">🖼 image context: “{en}”{badge}</p>'
        esc_note = _esc(opts.get(nid, {}).get("note", "") or "", quote=True)
        rows.append(f'''
          <section class="noun" id="n-{nid}">
            <h2>{e.get('article','')} {e.get('word','')} <small>— {e.get('english','')}</small></h2>
            {sent}
            <div class="cands">{cands}</div>
            <div class="acts">
              <button class="approve" onclick="approve('{nid}')">Approve (a)</button>
              <button onclick="decide('{nid}','none')">None (n)</button>
              <button title="Reject these and regenerate without the example sentence next round" onclick="decide('{nid}','no_sentence')">Don't use sentence (d)</button>
              <button onclick="decide('{nid}','skip')">Skip (s)</button>
            </div>
            <div class="regen">
              <input id="note-{nid}" type="text" value="{esc_note}"
                placeholder="Feedback to regenerate — e.g. ‘show the full head, not cropped’ or ‘make it a red Porsche’"
                onkeydown="if(event.key==='Enter')regenNote('{nid}')"/>
              <button onclick="regenNote('{nid}')">Regenerate with note (r)</button>
            </div>
          </section>''')
    body = "\n".join(rows) or "<h1>Nothing to review 🎉</h1>"
    aw, ah = cfg.TARGET_ASPECT          # mirror the iOS card slot shape (kept in lockstep with image_config)
    aspect_css = f"{aw}/{ah}"
    aspect_label = f"{aw}:{ah}"
    html = f"""<!doctype html><html><head><meta charset="utf-8"/>
<title>Image review ({len(items)})</title>
<style>
 body{{font:15px/1.4 -apple-system,Segoe UI,sans-serif;margin:0;background:#faf7f2;color:#222}}
 header{{position:sticky;top:0;background:#fff;border-bottom:1px solid #ddd;padding:10px 16px;font-weight:600}}
 .noun{{padding:16px;border-bottom:1px solid #eee}} .noun.done{{opacity:.4}}
 h2{{margin:.2em 0}} h2 small{{color:#888;font-weight:400}} .sent{{color:#555;margin:.15em 0}}
 .sent.en{{color:#777;font-size:13px}} .sent .off{{color:#c0392b;font-weight:600}}
 .cands{{display:flex;flex-wrap:wrap;gap:10px}}
 figure.cand{{margin:0;width:400px;max-width:48vw;padding:8px;border:3px solid transparent;border-radius:16px;cursor:pointer;background:#fff}}
 figure.cand:focus,figure.cand:hover{{border-color:#e0a8a0;outline:none}}
 figure.cand.selected{{border-color:#27ae60;box-shadow:0 0 0 2px rgba(39,174,96,.25)}}
 figure.cand.selected figcaption::after{{content:' ✓ selected';color:#27ae60;font-weight:700}}
 /* Match the iOS card EXACTLY: contentMode .fit (=contain, no crop), fixed {aspect_label} slot,
    and clipShape RoundedRectangle(cornerRadius: 12) on all four corners. */
 figure.cand img{{width:100%;aspect-ratio:{aspect_css};object-fit:contain;border-radius:12px;background:#f0ece4;display:block}}
 figcaption{{font-size:11px;color:#666;padding:6px 2px 0}} .acts{{margin-top:8px}}
 .cands.hint{{outline:2px dashed #c0392b;outline-offset:4px;border-radius:8px}}
 .acts button{{margin-right:8px;padding:6px 12px;border-radius:8px;border:1px solid #ccc;background:#fff;cursor:pointer}}
 .acts button.approve{{background:#27ae60;color:#fff;border-color:#27ae60;font-weight:600}}
 .acts button.approve:hover{{background:#229152}}
 .regen{{margin-top:8px;display:flex;gap:8px;align-items:center}}
 .regen input{{flex:1;max-width:680px;padding:7px 9px;border:1px solid #ccc;border-radius:8px;font:inherit}}
 .regen button{{padding:6px 12px;border-radius:8px;border:1px solid #2d6cdf;background:#2d6cdf;color:#fff;cursor:pointer;white-space:nowrap}}
 .empty{{color:#a00}}
</style></head><body>
<header>Image review — {len(items)} noun(s) · previews shown exactly as on the iOS card ({aspect_label}, fit, rounded). Click to select, then Approve · keys: 1–9 select · a/Enter approve · n none · d don't-use-sentence · r note · s/→ skip · ← back</header>
{body}
<script>
let cur=0; const nouns=[...document.querySelectorAll('.noun')];
function focusNoun(i){{ if(i<0||i>=nouns.length) return; cur=i; nouns[i].scrollIntoView({{block:'center',behavior:'smooth'}}); }}
async function decide(id,action,hash,adv){{
  const r=await fetch('/decide',{{method:'POST',headers:{{'Content-Type':'application/json'}},
     body:JSON.stringify({{id,action,content_hash:hash}})}});
  // Mark handled, but only SCROLL when advancing via keyboard (adv) — a mouse click must not move the page.
  if(r.ok){{ const el=document.getElementById('n-'+id); if(el) el.classList.add('done'); if(adv) focusNoun(cur+1); }}
}}
function select(f){{ const sec=f.closest('.noun'); sec.querySelectorAll('figure.cand').forEach(x=>x.classList.remove('selected')); f.classList.add('selected'); }}
function approve(id,adv){{
  const sec=document.getElementById('n-'+id);
  const f=sec&&sec.querySelector('figure.cand.selected');
  if(!f){{ const c=sec&&sec.querySelector('.cands'); if(c){{ c.classList.add('hint'); setTimeout(()=>c.classList.remove('hint'),800); }} return; }}
  decide(id,'pick',f.dataset.hash,adv);
}}
// Click selects (highlights) a picture; approval is a separate, explicit step.
document.querySelectorAll('figure.cand').forEach(f=>f.addEventListener('click',()=>select(f)));
async function regenNote(id){{
  const inp=document.getElementById('note-'+id);
  const note=((inp&&inp.value)||'').trim();
  if(!note){{ if(inp) inp.focus(); return; }}
  const r=await fetch('/decide',{{method:'POST',headers:{{'Content-Type':'application/json'}},
     body:JSON.stringify({{id,action:'regen_note',note}})}});
  if(r.ok){{ const el=document.getElementById('n-'+id); if(el) el.classList.add('done'); }}
}}
document.addEventListener('keydown',e=>{{
  if(e.target.tagName==='INPUT') return;   // don't hijack keys while typing feedback
  const sec=nouns[cur]; if(!sec) return; const id=sec.id.slice(2);
  if(e.key>='1'&&e.key<='9'){{ const fs=sec.querySelectorAll('figure.cand'); const f=fs[+e.key-1]; if(f) select(f); }}
  else if(e.key==='a'||e.key==='Enter') approve(id,true);
  else if(e.key==='n') decide(id,'none',null,true);
  else if(e.key==='d') decide(id,'no_sentence',null,true);
  else if(e.key==='r'){{ const inp=document.getElementById('note-'+id); if(inp) inp.focus(); }}
  else if(e.key==='s'||e.key==='ArrowRight') focusNoun(cur+1);
  else if(e.key==='ArrowLeft') focusNoun(cur-1);
}});
focusNoun(0);
</script></body></html>"""
    return html.encode("utf-8")


def _fmt_scores(v) -> str:
    if not v:
        return "<i>no verifier score</i>"
    return " ".join(f"{k[:4]} {v.get(k,0):.2f}" for k in ("correct", "natural", "appeal"))


class _Handler(BaseHTTPRequestHandler):
    store: dict = {}
    queue: dict = {}
    opts: dict = {}
    client = None
    bucket = None
    dirty = False   # set when an approval changes the published set → publish on exit
    approved_count = 0   # images picked + mirrored to R2 this session

    def log_message(self, *_):  # quiet
        pass

    def _send(self, code, body=b"", ctype="text/html; charset=utf-8"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self):
        if self.path == "/" or self.path.startswith("/?"):
            self._send(200, _page(self.queue, self.opts))
        elif self.path.startswith("/img/"):
            h = self.path[len("/img/"):].split("?")[0]
            p = cfg.CACHE_DIR / f"{h}.{cfg.FILE_EXT}"
            if not p.exists():
                self._send(404, b"missing")
                return
            # Masters are HEIC (for the device); browsers can't show HEIC, so transcode to JPEG.
            try:
                self._send(200, image_engine.heic_to_jpeg(p.read_bytes()), "image/jpeg")
            except Exception as exc:  # noqa: BLE001
                logger.warning("preview transcode failed for %s: %s", h, exc)
                self._send(500, b"transcode failed")
        else:
            self._send(404, b"not found")

    def do_POST(self):
        if self.path != "/decide":
            self._send(404, b"not found")
            return
        length = int(self.headers.get("Content-Length", 0))
        data = json.loads(self.rfile.read(length) or b"{}")
        nid, action = data.get("id"), data.get("action")
        entry = self.queue.get(nid)
        today = date.today().isoformat()
        if action == "skip" or not entry:
            self._send(200, b"ok")
            return
        noun = {"id": nid, "word": entry.get("word"), "english": entry.get("english"),
                "german_sentence": entry.get("german_sentence")}
        if action == "none":
            image_decisions.mark_none(self.store, noun, today)
            self.queue.pop(nid, None)
        elif action == "no_sentence":
            # Reject these candidates and regenerate WITHOUT the example sentence next round:
            # record the per-noun preference (durable) and request a fresh round. For a noun
            # that already ships an approved image (a replacement in review), the approved
            # record — and the live image — are KEPT until a new pick lands (zero-gap).
            image_decisions.set_no_sentence(self.opts, nid, True)
            image_decisions.save_prompt_opts(self.opts)
            image_decisions.request_replacement(self.store, nid)
            self.queue.pop(nid, None)
        elif action == "regen_note":
            # Reviewer feedback ("show the full head" / "make it a red Porsche") — record it and
            # request a fresh round with the note appended (zero-gap for approved images, as above).
            image_decisions.set_note(self.opts, nid, data.get("note"))
            image_decisions.save_prompt_opts(self.opts)
            image_decisions.request_replacement(self.store, nid)
            self.queue.pop(nid, None)
        elif action == "pick":
            chosen = next((c for c in entry.get("candidates", [])
                           if c["content_hash"] == data.get("content_hash")), None)
            if chosen:
                image_decisions.record_approved(
                    self.store, noun, source=chosen.get("source", ""), source_id=chosen.get("source_id", ""),
                    url=chosen.get("url", ""), license=chosen.get("license", ""), kind=chosen.get("kind", "photo"),
                    content_hash=chosen["content_hash"], approved_by="human", today=today,
                    verifier=chosen.get("verifier"),
                )
                # Mirror the chosen master to R2 so it's durable + hydratable (if R2 configured).
                master = cfg.CACHE_DIR / f"{chosen['content_hash']}.{cfg.FILE_EXT}"
                if self.client is not None and master.exists():
                    try:
                        media_delivery.upload_file(self.client, self.bucket, cfg.FILES_PREFIX,
                                                   chosen["content_hash"], cfg.FILE_EXT, master)
                    except Exception as exc:  # noqa: BLE001
                        logger.warning("upload of chosen master failed (%s) — image_sync will retry", exc)
                self.queue.pop(nid, None)
                _Handler.dirty = True   # the approved set changed → publish packs+manifest on exit
                _Handler.approved_count += 1
        image_decisions.save(self.store)
        _save_queue(self.queue)
        self._send(200, b"ok")


def main() -> None:
    parser = argparse.ArgumentParser(description="Review low-confidence noun images.")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-open", action="store_true", help="Don't auto-open the browser.")
    args = parser.parse_args()
    sync._setup_logging(False, False)

    _Handler.store = image_decisions.load()
    _Handler.queue = _load_queue()
    _Handler.opts = image_decisions.load_prompt_opts()
    _Handler.bucket = os.environ.get("R2_BUCKET")
    if all(os.environ.get(k) for k in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET")):
        _Handler.client = media_delivery.r2_client()
    else:
        logger.warning("R2 not configured — picks are saved locally; run image_sync.py online to upload masters.")

    n = len(_Handler.queue)
    if n == 0:
        logger.info("Review queue is empty — nothing to review.")
        return
    url = f"http://127.0.0.1:{args.port}/"
    logger.info("Reviewing %d noun(s) → %s   (Ctrl-C to stop)", n, url)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), _Handler)
    if not args.no_open:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Review stopped. %d still queued.", len(_Handler.queue))
    finally:
        _publish_on_exit()


def _publish_on_exit() -> None:
    """On shutdown, build the image packs + write the merged manifest from the approved decisions —
    so approving in the browser is enough; no separate `image_sync.py --no-source` step is needed.
    Runs only if an approval was made this session and R2 is configured."""
    if not _Handler.dirty:
        return
    if _Handler.client is None:
        logger.info("R2 not configured — packs/manifest not published. Run `image_sync.py --no-source` online.")
        return
    logger.info("Publishing image packs + manifest…")
    try:
        packs, images = image_sync.publish_images(_Handler.store, client=_Handler.client, bucket=_Handler.bucket)
        logger.info("Published %d image pack(s) + manifest — %d image(s) total in R2, %d newly approved this session.",
                    packs, images, _Handler.approved_count)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Publish failed (%s) — run `python image_sync.py --no-source` to retry.", exc)

    # Flag every approved word (incl. previously-unflagged ones just picked) as 'y' in nouns.xlsx, so
    # the app's image flag matches the shipped picture. Run `python sync.py` to push the flags to D1.
    try:
        newly = image_sync.flag_approved_in_sheet(_Handler.store)
        if newly:
            logger.info("Flagged %d newly-approved word(s) as 'y' (red) in nouns.xlsx — run `python sync.py` "
                        "to propagate the image flag to D1.", newly)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Could not update nouns.xlsx image flags (%s).", exc)


if __name__ == "__main__":
    main()
