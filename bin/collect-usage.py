#!/usr/bin/env python3
"""Legge il consumo di quota Claude e lo scrive in usage.json.

Il dato non esiste in locale: va chiesto alla CLI con `claude -p "/usage"`.
Ogni invocazione però lascia una trascrizione vuota in ~/.claude/projects/ —
è così che l'estensione claude-status ne ha accumulate centinaia.

Qui si fa la stessa chiamata ma si rimuove lo scarto subito dopo, e si legge
il record `usageReport` dalla trascrizione invece di applicare una regex al
testo per l'utente: è dato strutturato, non cambia con la traduzione o con il
formato del messaggio.

Costa circa 2 secondi e un giro di rete. Non consuma token: /usage è un
comando locale che interroga solo i contatori.
"""
import json, os, re, subprocess, sys, time, argparse
from datetime import datetime, timezone
from pathlib import Path

HOME = Path.home()
PROJECTS = HOME / ".claude" / "projects"
OUT_DIR = Path(os.environ.get("XDG_DATA_HOME", HOME / ".local/share")) / "fedora-watchdog"
USAGE = OUT_DIR / "usage.json"

# La trascrizione finisce nella cartella che corrisponde alla cwd: lanciando da
# $HOME si sa sempre dove cercarla.
CWD = HOME


def cartella_progetto() -> Path:
    """Cartella di projects/ corrispondente a $HOME.

    La codifica vera è «ogni carattere non alfanumerico diventa un trattino»:
    una versione che sostituiva solo / e _ sbagliava cartella su qualunque home
    con un punto nel nome, e da lì lo script non trovava mai la trascrizione
    appena creata — né la rimuoveva.
    """
    return PROJECTS / re.sub(r"[^A-Za-z0-9-]", "-", str(CWD))


def nel_cestino(p: Path) -> bool:
    """Nel cestino, non cancellato: anche uno scarto può essere una sessione
    vera interpretata male, e questo è il pattern che il 2026-09-17 è costato
    due conversazioni."""
    try:
        r = subprocess.run(["gio", "trash", str(p)], capture_output=True,
                           text=True, timeout=30)
        return r.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def istantanea(d: Path) -> set[Path]:
    return set(d.glob("*.jsonl")) if d.is_dir() else set()


def estrai(f: Path) -> tuple[dict | None, bool]:
    """Ritorna (rate_limits, è_uno_scarto) leggendo la trascrizione."""
    limiti = None
    risposte = 0
    try:
        for riga in f.open("rb"):
            try:
                d = json.loads(riga)
            except Exception:
                continue
            if not isinstance(d, dict):
                continue
            if d.get("type") == "assistant":
                risposte += 1
            u = d.get("usageReport")
            if u and u.get("rate_limits"):
                limiti = u["rate_limits"]
    except OSError:
        return None, False
    return limiti, risposte == 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--quiet", action="store_true")
    ap.add_argument("--keep", action="store_true",
                    help="non rimuovere la trascrizione generata (per diagnosi)")
    ap.add_argument("--timeout", type=int, default=60)
    args = ap.parse_args()

    dir_prog = cartella_progetto()
    prima = istantanea(dir_prog)

    try:
        subprocess.run(["claude", "-p", "/usage"], cwd=str(CWD),
                       capture_output=True, text=True, timeout=args.timeout)
    except FileNotFoundError:
        if not args.quiet:
            print("claude non trovato nel PATH", file=sys.stderr)
        return 2
    except subprocess.TimeoutExpired:
        if not args.quiet:
            print("timeout nell'interrogare la quota", file=sys.stderr)
        return 3

    # La trascrizione viene scritta a chiusura: si concede qualche istante.
    nuovi = set()
    for _ in range(10):
        nuovi = istantanea(dir_prog) - prima
        if nuovi:
            break
        time.sleep(0.2)

    limiti = None
    for f in sorted(nuovi, key=lambda p: p.stat().st_mtime, reverse=True):
        l, scarto = estrai(f)
        if l and limiti is None:
            limiti = l
        # Si cancella SOLO se non contiene nessuna risposta dell'assistente:
        # se per una corsa sfortunata fosse comparsa una conversazione vera,
        # resta intatta.
        if scarto and not args.keep:
            nel_cestino(f)

    # NON si ripassa la cartella per togliere "vecchi scarti": lì dentro può
    # esserci una sessione interattiva vera, aperta da $HOME, che ha già scritto
    # la domanda dell'utente ma non ha ancora ricevuto risposta — identica a uno
    # scarto per qualunque controllo automatico. Una versione precedente la
    # cancellava con unlink(), sotto il naso del processo che la stava usando.
    # Si rimuove solo ciò che questa invocazione ha creato, e nel cestino.

    if limiti is None:
        if not args.quiet:
            print("nessun dato di quota nella trascrizione", file=sys.stderr)
        return 4

    voci = []
    for l in limiti.get("limits", []):
        voci.append({
            "tipo": l.get("kind"),
            "gruppo": l.get("group"),
            "percento": l.get("percent"),
            "azzeramento": l.get("resets_at"),
            "gravita": l.get("severity"),
            "attivo": l.get("is_active"),
        })

    dati = {
        "letteIl": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "limiti": voci,
        "extra": limiti.get("extra_usage") or {},
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    tmp = USAGE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(dati, ensure_ascii=False, indent=1))
    tmp.replace(USAGE)
    try:
        USAGE.chmod(0o600)
    except OSError:
        pass

    if not args.quiet:
        print(json.dumps(dati, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
