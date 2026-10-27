"""Package a prepared Hermes core and the fnOS adapter without development caches."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import uuid


ROOT = Path(__file__).resolve().parents[1]
CORE_DEV = {".git", ".github", "tests", "tests-js", "website", "evals", "contributors"}
CACHES = {"node_modules", "__pycache__", ".pytest_cache", ".ruff_cache", ".hermes-runtime"}


def ignored(directory: str, names: list[str]) -> set[str]:
    parent = Path(directory)
    result = {
        name for name in names
        if name in CACHES or name.endswith((".pyc", ".bak", ".log"))
        or name.startswith((".web_dist-build-", ".dist-"))
        or name.endswith(".egg-info")
        or name == ".env" or (name.startswith(".env.") and name != ".env.example")
    }
    if parent == ROOT / "app/hermes-src":
        result.update(CORE_DEV.intersection(names))
    if parent == ROOT / "app/hermes-src/apps":
        result.update({"desktop", "bootstrap-installer"}.intersection(names))
    return result


def validate() -> str:
    lock = json.loads((ROOT / "config/bootstrap/hermes-source.json").read_text(encoding="utf-8"))
    core = ROOT / "app/hermes-src"
    stamp = json.loads((core / "install-stamp.json").read_text(encoding="utf-8"))
    if stamp["commit"] != lock["commit"] or stamp["displayVersion"] != lock["version"]:
        raise ValueError("Prepared core does not match config/bootstrap/hermes-source.json")
    for name in ("hermes_cli/web_dist/index.html", "ui-tui/dist/entry.js"):
        if not (core / name).is_file():
            raise ValueError(f"Missing built frontend: {name}; build web and TUI before packaging")
    version_env = (ROOT / "config/bootstrap/hermes-version.env").read_text(encoding="utf-8")
    if not re.search(rf"^HERMES_VERSION={re.escape(lock['version'])}$", version_env, re.MULTILINE):
        raise ValueError("Installer target version does not match pinned core")
    manifest = (ROOT / "manifest").read_text(encoding="utf-8")
    match = re.search(r"^version\s*=\s*(\S+)", manifest, re.MULTILINE)
    if not match:
        raise ValueError("Missing application version in manifest")
    # APP_VERSION 一致性门（v0.21.158）：hermes-version.env 的 APP_VERSION 必须与 manifest 严格同轨。
    # 它是 NAS 设备上唯一可靠的 FPK 版本源（FPK 框架不部署 manifest 到应用目录，
    # 面板 update/check 的"应用版本"依赖它）；二者漂移会导致面板版本轨混装/更新检查失真。
    version_env = (ROOT / "config/bootstrap/hermes-version.env").read_text(encoding="utf-8")
    app_match = re.search(r"^APP_VERSION\s*=\s*([\d.]+)", version_env, re.MULTILINE)
    if not app_match:
        raise ValueError("config/bootstrap/hermes-version.env 缺少 APP_VERSION（面板 FPK 版本源），需与 manifest version 一致")
    if app_match[1] != match[1]:
        raise ValueError(f"APP_VERSION({app_match[1]}) 与 manifest version({match[1]}) 不一致，拒绝出包")
    return match[1]


def write_member(target: tarfile.TarFile, member: tarfile.TarInfo, data: bytes | None) -> None:
    member.uid = member.gid = 0
    member.uname = member.gname = "root"
    if member.isdir():
        member.mode = 0o755
    elif member.isfile():
        executable = data is not None and data.startswith((b"#!", b"\x7fELF"))
        member.mode = 0o755 if executable or member.mode & 0o111 else 0o644
    target.addfile(member, io.BytesIO(data) if data is not None else None)


def finalize_archive(package: Path) -> None:
    # Windows fnpack emits 0666 for scripts/binaries. Restore executable bits in
    # both archive layers so wrappers and bundled Linux CLIs work after install.
    replacement = package.with_suffix(".repack.fpk")
    with tarfile.open(package, "r:gz") as source, tarfile.open(replacement, "w:gz") as target:
        payload = next(m for m in source.getmembers() if m.name.lstrip("./") == "app.tgz")
        rebuilt = io.BytesIO()
        with tarfile.open(fileobj=source.extractfile(payload), mode="r:gz") as app, tarfile.open(fileobj=rebuilt, mode="w:gz") as output:
            for entry in app.getmembers():
                content = app.extractfile(entry).read() if entry.isfile() else None
                write_member(output, entry, content)
        app_data = rebuilt.getvalue()
        checksum = hashlib.md5(app_data).hexdigest().encode("ascii")
        for member in source.getmembers():
            if member.name.lstrip("./") == "icon.png":
                continue
            data = source.extractfile(member).read() if member.isfile() else None
            if member.name.lstrip("./") == "app.tgz":
                data = app_data
                member.size = len(data)
            elif member.name.lstrip("./") == "manifest":
                data, count = re.subn(rb"(?m)^(checksum[^\S\r\n]*=[^\S\r\n]*)[^\r\n]*", lambda match: match[1] + checksum, data)
                if count != 1:
                    raise ValueError("Expected exactly one fnpack payload checksum in manifest")
                member.size = len(data)
            write_member(target, member, data)
        data = (ROOT / "icon.png").read_bytes()
        member = tarfile.TarInfo("icon.png")
        member.size, member.mode = len(data), 0o644
        write_member(target, member, data)
    replacement.replace(package)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--fnpack", default=shutil.which("fnpack"), help="Path to the official fnpack executable")
    args = parser.parse_args()
    if not args.fnpack:
        parser.error("Provide --fnpack /path/to/fnpack (https://developer.fnnas.com/docs/cli/fnpack/)")
    fnpack = Path(args.fnpack).resolve()
    version = validate()
    # Keep the gitignored vendored core in sync with the tracked core fixes
    # (patches/core/*.patch) before staging the package tree.
    subprocess.run([sys.executable, str(ROOT / "scripts" / "apply-core-patches.py")], check=True)
    job = ROOT / ".build" / f"fpk-{uuid.uuid4().hex}"
    stage = job / "hermes-agent"
    stage.mkdir(parents=True)
    for name in ("app", "cmd", "config", "wizard"):
        shutil.copytree(ROOT / name, stage / name, ignore=ignored)
    for name in ("manifest", "LICENSE", "README.md"):
        shutil.copy2(ROOT / name, stage / name)
    for name in ("ICON.PNG", "ICON_256.PNG", "icon.png"):
        source = ROOT / name
        if not source.is_file():
            source = ROOT / "icon.png"
        shutil.copy2(source, stage / name)
    subprocess.run([str(fnpack), "build", "--directory", str(stage)], cwd=job, check=True)
    package = job / "hermes-agent.fpk"
    if not package.is_file():
        raise FileNotFoundError(f"fnpack did not produce {package}")
    finalize_archive(package)
    output = ROOT / "pkg" / f"fnos-hermes-agent_v{version}.fpk"
    output.parent.mkdir(exist_ok=True)
    if output.exists():
        backup = output.with_name(output.name + "." + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + ".bak")
        output.rename(backup)
    shutil.move(str(package), output)
    print(f"Built {output} ({output.stat().st_size / 1024 / 1024:.1f} MiB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
