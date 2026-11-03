"""
Memory Galaxy plugin backend — the one thing the Desktop pane cannot do itself.

The Hermes Desktop renderer may only open http/https/mailto URLs
(`electron/external-open.ts: SUPPORTED_WEB`), so `obsidian://` is refused there.
This router runs on the machine Hermes runs on and hands the deep link to the
OS handler instead.

Routes:
    GET  /health          vault path, note/link counts, whether the vault is readable
    POST /open            {vault, path} -> opens that note in Obsidian via obsidian://

Security:
    Mounted at /api/plugins/memory-galaxy/ behind the dashboard's plugin-route
    secret scope (only the Desktop pane's own ctx.rest can call it).
    /open refuses any path that is not an existing .md file inside `vault`, so it
    cannot be used to launch arbitrary schemes or files. Only obsidian:// URIs are
    ever produced.
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

_log = logging.getLogger(__name__)

router = APIRouter()


class OpenRequest(BaseModel):
    vault: str
    path: str


def _resolve_note(vault: str, raw_path: str) -> tuple[Path, Path]:
    """Return (vault_root, note_path), or raise HTTPException(400)."""
    try:
        root = Path(vault).expanduser().resolve(strict=True)
    except (OSError, RuntimeError):
        raise HTTPException(status_code=400, detail="vault not found")

    if not root.is_dir():
        raise HTTPException(status_code=400, detail="vault is not a directory")

    try:
        note = Path(raw_path).expanduser().resolve(strict=True)
    except (OSError, RuntimeError):
        raise HTTPException(status_code=404, detail="note not found")

    if note.suffix.lower() != ".md" or not note.is_file():
        raise HTTPException(status_code=400, detail="only .md notes can be opened")

    try:
        note.relative_to(root)
    except ValueError:
        raise HTTPException(status_code=400, detail="note is outside the vault")

    return root, note


def _launch(uri: str) -> None:
    """Hand a URI to the OS handler. Raises HTTPException when it cannot."""
    try:
        if sys.platform.startswith("win"):
            os.startfile(uri)  # noqa: S606 -- the whole point of this route
        elif sys.platform == "darwin":
            subprocess.Popen(["open", uri], close_fds=True)  # noqa: S603,S607
        else:
            subprocess.Popen(["xdg-open", uri], close_fds=True)  # noqa: S603,S607
    except Exception as exc:  # noqa: BLE001 -- surface any launcher failure
        _log.warning("memory-galaxy: could not launch %s: %s", uri, exc)
        raise HTTPException(status_code=503, detail=f"could not launch Obsidian: {exc}")


def _obsidian_uri(vault_root: Path, note: Path) -> str:
    rel = note.relative_to(vault_root).with_suffix("").as_posix()
    return (
        "obsidian://open?vault="
        + quote(vault_root.name)
        + "&file="
        + quote(rel)
    )


@router.get("/health")
def health(vault: str = "") -> dict:
    root = Path(vault).expanduser() if vault else None
    readable = bool(root and root.is_dir())
    return {"ok": True, "vault": str(root) if root else None, "readable": readable}


@router.post("/open")
def open_note(payload: OpenRequest) -> dict:
    root, note = _resolve_note(payload.vault, payload.path)
    uri = _obsidian_uri(root, note)
    _launch(uri)
    _log.info("memory-galaxy: opened %s", uri)
    return {"ok": True, "uri": uri}
