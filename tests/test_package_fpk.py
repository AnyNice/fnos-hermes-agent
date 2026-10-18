"""Keep fnOS payload integrity valid when fixing Windows archive permissions."""
import hashlib
import importlib.util
import io
from pathlib import Path
import re
import tarfile
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("package_fpk", ROOT / "scripts/package-fpk.py")
packager = importlib.util.module_from_spec(spec)
spec.loader.exec_module(packager)


def add_file(archive, name, data):
    info = tarfile.TarInfo(name)
    info.size, info.mode = len(data), 0o666
    archive.addfile(info, io.BytesIO(data))


class PackageIntegrityTest(unittest.TestCase):
    def test_repack_keeps_fnos_payload_checksum_valid(self):
        payload = io.BytesIO()
        with tarfile.open(fileobj=payload, mode="w:gz") as app:
            add_file(app, "bin/hermes", b"#!/bin/bash\nexit 0\n")
        original = payload.getvalue()
        with tempfile.TemporaryDirectory() as temporary:
            package = Path(temporary) / "hermes-agent.fpk"
            with tarfile.open(package, "w:gz") as outer:
                add_file(outer, "app.tgz", original)
                add_file(outer, "manifest", b"version = 0.21.150\r\nchecksum = " + hashlib.md5(original).hexdigest().encode() + b"\r\n")
                add_file(outer, "cmd/main", b"#!/bin/bash\nexit 0\n")
            packager.finalize_archive(package)
            with tarfile.open(package, "r:gz") as outer:
                manifest = outer.extractfile("manifest").read()
                updated = outer.extractfile("app.tgz").read()
                self.assertEqual(re.search(rb"checksum = (\w+)", manifest)[1].decode(), hashlib.md5(updated).hexdigest())
                self.assertEqual(outer.getmember("cmd/main").mode, 0o755)
                self.assertEqual(outer.extractfile("icon.png").read(), (ROOT / "icon.png").read_bytes())
                with tarfile.open(fileobj=io.BytesIO(updated), mode="r:gz") as app:
                    self.assertEqual(app.getmember("bin/hermes").mode, 0o755)


if __name__ == "__main__":
    unittest.main()
