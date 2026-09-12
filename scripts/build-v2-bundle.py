#!/usr/bin/env python3
"""Build a self-contained review bundle; never publishes or modifies legacy files."""
from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VENDOR = ROOT / "food2/mp/package"
NEW_FILES = [
    "shared/gaze-core.js", "shared/experiment-v2.js", "shared/experiment-v2.css",
    "shared/validation-report.js", "tests/validation-report.test.cjs",
    "shared/calibration-report.js", "tests/calibration-report.test.cjs", "tests/repeated-calibration.test.cjs",
    "shared/vendor-manifest.json", "food2/revised.html", "food3_formal/revised.html",
    "README-mobile-v2.md", "scripts/build-v2-bundle.py",
    "THIRD-PARTY-NOTICES-mobile-v2.txt", "LICENSES/Apache-2.0.txt",
    "tests/gaze-core.test.cjs", "tests/app-integration.test.cjs", "tests/app-unit.test.cjs",
    "tests/static-assets.test.cjs",
    "shared/calibration-stability.js", "shared/tracking-adapter.js",
    "shared/calibration-consistency.js", "shared/gaze-filter.js",
    "tests/calibration-consistency.test.cjs", "tests/gaze-filter.test.cjs",
    "tests/calibration-stability.test.cjs", "tests/presentation-median.test.cjs", "tests/tracking-adapter.test.cjs",
    "tests/fixtures/gaze-core-v2.1.0.cjs", "food2/revised-tasks.html", "food3_formal/revised-tasks.html",
]
NEW_FILES += [str(p.relative_to(ROOT)) for p in sorted((ROOT / 'shared/tasks-vision/0.10.32').rglob('*')) if p.is_file()]


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build_manifest() -> None:
    package = json.loads((VENDOR / "package.json").read_text())
    manifest = {
        "schemaVersion": 2,
        "appVersion": "2.3.0",
        "package": package["name"],
        "packageVersion": package["version"],
        "source": "Existing repository food2/mp/package; no vendor files changed",
        "license": package["license"],
        "hashAlgorithm": "SHA-256",
        "files": [
            {"path": str(p.relative_to(ROOT)), "bytes": p.stat().st_size, "sha256": digest(p)}
            for p in sorted(VENDOR.iterdir()) if p.is_file()
        ],
    }
    path = ROOT / "shared/vendor-manifest.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")


def build(output: Path) -> None:
    build_manifest()
    for name in NEW_FILES:
        if not (ROOT / name).is_file():
            raise SystemExit(f"Missing deliverable: {name}")
    output.mkdir(parents=True, exist_ok=True)
    assets = [p for p in VENDOR.iterdir() if p.is_file()]
    for folder in ["food2/images", "food3/images"]:
        assets.extend(ROOT / folder / f"{i}.jpg" for i in range(1, 201))
    all_files = sorted({ROOT / f for f in NEW_FILES} | set(assets))
    release = {
        "schemaVersion": 2,
        "baseCommit": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "appVersion": "2.3.0",
        "entryPoints": ["food2/revised.html", "food3_formal/revised.html", "food2/revised-tasks.html", "food3_formal/revised-tasks.html"],
        "files": [{"path": str(p.relative_to(ROOT)), "bytes": p.stat().st_size,
                   "sha256": digest(p)} for p in all_files],
    }
    with zipfile.ZipFile(output / "mediapipe-mobile-v2-standalone.zip", "w", zipfile.ZIP_DEFLATED) as archive:
        for path in all_files:
            archive.write(path, "mediapipe-mobile-v2/" + str(path.relative_to(ROOT)))
        archive.writestr("mediapipe-mobile-v2/release-manifest.json", json.dumps(release, indent=2) + "\n")
    with zipfile.ZipFile(output / "mediapipe-mobile-v2-overlay.zip", "w", zipfile.ZIP_DEFLATED) as archive:
        for name in NEW_FILES:
            archive.write(ROOT / name, name)
    patch_parts = []
    for name in NEW_FILES:
        result = subprocess.run(["git", "diff", "--binary", "--no-index", "--", "/dev/null", name],
                                cwd=ROOT, text=True, capture_output=True)
        if result.returncode not in (0, 1):
            raise SystemExit(result.stderr)
        patch_parts.append(result.stdout)
    (output / "mediapipe-mobile-v2.patch").write_text("".join(patch_parts))
    (output / "README-mobile-v2.md").write_text((ROOT / "README-mobile-v2.md").read_text())
    (output / "mobile-v2-release-manifest.json").write_text(json.dumps(release, indent=2) + "\n")
    for path in sorted(output.glob("mediapipe-mobile-v2*")):
        print(f"{path.name}: {path.stat().st_size:,} bytes")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, help="Artifact directory")
    parser.add_argument("--manifest-only", action="store_true")
    args = parser.parse_args()
    if args.manifest_only:
        build_manifest()
    elif args.out:
        build(args.out.resolve())
    else:
        parser.error("Pass --out DIRECTORY or --manifest-only")
