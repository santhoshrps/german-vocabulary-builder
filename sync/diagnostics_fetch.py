"""Operator retrieval for user diagnostics reports (docs/diagnostics.md DG-FR-12).

The app uploads gzipped JSON reports to R2 under diagnostics/<date>-<uuid>.json.gz
(worker: POST /v1/diagnostics). This tool lists them (the R2 object metadata IS the
index — build + size + upload time) and fetches one, un-gzipped, to a local file
for offline analysis. Reports self-expire server-side after 30 days.

Usage:
  python diagnostics_fetch.py list  [--env dev|test|prod]
  python diagnostics_fetch.py fetch <id-prefix> [--env ...] [--out DIR]
"""

from __future__ import annotations

import argparse
import gzip
import json
import sys
from pathlib import Path

import envs
import media_delivery

PREFIX = "diagnostics/"


def _objects(client, bucket: str) -> list[dict]:
    out: list[dict] = []
    for page in client.get_paginator("list_objects_v2").paginate(Bucket=bucket, Prefix=PREFIX):
        out.extend(page.get("Contents", []))
    return sorted(out, key=lambda o: o["LastModified"], reverse=True)


def list_reports(env: envs.Environment) -> None:
    client = media_delivery.r2_client()
    objs = _objects(client, env.r2_bucket)
    if not objs:
        print("no diagnostics reports.")
        return
    for obj in objs:
        head = client.head_object(Bucket=env.r2_bucket, Key=obj["Key"])
        meta = head.get("Metadata", {})
        name = obj["Key"].removeprefix(PREFIX).removesuffix(".json.gz")
        print(f"{name}  {obj['LastModified']:%Y-%m-%d %H:%M}Z  "
              f"build {meta.get('build', '?'):8}  {obj['Size'] / 1024:.0f} KB")


def fetch_report(env: envs.Environment, id_prefix: str, out_dir: Path) -> None:
    client = media_delivery.r2_client()
    matches = [o for o in _objects(client, env.r2_bucket) if id_prefix.lower() in o["Key"]]
    if not matches:
        sys.exit(f"no report matching '{id_prefix}'.")
    if len(matches) > 1:
        sys.exit(f"'{id_prefix}' is ambiguous ({len(matches)} matches) — use more of the id.")
    key = matches[0]["Key"]
    raw = client.get_object(Bucket=env.r2_bucket, Key=key)["Body"].read()
    payload = json.loads(gzip.decompress(raw))
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / (key.removeprefix(PREFIX).removesuffix(".gz"))
    out.write_text(json.dumps(payload, indent=2, ensure_ascii=False))
    launches = payload.get("logs", [])
    print(f"fetched {key} → {out}")
    print(f"  build {payload.get('app', {}).get('build', '?')}, "
          f"{len(launches)} launch log(s), note: {payload.get('note') or '(none)'!r}")


def main() -> None:
    parser = argparse.ArgumentParser(description="List/fetch user diagnostics reports from R2.")
    parser.add_argument("command", choices=("list", "fetch"))
    parser.add_argument("id", nargs="?", help="fetch: report id (or unique prefix)")
    parser.add_argument("--env", choices=envs.environment_names(), default=envs.DEFAULT_ENV)
    parser.add_argument("--out", default="diagnostics-reports", help="fetch: output directory")
    args = parser.parse_args()

    env = envs.load_environment(args.env)
    if args.command == "list":
        list_reports(env)
    else:
        if not args.id:
            sys.exit("fetch needs a report id (see `list`).")
        fetch_report(env, args.id, Path(args.out))


if __name__ == "__main__":
    main()
