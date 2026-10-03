#!/usr/bin/env python3
"""Mette e toglie gli hook di Watchface in ~/.claude/settings.json.

    watchface-hooks.py stato [--json]       cosa c'e' adesso
    watchface-hooks.py installa             aggiunge i nostri hook
    watchface-hooks.py rimuovi              toglie i nostri hook
    watchface-hooks.py rimuovi-altro NOME   toglie gli hook del programma NOME
    watchface-hooks.py ripristina FILE      rimette un backup

settings.json contiene anche le impostazioni dell'utente, quindi:
- prima di ogni modifica se ne fa un backup, e i backup si elencano;
- si scrive su un temporaneo e si rinomina, con i permessi dell'originale;
- un file che non e' JSON valido non si riscrive mai: si esce con errore.
Le preferenze dell'estensione chiamano questo script; la logica sta qui, in
Python, perche' qui si puo' provare.
"""
import json, os, re, shutil, sys, time
from pathlib import Path

HOME = Path.home()
SETTINGS = HOME / ".claude" / "settings.json"
BACKUP = (Path(os.environ.get("XDG_DATA_HOME") or (HOME / ".local/share"))
          / "claude-code-watchdog" / "backup-settings")
BACKUP_DA_TENERE = 10
HOOK = Path(__file__).resolve().parent / "watchface-hook"
MARCA = "/watchface-hook'"

# Gli eventi che servono a dire cosa sta facendo Claude: gli stessi che
# coucou ascoltava, perche' sono quelli che cambiano lo stato visibile.
EVENTI = ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse",
          "PostToolUse", "PostToolUseFailure", "PermissionRequest",
          "Notification", "Stop", "StopFailure", "SubagentStart",
          "SubagentStop"]


class Illeggibile(Exception):
    pass


def leggi() -> dict:
    if not SETTINGS.exists():
        return {}
    try:
        d = json.loads(SETTINGS.read_text())
    except (OSError, ValueError) as e:
        raise Illeggibile(f"{SETTINGS} non e' JSON valido: {e}") from e
    if not isinstance(d, dict):
        raise Illeggibile(f"{SETTINGS} non contiene un oggetto JSON")
    return d


def comando(evento: str) -> str:
    # `|| true`: se un giorno l'estensione sparisce senza togliere gli hook,
    # Claude Code non deve mostrare un errore a ogni strumento.
    # `bash` esplicito: lo zip delle estensioni puo' perdere il bit di
    # esecuzione, e un hook non eseguibile tacerebbe senza dire perche'.
    return f"bash '{HOOK}' {evento} 2>/dev/null || true"


def nostro(h: dict) -> bool:
    return MARCA in str(h.get("command", ""))


def programma(cmd: str) -> str:
    """Il nome del programma di un comando di hook, per raggrupparli."""
    m = re.match(r"\s*(?:'([^']+)'|\"([^\"]+)\"|(\S+))", cmd)
    if not m:
        return "?"
    return Path(next(g for g in m.groups() if g)).name


def backup() -> Path | None:
    """Copia settings.json nei backup, nato con permessi 600."""
    if not SETTINGS.exists():
        return None
    BACKUP.mkdir(parents=True, exist_ok=True)
    os.chmod(BACKUP, 0o700)
    nome = BACKUP / f"settings-{time.strftime('%Y%m%d-%H%M%S')}.json"
    n = 1
    while nome.exists():
        nome = BACKUP / f"settings-{time.strftime('%Y%m%d-%H%M%S')}-{n}.json"
        n += 1
    fd = os.open(nome, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(SETTINGS.read_bytes())
    for vecchio in elenco_backup()[:-BACKUP_DA_TENERE]:
        vecchio.unlink(missing_ok=True)
    return nome


def elenco_backup() -> list[Path]:
    if not BACKUP.is_dir():
        return []
    return sorted(BACKUP.glob("settings-*.json"))


def scrivi(d: dict) -> None:
    """Temporaneo accanto e rinomina: chi legge vede il file vecchio o il
    nuovo, mai uno a meta'. Con i permessi dell'originale, 600 se nuovo."""
    SETTINGS.parent.mkdir(parents=True, exist_ok=True)
    modo = SETTINGS.stat().st_mode & 0o777 if SETTINGS.exists() else 0o600
    tmp = SETTINGS.with_name(f".settings.json.{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, modo)
    try:
        with os.fdopen(fd, "w") as fh:
            json.dump(d, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        os.chmod(tmp, modo)
        tmp.replace(SETTINGS)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def togli(d: dict, scarta) -> int:
    """Toglie gli hook per cui `scarta(h)` e' vero. Gruppi e eventi rimasti
    vuoti spariscono, e cosi' la chiave `hooks` se non resta niente."""
    tolti = 0
    hooks = d.get("hooks")
    if not isinstance(hooks, dict):
        return 0
    for ev in list(hooks):
        gruppi = hooks[ev] if isinstance(hooks[ev], list) else []
        nuovi = []
        for g in gruppi:
            dentro = g.get("hooks", []) if isinstance(g, dict) else []
            resta = [h for h in dentro if not (isinstance(h, dict) and scarta(h))]
            tolti += len(dentro) - len(resta)
            if resta:
                nuovi.append({**g, "hooks": resta})
        if nuovi:
            hooks[ev] = nuovi
        else:
            del hooks[ev]
    if not hooks:
        del d["hooks"]
    return tolti


def stato() -> dict:
    d = leggi()
    installati, altri = [], {}
    for ev, gruppi in (d.get("hooks") or {}).items():
        for g in gruppi if isinstance(gruppi, list) else []:
            for h in (g.get("hooks", []) if isinstance(g, dict) else []):
                if not isinstance(h, dict):
                    continue
                if nostro(h):
                    installati.append(ev)
                else:
                    cmd = str(h.get("command", ""))
                    a = altri.setdefault(programma(cmd),
                                         {"programma": programma(cmd),
                                          "comando": cmd, "eventi": []})
                    a["eventi"].append(ev)
    return {"settings": str(SETTINGS), "hook": str(HOOK),
            "hookPresente": HOOK.is_file(),
            "installati": sorted(set(installati)),
            "mancanti": [e for e in EVENTI if e not in installati],
            "altri": list(altri.values()),
            "backup": [str(p) for p in elenco_backup()]}


def main() -> int:
    argv = sys.argv[1:]
    if not argv:
        print(__doc__, file=sys.stderr)
        return 2
    azione, resto = argv[0], argv[1:]
    try:
        if azione == "stato":
            s = stato()
            if "--json" in resto:
                print(json.dumps(s, ensure_ascii=False))
            else:
                print(f"installati: {len(s['installati'])}/{len(EVENTI)}")
                for a in s["altri"]:
                    print(f"altro: {a['programma']} ({len(a['eventi'])} eventi)")
                print(f"backup: {len(s['backup'])}")
            return 0

        if azione == "installa":
            if not HOOK.is_file():
                print(f"hook non trovato: {HOOK}", file=sys.stderr)
                return 1
            if "'" in str(HOOK):
                print("percorso dell'hook con un apice: non lo scrivo", file=sys.stderr)
                return 1
            d = leggi()
            backup()
            togli(d, nostro)          # cosi' un percorso cambiato si aggiorna
            hooks = d.setdefault("hooks", {})
            for ev in EVENTI:
                hooks.setdefault(ev, []).append(
                    {"hooks": [{"type": "command", "command": comando(ev),
                                "timeout": 5}]})
            scrivi(d)
            print(f"installati {len(EVENTI)} hook")
            return 0

        if azione == "rimuovi":
            d = leggi()
            backup()
            n = togli(d, nostro)
            scrivi(d)
            print(f"tolti {n} hook")
            return 0

        if azione == "rimuovi-altro":
            if len(resto) != 1:
                print("serve il nome del programma", file=sys.stderr)
                return 2
            nome = resto[0]
            d = leggi()
            backup()
            n = togli(d, lambda h: not nostro(h)
                      and programma(str(h.get("command", ""))) == nome)
            scrivi(d)
            print(f"tolti {n} hook di {nome}")
            return 0

        if azione == "ripristina":
            if len(resto) != 1:
                print("serve il file di backup", file=sys.stderr)
                return 2
            # Solo un file della cartella dei backup: questo comando lo chiama
            # un pulsante, e un percorso qualsiasi diventerebbe la
            # configurazione di Claude Code.
            f = Path(resto[0]).resolve()
            if f.parent != BACKUP.resolve() or not f.is_file():
                print("non e' un backup di watchface-hooks", file=sys.stderr)
                return 1
            try:
                json.loads(f.read_text())
            except ValueError:
                print("il backup non e' JSON valido", file=sys.stderr)
                return 1
            backup()
            shutil.copyfile(f, SETTINGS)
            print(f"ripristinato {f.name}")
            return 0
    except Illeggibile as e:
        print(e, file=sys.stderr)
        return 1

    print(f"azione sconosciuta: {azione}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
