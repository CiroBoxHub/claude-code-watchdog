#!/usr/bin/env python3
"""Elenca (o rimuove) i dati Claude Code di un intero progetto.

    project-purge.py /percorso/progetto            elenca
    project-purge.py /percorso/progetto --json     elenco per l'estensione
    project-purge.py /percorso/progetto --apply    sposta nel cestino
    project-purge.py /percorso/progetto --apply --definitivo   cancella

COSA RIMUOVE: solo i dati che Claude Code tiene per proprio conto —
trascrizioni, memorie del progetto, job, variabili d'ambiente, cronologia
modifiche, scratchpad temporanei.

COSA NON TOCCA MAI: la cartella di lavoro. Lì ci sono i file veri — PDF,
moduli, codice — e non è roba di Claude Code. Chi vuole cancellare anche
quella lo fa a mano, guardandola prima.
"""
import json, os, shutil, subprocess, sys, argparse

sys.dont_write_bytecode = True  # niente __pycache__ nel progetto
from pathlib import Path

HOME = Path.home()
CLAUDE = HOME / ".claude"
PROJECTS = CLAUDE / "projects"
TMP_ROOT = Path("/tmp") / f"claude-{HOME.stat().st_uid}"


def dim(p: Path) -> int:
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


def cwd_del_file(f: Path) -> str | None:
    """Il percorso di lavoro di UNA trascrizione.

    Il nome della cartella non serve: la codifica è cambiata tra le versioni
    di Claude Code e non è invertibile.
    """
    try:
        for riga in f.open("rb"):
            try:
                d = json.loads(riga)
            except Exception:
                continue
            if isinstance(d, dict) and d.get("cwd"):
                return d["cwd"]
    except OSError:
        pass
    return None


def trova(cwd: str) -> dict:
    cwd = os.path.realpath(cwd)
    voci = []
    sessioni = []

    def add(p: Path, cosa: str):
        if p.exists():
            voci.append({"percorso": str(p), "cosa": cosa, "byte": dim(p),
                         "tipo": "cartella" if p.is_dir() else "file"})

    # ATTENZIONE: una cartella di projects/ può contenere sessioni di cwd
    # DIVERSI — succede quando un progetto viene spostato e Claude Code
    # continua a scrivere nella cartella vecchia. Su questa macchina
    # `posta-aziendale` ne contiene tre. Abbinare per cartella, come si
    # faceva prima, cancellava le sessioni degli altri progetti insieme.
    for d in sorted(PROJECTS.iterdir()) if PROJECTS.is_dir() else []:
        if not d.is_dir():
            continue
        miei, altrui = [], []
        for f in d.glob("*.jsonl"):
            (miei if cwd_del_file(f) == cwd else altrui).append(f)
        if not miei:
            continue
        sessioni.extend(f.stem for f in miei)

        mem = d / "memory"
        n_mem = len(list(mem.glob("*"))) if mem.is_dir() else 0

        if altrui:
            # La cartella ospita anche altri: si tolgono solo le trascrizioni
            # proprie, e memory/ resta perché è condivisa.
            for f in miei:
                add(f, f"trascrizione in {d.name}")
        else:
            etichetta = f"trascrizioni ({len(miei)} sessioni)"
            if n_mem:
                etichetta += f" e memorie del progetto ({n_mem} voci)"
            add(d, etichetta)

    for sid in sessioni:
        add(CLAUDE / "session-env" / sid, "variabili d'ambiente")
        add(CLAUDE / "file-history" / sid, "cronologia modifiche")
        for t in TMP_ROOT.glob(f"*/{sid}"):
            add(t, "scratchpad temporaneo")

    jobs = CLAUDE / "jobs"
    if jobs.is_dir():
        for j in jobs.iterdir():
            if not j.is_dir():
                continue
            try:
                st = json.loads((j / "state.json").read_text())
            except Exception:
                continue
            # Il job si abbina per sessione o per cwd, ma il cwd va
            # normalizzato prima o un percorso equivalente non combacia.
            job_cwd = st.get("cwd")
            if st.get("sessionId") in sessioni or (
                    job_cwd and os.path.realpath(job_cwd) == cwd):
                add(j, f"job in background ({j.name})")

    visti = set()
    puliti = []
    for v in sorted(voci, key=lambda v: len(v["percorso"])):
        if any(v["percorso"].startswith(pp + "/") for pp in visti):
            continue
        visti.add(v["percorso"])
        puliti.append(v)

    return {"cwd": cwd, "sessioni": sessioni, "voci": puliti,
            "byteTotali": sum(v["byte"] for v in puliti),
            "cartellaLavoroEsiste": Path(cwd).is_dir()}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cwd", help="percorso di lavoro del progetto")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--definitivo", action="store_true",
                    help="cancella invece di spostare nel cestino")
    args = ap.parse_args()

    args.cwd = os.path.realpath(args.cwd)
    ris = trova(args.cwd)
    ris["eseguito"] = args.apply

    if args.json and not args.apply:
        json.dump(ris, sys.stdout, ensure_ascii=False)
        print()
    elif not args.json:
        print(f"Progetto {args.cwd}")
        print(f"{len(ris['sessioni'])} sessioni · {len(ris['voci'])} elementi · "
              f"{ris['byteTotali']/1048576:.1f} MB\n")
        for v in sorted(ris["voci"], key=lambda v: -v["byte"]):
            print(f"  {v['byte']/1048576:7.2f} MB  {v['cosa']}")
            print(f"              {v['percorso']}")
        print(f"\nLa cartella di lavoro {args.cwd} NON viene toccata.")
        if not args.apply:
            print(f"Per rimuovere: project-purge.py {args.cwd} --apply")

    if not args.apply:
        return 0

    errori = []
    for v in ris["voci"]:
        p = Path(v["percorso"])
        # Rete di sicurezza: qualunque cosa dentro la cartella di lavoro non si
        # tocca, per nessun motivo. Un errore di percorso qui cancellerebbe
        # lavoro vero.
        if str(p) == args.cwd or str(p).startswith(args.cwd.rstrip("/") + "/"):
            errori.append(f"saltato (dentro la cartella di lavoro): {p}")
            continue
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
        # L'esito va emesso DOPO le cancellazioni: emetterlo prima nascondeva
        # gli errori a chi legge il JSON.
        ris["errori"] = errori
        ris["rimossi"] = len(ris["voci"]) - len(errori)
        json.dump(ris, sys.stdout, ensure_ascii=False)
        print()
    else:
        print(f"\nRimossi {len(ris['voci'])-len(errori)} elementi.")
        for e in errori:
            print(f"  ⚠️ {e}")
    return 1 if errori else 0


if __name__ == "__main__":
    sys.exit(main())
