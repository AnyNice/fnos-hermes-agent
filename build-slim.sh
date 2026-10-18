#!/bin/bash
# Portable local packaging; prebuild the pinned core frontends first.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
exec "${PYTHON:-python}" scripts/package-fpk.py "$@"
