"""What build this is.

Worth having because the first zip shared with the team was named by date, a fix was
built the same day, and the second overwrote the first -- leaving no way to tell which
build someone was actually running when they reported a problem. The version is shown
in the UI header and in the preflight output, so "what version are you on?" has an
answer.

`build.json` is written into the package by package.ps1. Running from a source
checkout there is no build.json, which is itself informative: it reports "dev".
"""
from __future__ import annotations

import json
from pathlib import Path

_SERVER_DIR = Path(__file__).resolve().parent
_BUILD_FILE = _SERVER_DIR / "build.json"
# In a source checkout the VERSION file sits one level up, beside package.ps1.
_VERSION_FILE = _SERVER_DIR.parent / "VERSION"


def _read() -> dict:
    if _BUILD_FILE.is_file():
        try:
            data = json.loads(_BUILD_FILE.read_text(encoding="utf-8"))
            return {
                "version": str(data.get("version") or "unknown"),
                "builtAt": data.get("builtAt"),
                "packaged": True,
            }
        except (OSError, json.JSONDecodeError):
            pass

    version = "dev"
    if _VERSION_FILE.is_file():
        try:
            version = _VERSION_FILE.read_text(encoding="utf-8").strip() or "dev"
        except OSError:
            pass
    # Not packaged: running from source, so there is no build timestamp to report.
    return {"version": version, "builtAt": None, "packaged": False}


BUILD = _read()


def label() -> str:
    """Short human form, e.g. "1.0.1" or "1.0.1 (source)"."""
    return BUILD["version"] if BUILD["packaged"] else f"{BUILD['version']} (source)"
