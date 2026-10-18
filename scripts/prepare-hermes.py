"""Prepare the pinned official Hermes source; retain the previous tree for rollback."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import subprocess
import sys
import uuid
import zipfile


ROOT = Path(__file__).resolve().parents[1]


def git(checkout: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(checkout), *args], check=True,
        capture_output=True, text=True, encoding="utf-8",
    )
    return result.stdout.strip()


def prepare(root: Path, checkout: Path | None = None) -> Path:
    root = root.resolve()
    lock = json.loads((root / "config/bootstrap/hermes-source.json").read_text(encoding="utf-8"))
    commit, tag, version = lock["commit"], lock["tag"], lock["version"]
    if not re.fullmatch(r"[0-9a-f]{40}", commit) or tag != f"v{version}":
        raise ValueError("Expected a full commit SHA and a matching stable vX.Y.Z tag")
    work = root / ".build"
    work.mkdir(exist_ok=True)
    if checkout is None:
        checkout = work / f"upstream-{commit}"
        if not checkout.exists():
            subprocess.run([
                "git", "clone", "--depth", "1", "--branch", tag, "--single-branch",
                lock["repository"], str(checkout),
            ], check=True)
    checkout = checkout.resolve()
    if git(checkout, "rev-parse", "HEAD") != commit or git(checkout, "rev-parse", f"{tag}^{{commit}}") != commit:
        raise ValueError("Official checkout HEAD/tag does not match the pinned commit")
    if git(checkout, "status", "--porcelain", "--untracked-files=no"):
        raise ValueError("Tracked upstream files have local changes; refusing to discard them")

    job = work / f"hermes-stage-{uuid.uuid4().hex}"
    job.mkdir()
    archive = job / "source.zip"
    git(checkout, "archive", "--format=zip", f"--output={archive}", commit)
    staged = job / "hermes-src"
    staged.mkdir()
    with zipfile.ZipFile(archive) as source:
        for name in source.namelist():
            if not (staged / name).resolve().is_relative_to(staged):
                raise ValueError(f"Archive path escapes source directory: {name}")
        source.extractall(staged)
        for member in source.infolist():
            mode = (member.external_attr >> 16) & 0o777
            if mode:
                (staged / member.filename).chmod(mode)
    subprocess.run([
        sys.executable, str(staged / "scripts/write_install_stamp.py"),
        "--output", str(staged / "install-stamp.json"),
        "--commit", commit, "--commit-date", git(checkout, "log", "-1", "--format=%ct"),
        "--base-version", version, "--display-version", version, "--distance", "0",
        "--source", "build", "--update-mechanism", "external",
    ], check=True, cwd=staged)

    destination = root / "app/hermes-src"
    if destination.is_symlink():
        raise ValueError("Refusing to replace a symlinked core directory")
    backup = work / "backups" / ("hermes-src-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8])
    if destination.exists():
        backup.parent.mkdir(parents=True, exist_ok=True)
        destination.rename(backup)
        print(f"Previous core retained at {backup}")
    try:
        staged.rename(destination)
    except OSError:
        if backup.exists():
            backup.rename(destination)
        raise
    archive.unlink()
    job.rmdir()
    print(f"Prepared Hermes {version} ({commit[:12]}) at {destination}")
    return destination


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkout", type=Path, help="Reuse an official checkout at the pinned tag")
    args = parser.parse_args()
    if sys.version_info < (3, 11):
        parser.error("Python 3.11 or newer is required; Python 3.14 is recommended")
    prepare(ROOT, args.checkout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
