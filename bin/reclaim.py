#!/usr/bin/env python3
"""Libera lo spazio che il pannello elenca come recuperabile.

Fa soltanto i target che il pulsante «Libera spazio» può chiedere: cestino
scaduto, cache utente stantia, scarti di Claude Code. Niente gestore di
pacchetti, niente journal, niente coredump, nessun privilegio.

Esiste perché è questo lo script che viaggia dentro l'estensione, e
l'estensione può essere installata su qualunque distribuzione con GNOME.
`clean.sh` resta per l'uso da riga di comando su Fedora, dove tocca anche
`dnf5`, `journalctl` e `/var/lib/systemd/coredump`: quella parte non è
portabile e non deve esserlo. Prima il pulsante cercava `clean.sh` dentro il
checkout del progetto, che in un'installazione normale non c'è — e falliva
dicendo «Niente di selezionato».

Senza `--apply` non cancella niente: elenca e basta.
"""
import json, os, shutil, subprocess, sys, time
from pathlib import Path


def _radici() -> tuple[Path | None, Path]:
    """(radice del progetto o None, cartella che contiene gli script).

    Stessa regola di collect-metrics.py: questo file vive sia in
    `<progetto>/bin/` sia copiato nella cartella dell'estensione, dove il
    progetto non esiste e `parent.parent` punterebbe alle estensioni.
    """
    qui = Path(__file__).resolve().parent
    if (qui.parent / "config" / "watchdog.conf").is_file() and qui.name == "bin":
        return qui.parent, qui
    return None, qui


ROOT, SCRIPT_DIR = _radici()
HOME = Path.home()
CLAUDE = HOME / ".claude"

# Le stesse finestre di collect-metrics.py, che è chi calcola i MB mostrati
# nel pannello. Se le due liste divergessero, il pulsante libererebbe una
# quantità diversa da quella annunciata: `prova.sh` le confronta apposta.
RETENTION = {
    "trash":              ("TRASH_RETENTION_DAYS", 30),
    "usercache":          ("USER_CACHE_RETENTION_DAYS", 60),
    "claude-jobs":        ("CLAUDE_JOBS_RETENTION_DAYS", 30),
    "claude-snapshots":   ("CLAUDE_SHELL_SNAPSHOT_RETENTION_DAYS", 14),
    "claude-filehistory": ("CLAUDE_FILE_HISTORY_RETENTION_DAYS", 30),
    "claude-paste":       ("CLAUDE_PASTE_CACHE_RETENTION_DAYS", 14),
}

# Sottocartella di ~/.claude per i target a scadenza, e nome leggibile.
CARTELLE = {
    "claude-jobs":        ("jobs", "Job Claude"),
    "claude-snapshots":   ("shell-snapshots", "Shell snapshot"),
    "claude-filehistory": ("file-history", "File history"),
    "claude-paste":       ("paste-cache", "Paste cache"),
}

TARGET = ["trash", "usercache", "claude-stubs", *CARTELLE]


def conf() -> dict:
    """Legge config/watchdog.conf senza eseguirlo (è un file bash).

    Copiato dentro l'estensione il file non c'è: si usano i default, che sono
    gli stessi scritti nel conf di serie.
    """
    out = {}
    if not ROOT:
        return out
    f = ROOT / "config" / "watchdog.conf"
    if not f.is_file():
        return out
    for riga in f.read_text().splitlines():
        riga = riga.strip()
        if not riga or riga.startswith("#") or "=" not in riga:
            continue
        k, _, v = riga.partition("=")
        out[k.strip()] = v.split("#")[0].strip().strip("\"'")
    return out


def giorni(target: str) -> int:
    chiave, default = RETENTION[target]
    try:
        return int(conf().get(chiave, default))
    except ValueError:
        return default


def scaduti(dir: Path, gg: int) -> list[Path]:
    """File non toccati da più di `gg` giorni, senza seguire i link.

    Si scende a mano invece di usare rglob: su una cache grossa un link
    simbolico che punta all'indietro manderebbe la scansione in circolo.
    """
    limite = time.time() - gg * 86400
    out = []
    if not dir.is_dir():
        return out
    for radice, cartelle, file in os.walk(dir, followlinks=False):
        for nome in file:
            p = Path(radice) / nome
            try:
                if p.is_symlink() or p.stat().st_mtime >= limite:
                    continue
            except OSError:
                continue
            out.append(p)
    return out


def peso(percorsi) -> int:
    """Byte occupati, saltando quello che non si riesce a misurare."""
    tot = 0
    for p in percorsi:
        try:
            tot += p.stat().st_size if p.is_file() else sum(
                f.stat().st_size for f in p.rglob("*") if f.is_file())
        except OSError:
            continue
    return tot


def _script(nome: str) -> Path:
    """Un altro script del progetto, accanto a questo.

    Accanto e non sotto ROOT: nella copia dentro l'estensione stanno tutti
    nella stessa cartella e ROOT è None.
    """
    return SCRIPT_DIR / nome


def elenca(target: str) -> list[Path]:
    """Cosa toglierebbe questo target, come elenco di percorsi."""
    if target == "trash":
        # Si delega a trash-scaduti.py perché il criterio è DeletionDate letto
        # dai .trashinfo, non l'mtime: un documento vecchio buttato ieri ha
        # l'mtime di due anni fa, e potarlo per quello lo distruggerebbe il
        # giorno dopo averlo cestinato.
        try:
            r = subprocess.run([sys.executable, str(_script("trash-scaduti.py")),
                                str(giorni("trash"))],
                               capture_output=True, text=True, timeout=60)
            return [Path(l) for l in r.stdout.splitlines() if l.strip()]
        except Exception as e:
            print(f"trash-scaduti.py non eseguibile: {e}", file=sys.stderr)
            return []

    if target == "claude-stubs":
        try:
            r = subprocess.run([sys.executable, str(_script("claude-sessions.py")),
                                "--stubs"],
                               capture_output=True, text=True, timeout=120)
            # --stubs separa con il byte nullo: un percorso con uno spazio
            # verrebbe spezzato da una divisione per riga.
            grezzo = r.stdout.split("\0") if "\0" in r.stdout else r.stdout.splitlines()
            return [Path(l) for l in grezzo if l.strip()]
        except Exception as e:
            print(f"claude-sessions.py non eseguibile: {e}", file=sys.stderr)
            return []

    if target == "usercache":
        return scaduti(HOME / ".cache", giorni("usercache"))

    sub, _ = CARTELLE[target]
    return scaduti(CLAUDE / sub, giorni(target))


def cestina(percorsi: list[Path]) -> int:
    """Manda nel cestino con gio. Torna quanti ne ha presi in carico."""
    if not percorsi:
        return 0
    if not shutil.which("gio"):
        print("gio non disponibile: niente cestino, niente rimozione",
              file=sys.stderr)
        return 0
    # A blocchi: una riga di comando con migliaia di percorsi supera il limite
    # del kernel e fallisce tutta insieme invece che in parte.
    fatti = 0
    for i in range(0, len(percorsi), 200):
        blocco = percorsi[i:i + 200]
        r = subprocess.run(["gio", "trash", "--"] + [str(p) for p in blocco],
                           capture_output=True, text=True)
        if r.returncode == 0:
            fatti += len(blocco)
        else:
            print(r.stderr.strip(), file=sys.stderr)
    return fatti


def pota_vuote(dir: Path) -> None:
    """Toglie le cartelle rimaste vuote, dal fondo verso l'alto."""
    if not dir.is_dir():
        return
    for radice, cartelle, file in os.walk(dir, topdown=False):
        p = Path(radice)
        if p == dir:
            continue
        try:
            if not any(p.iterdir()):
                p.rmdir()
        except OSError:
            continue


def applica(target: str, percorsi: list[Path]) -> int:
    """Esegue il target. Torna i byte effettivamente liberati."""
    b = peso(percorsi)

    if target == "trash":
        # Qui si cancella davvero, ed è voluto: sono già nel cestino, non ce
        # n'è un secondo dove metterli. Payload e .trashinfo vanno via
        # insieme, o restano voci spaiate che il gestore file mostra rotte.
        info = HOME / ".local/share/Trash/info"
        for p in percorsi:
            try:
                if p.is_dir() and not p.is_symlink():
                    shutil.rmtree(p, ignore_errors=True)
                else:
                    p.unlink(missing_ok=True)
                (info / f"{p.name}.trashinfo").unlink(missing_ok=True)
            except OSError:
                continue
        return b

    if target == "claude-stubs":
        # Nel cestino e non cancellati: il criterio «nessuna risposta
        # dell'assistente» può pescare una conversazione vera interrotta
        # prima della prima risposta.
        return b if cestina(percorsi) else 0

    # Cache e scarti a scadenza: si rigenerano da soli, al più il primo
    # avvio è più lento. Stessa scelta di clean.sh, che è la versione
    # rivista: divergere qui vorrebbe dire due comportamenti per un pulsante
    # e una riga di comando che l'utente crede facciano la stessa cosa.
    for p in percorsi:
        try:
            p.unlink(missing_ok=True)
        except OSError:
            continue
    pota_vuote(HOME / ".cache" if target == "usercache"
               else CLAUDE / CARTELLE[target][0])
    return b


def main() -> int:
    argv = sys.argv[1:]
    applica_davvero = "--apply" in argv
    come_json = "--json" in argv
    scelti = [a for a in argv if not a.startswith("-")]

    ignoti = [t for t in scelti if t not in TARGET]
    if ignoti:
        print(f"target sconosciuto: {', '.join(ignoti)}", file=sys.stderr)
        print(f"disponibili: {', '.join(TARGET)}", file=sys.stderr)
        return 2
    if not scelti:
        print(f"uso: {Path(sys.argv[0]).name} [--apply] [--json] TARGET…",
              file=sys.stderr)
        print(f"disponibili: {', '.join(TARGET)}", file=sys.stderr)
        return 2

    voci, totale = [], 0
    for t in scelti:
        percorsi = elenca(t)
        if not percorsi:
            voci.append({"target": t, "file": 0, "mb": 0})
            continue
        b = applica(t, percorsi) if applica_davvero else peso(percorsi)
        totale += b
        voci.append({"target": t, "file": len(percorsi),
                     "mb": round(b / 1048576, 1)})

    esito = {"applicato": applica_davvero,
             "liberatiMb": round(totale / 1048576, 1),
             "voci": voci}

    if come_json:
        print(json.dumps(esito, ensure_ascii=False))
    else:
        for v in voci:
            print(f"  {v['target']:<20} {v['file']:>6} file  {v['mb']:>8} MB")
        verbo = "liberati" if applica_davvero else "liberabili"
        print(f"\n  {verbo}: {esito['liberatiMb']} MB")
        if not applica_davvero:
            print("  (nessun file toccato: manca --apply)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
