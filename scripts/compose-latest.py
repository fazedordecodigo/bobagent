#!/usr/bin/env python3
import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote


PLATFORMS = {
    "darwin-aarch64": ".app.tar.gz",
    "linux-x86_64": ".AppImage",
    "windows-x86_64": "-setup.exe",
}


def compose(args: argparse.Namespace) -> dict:
    if not args.tag.startswith("v"):
        raise ValueError(f"expected a version tag beginning with v, got {args.tag!r}")
    version = args.tag[1:]
    if version != args.expected_version:
        raise ValueError(
            f"tag version {version!r} does not match tauri.conf.json version "
            f"{args.expected_version!r}"
        )

    assets = json.loads(args.assets_json.read_text(encoding="utf-8")).get("assets", [])
    names = {asset["name"] for asset in assets if isinstance(asset.get("name"), str)}
    signatures = {}
    for platform, suffix in PLATFORMS.items():
        matches = sorted(name for name in names if name.endswith(suffix))
        if len(matches) != 1:
            raise ValueError(
                f"expected exactly one updater asset for {platform}, found {len(matches)}"
            )
        name = matches[0]
        signature_name = f"{name}.sig"
        if signature_name not in names:
            raise ValueError(f"missing signature asset {signature_name}")
        signature_path = args.signatures_dir / signature_name
        if not signature_path.is_file():
            raise ValueError(f"signature file was not downloaded: {signature_name}")
        signature = signature_path.read_text(encoding="utf-8").strip()
        if not signature:
            raise ValueError(f"signature asset is empty: {signature_name}")
        signatures[platform] = {
            "signature": signature,
            "url": (
                f"https://github.com/{args.repository}/releases/download/"
                f"{quote(args.tag, safe='')}/{quote(name, safe='')}"
            ),
        }

    return {
        "version": version,
        "notes": args.notes_file.read_text(encoding="utf-8"),
        "pub_date": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "platforms": signatures,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--assets-json", type=Path, required=True)
    parser.add_argument("--signatures-dir", type=Path, required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--expected-version", required=True)
    parser.add_argument("--notes-file", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    try:
        metadata = compose(args)
        args.output.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        print(error, file=sys.stderr)
        return 1
    print(f"Wrote {args.output} for {', '.join(PLATFORMS)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
