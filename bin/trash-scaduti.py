#!/usr/bin/env python3
"""Elenca gli elementi del cestino buttati da più di N giorni.

Si legge `DeletionDate` dai file `.trashinfo`, non l'mtime del payload: un
documento modificato due anni fa e cestinato ieri ha l'mtime vecchio, e potarlo
in base a quello lo distruggerebbe il giorno dopo averlo buttato.
"""
import configparser, sys
from datetime import datetime, timedelta
from pathlib import Path

giorni = int(sys.argv[1]) if len(sys.argv) > 1 else 30
base = Path.home() / ".local/share/Trash"
limite = datetime.now() - timedelta(days=giorni)

info = base / "info"
if info.is_dir():
    for f in sorted(info.glob("*.trashinfo")):
        try:
            c = configparser.ConfigParser(interpolation=None)
            c.read(f, encoding="utf-8")
            quando = datetime.fromisoformat(c["Trash Info"]["DeletionDate"])
        except Exception:
            continue
        if quando < limite:
            print(base / "files" / f.name[: -len(".trashinfo")])
