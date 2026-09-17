#!/usr/bin/env python3
"""Elenca (o rimuove) tutto ciò che appartiene a una sessione Claude Code.

Una sessione non vive solo nella trascrizione: lascia tracce in sei posti
diversi. Questo script li trova tutti e, solo con --apply, li rimuove.

    session-purge.py <id>              elenca cosa verrebbe rimosso
    session-purge.py <id> --json       stesso elenco, per l'estensione GNOME
    session-purge.py <id> --apply      sposta nel cestino
    session-purge.py <id> --apply --definitivo   cancella per davvero

SENZA --apply NON TOCCA NIENTE.
"""
import json, re, shutil, subprocess, sys, argparse
from pathlib import Path

HOME = Path.home()
CLAUDE = HOME / ".claude"
TMP_ROOT = Path("/tmp") / f"claude-{HOME.stat().st_uid}"


def dir_size(p: Path) -> int:
    if p.is_file():
        try:
            return p.stat().st_size
        except OSError:
            return 0
    tot = 0
    for f in p.rglob("*"):
        try:
            if f.is_file():
                tot += f.stat().st_size
        except OSError:
            pass
    return tot


def nel_cestino(p: Path) -> tuple[bool, str]:
    """Sposta nel cestino invece di cancellare.

    Una trascrizione da quattromila messaggi non si ricostruisce: il 2026-09-17
    ne sono andate due perché qui c'era un unlink() e nient'altro. Con il
    cestino resta un'ora di ripensamento.
    Si usa `gio trash`, che rispetta le regole freedesktop e quindi si recupera
    dal gestore file come qualunque altra cosa.
    """
    try:
        r = subprocess.run(["gio", "trash", str(p)],
                           capture_output=True, text=True, timeout=30)
        if r.returncode == 0:
            return True, ""
        return False, (r.stderr or "").strip()
    except (OSError, subprocess.SubprocessError) as e:
        return False, str(e)


def trova(sid: str) -> list[dict]:
    """Tutti i percorsi che appartengono alla sessione, con il loro peso."""
    voci = []

    def add(path: Path, cosa: str):
        if path.exists():
            voci.append({"percorso": str(path), "cosa": cosa,
                         "byte": dir_size(path),
                         "tipo": "cartella" if path.is_dir() else "file"})

    # 1. le trascrizioni: possono essercene copie in più cartelle progetto
    proj = CLAUDE / "projects"
    if proj.is_dir():
        for f in proj.glob(f"*/{sid}.jsonl"):
            add(f, f"trascrizione in {f.parent.name}")

    # 2-3. dati per sessione, indicizzati direttamente dall'id
    add(CLAUDE / "session-env" / sid, "variabili d'ambiente")
    add(CLAUDE / "file-history" / sid, "cronologia modifiche ai file")

    # 4. i job hanno una cartella con nome accorciato: l'id vero sta in
    #    state.json, quindi si legge invece di fidarsi del prefisso.
    jobs = CLAUDE / "jobs"
    if jobs.is_dir():
        for j in jobs.iterdir():
            if not j.is_dir():
                continue
            st = j / "state.json"
            try:
                if json.loads(st.read_text()).get("sessionId") == sid:
                    add(j, f"job in background ({j.name})")
            except Exception:
                continue

    # 5. registrazioni di processo: il nome del file è il PID, non l'id sessione
    sess = CLAUDE / "sessions"
    if sess.is_dir():
        for f in sess.glob("*.json"):
            try:
                if json.loads(f.read_text()).get("sessionId") == sid:
                    add(f, "registrazione di processo")
                    for k in sess.glob(f"{f.stem}.*.key"):
                        add(k, "chiave della registrazione")
            except Exception:
                continue

    # 6. scratchpad temporanei, una cartella per sessione sotto ogni progetto
    if TMP_ROOT.is_dir():
        for d in TMP_ROOT.glob(f"*/{sid}"):
            add(d, "scratchpad temporaneo")

    return voci


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("sessione", help="id completo della sessione")
    ap.add_argument("--apply", action="store_true", help="rimuove davvero")
    ap.add_argument("--json", action="store_true", help="output per l'estensione")
    ap.add_argument("--definitivo", action="store_true",
                    help="cancella invece di spostare nel cestino")
    args = ap.parse_args()

    sid = args.sessione
    # L'id finisce dentro percorsi che vengono poi cancellati: senza questo
    # controllo un "../../Documenti" costruirebbe un rmtree fuori da ~/.claude.
    if not re.fullmatch(r"[0-9a-fA-F-]{8,64}", sid):
        print("id sessione non valido", file=sys.stderr)
        return 2

    voci = trova(sid)
    totale = sum(v["byte"] for v in voci)

    if args.json and not args.apply:
        json.dump({"sessione": sid, "voci": voci, "byteTotali": totale,
                   "eseguito": False}, sys.stdout, ensure_ascii=False)
        print()

    if not voci:
        if not args.json:
            print(f"Nessuna traccia di {sid[:8]} sul disco.")
        return 0

    if not args.json:
        print(f"Sessione {sid}")
        print(f"{len(voci)} elementi · {totale/1048576:.1f} MB\n")
        for v in sorted(voci, key=lambda v: -v["byte"]):
            print(f"  {v['byte']/1048576:7.2f} MB  {v['cosa']}")
            print(f"              {v['percorso']}")
        if not args.apply:
            print(f"\nNiente è stato toccato. Per rimuovere: "
                  f"session-purge.py {sid} --apply")

    if not args.apply:
        return 0

    errori = []
    for v in voci:
        p = Path(v["percorso"])
        if args.definitivo:
            try:
                shutil.rmtree(p) if p.is_dir() else p.unlink()
            except OSError as e:
                errori.append(f"{p}: {e}")
        else:
            ok, msg = nel_cestino(p)
            if not ok:
                errori.append(f"{p}: {msg}")

    if args.json:
        # Dopo le cancellazioni, non prima: altrimenti chi legge il JSON non
        # verrebbe mai a sapere di un errore.
        json.dump({"sessione": sid, "voci": voci, "byteTotali": totale,
                   "eseguito": True, "errori": errori,
                   "rimossi": len(voci) - len(errori)},
                  sys.stdout, ensure_ascii=False)
        print()
    else:
        print(f"\nRimossi {len(voci)-len(errori)} elementi "
              f"({totale/1048576:.1f} MB).")
        for e in errori:
            print(f"  ⚠️ {e}")
    return 1 if errori else 0


if __name__ == "__main__":
    sys.exit(main())
