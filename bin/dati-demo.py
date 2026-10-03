#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 CiroBoxHub
"""Una home finta con dati verosimili, per le foto del README.

    dati-demo.py HOME

Crea quattro progetti inventati con le loro conversazioni, una lettura della
quota e una serie storica. Niente viene dall'utente: e' il punto.
Lo usa bin/fotografa-pannello.sh --demo.
"""
import json, random, sys, uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

home = Path(sys.argv[1])
random.seed(7)
adesso = datetime.now(timezone.utc)
radice = home / "Progetti"
# nome, sessioni, messaggi per sessione, KB per messaggio, contesto grande
PROGETTI = [("sito-vetrina", 4, 60, 9, False), ("app-ricette", 3, 80, 12, True),
            ("analisi-vendite", 2, 40, 6, False), ("tesi-di-laurea", 2, 30, 5, False)]

for nome, sessioni, msg, kb, grande in PROGETTI:
    cwd = radice / nome
    cwd.mkdir(parents=True, exist_ok=True)
    cartella = home / ".claude/projects" / ("-" + str(cwd).strip("/").replace("/", "-"))
    cartella.mkdir(parents=True, exist_ok=True)
    for s in range(sessioni):
        # La prima sessione del progetto «grande» e' lunga e pesante: e'
        # quella che fa comparire un consiglio sulla quota.
        lunga = grande and s == 0
        inizio = adesso - timedelta(days=12 if lunga else random.randint(1, 5), hours=s)
        fine = adesso - timedelta(hours=1 + s)
        righe = []
        for i in range(msg * (3 if lunga else 1)):
            t = inizio + (fine - inizio) * i / (msg * (3 if lunga else 1))
            base = {"cwd": str(cwd), "timestamp": t.isoformat().replace("+00:00", "Z"),
                    "entrypoint": "cli"}
            righe.append({**base, "type": "user", "message": {
                "role": "user", "content": "x" * (kb * 512)}})
            letto = random.randint(160_000, 190_000) if lunga else random.randint(20_000, 90_000)
            righe.append({**base, "type": "assistant", "message": {
                "id": f"msg_{uuid.uuid4().hex[:12]}", "role": "assistant",
                "content": [{"type": "text", "text": "y" * (kb * 512)}],
                "usage": {"input_tokens": 12, "cache_read_input_tokens": letto,
                          "cache_creation_input_tokens": 900, "output_tokens": 600}}})
        f = cartella / f"{uuid.uuid4()}.jsonl"
        f.write_text("".join(json.dumps(r) + "\n" for r in righe))

dati = home / ".local/share/claude-code-watchdog"
dati.mkdir(parents=True, exist_ok=True)
(dati / "usage.json").write_text(json.dumps({
    "letteIl": adesso.isoformat(timespec="seconds"),
    "limiti": [
        {"tipo": "session", "gruppo": "session", "percento": 42,
         "azzeramento": (adesso + timedelta(hours=2, minutes=40)).isoformat(),
         "gravita": "normal", "attivo": True},
        {"tipo": "weekly_all", "gruppo": "weekly", "percento": 18,
         "azzeramento": (adesso + timedelta(days=3)).isoformat(),
         "gravita": "normal", "attivo": False}],
    "extra": {}}))
# La serie sale fino al peso vero delle conversazioni appena create: se
# finisse sopra, la linea di tendenza crollerebbe all'ultimo punto.
totale = sum(f.stat().st_size for f in (home / ".claude/projects").rglob("*.jsonl")) / 1048576
passi = [random.choice([0, 0, 1, 2, 4]) for _ in range(60)]
with (dati / "history.jsonl").open("w") as fh:
    mb = totale * 0.55
    for i in range(60):
        mb += totale * 0.45 * passi[i] / sum(passi)
        t = adesso - timedelta(minutes=10 * (60 - i))
        fh.write(json.dumps({"t": t.isoformat(timespec="seconds"), "discoPct": 31,
                             "claudeMb": round(mb + 40), "conversazioniMb": round(mb, 1),
                             "cacheMb": 6, "conversazioni": 11, "messaggi": 1400,
                             "recuperabileMb": 0, "quotaSessione": 42,
                             "quotaSettimana": 18}) + "\n")
print(f"dati di prova in {home}")
