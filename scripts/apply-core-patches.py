#!/usr/bin/env python3
"""Apply tracked core patches to the vendored app/hermes-src before packaging.

app/hermes-src is a gitignored, commit-pinned copy of the upstream core
(see config/bootstrap/hermes-source.json). Fixes that belong to the core but
are not yet upstream ride along as unified diffs under patches/core/*.patch
(applied with -p1 from the repo root; headers are a/app/hermes-src/...
b/app/hermes-src/...).

Idempotent: a patch already applied to the working tree is detected via a
reverse dry-run and skipped, so re-running the release pipeline never
double-applies.

Usage:  python3 scripts/apply-core-patches.py
"""

import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PATCH_DIR = ROOT / "patches" / "core"
CORE = ROOT / "app" / "hermes-src"


def _run(cmd: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)


def already_applied(name: str, patch_path: Path) -> bool:
    """True when the working tree already carries this patch (reverse dry-run succeeds)."""
    r = _run(["git", "apply", "-R", "--check", str(patch_path)])
    return r.returncode == 0


def apply_one(name: str, patch_path: Path) -> None:
    if already_applied(name, patch_path):
        print(f"core-patch: {name}: already applied, skipping")
        return
    r = _run(["git", "apply", str(patch_path)])
    if r.returncode != 0:
        sys.stderr.write(r.stdout)
        sys.stderr.write(r.stderr)
        raise SystemExit(
            f"core-patch: failed to apply {name} (exit {r.returncode}); "
            f"run: cd {ROOT} && git apply {patch_path.name}"
        )
    print(f"core-patch: {name}: applied")


def main() -> int:
    if not CORE.is_dir():
        raise SystemExit(f"core-patch: {CORE} missing; stage the pinned core first")
    if not PATCH_DIR.is_dir():
        print("core-patch: no patches/core directory, nothing to do")
        return 0
    for patch_path in sorted(PATCH_DIR.glob("*.patch")):
        apply_one(patch_path.name, patch_path)
    print(f"core-patch: {len(list(PATCH_DIR.glob('*.patch')))} patch(es) under {PATCH_DIR.relative_to(ROOT)} in sync")
    return 0


if __name__ == "__main__":
    sys.exit(main())
