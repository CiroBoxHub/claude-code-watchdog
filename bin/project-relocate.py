#!/usr/bin/env python3
"""Riaggancia le sessioni di un progetto a una cartella spostata.

    project-relocate.py <vecchia-cwd> <nuova-cartella>            verifica
    project-relocate.py <vecchia-cwd> <nuova-cartella> --json     per l'estensione
    project-relocate.py <vecchia-cwd> <nuova-cartella> --apply    esegue

Quando una cartella di lavoro viene spostata, le sue conversazioni restano
legate al percorso vecchio: `claude --resume` dalla nuova posizione non le
trova, perché Claude Code cerca in una cartella di ~/.claude/projects/ il cui
nome deriva dalla cwd.

LA VERIFICA NON SI FIDA DEL NOME. Le trascrizioni citano i file su cui si è
lavorato: si controlla quanti di quelli esistono davvero nella cartella
candidata. È l'unica prova che dice «è lo stesso progetto» invece di «si chiama
uguale».

Gli originali finiscono nel cestino, non cancellati.
"""
import json, os, re, subprocess, sys, argparse
from pathlib import Path

HOME = Path.home()
PROJECTS = HOME / ".claude" / "projects"
JOBS = HOME / ".claude" / "jobs"



def scrivi_atomico(destinazione: Path, testo: str) -> None:
    """Scrive su file temporaneo accanto alla destinazione, poi rinomina.

    `write_text` diretto non è atomico: un'interruzione a metà lascia una
    trascrizione troncata, cioè una conversazione persa a pezzi. Il rename
    dentro la stessa cartella — quindi lo stesso filesystem — o riesce del
    tutto o non fa niente. Il nome porta il pid: due esecuzioni in parallelo
    non devono contendersi lo stesso temporaneo.
    """
    tmp = destinazione.with_name(f"{destinazione.name}.{os.getpid()}.tmp")
    try:
        tmp.write_text(testo)
        tmp.replace(destinazione)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise

def codifica(percorso: str) -> str:
    """Nome cartella di projects/ per una cwd.

    Verificato il 2026-09-17 su tutte le cartelle non ambigue di questa
    macchina: ogni carattere non alfanumerico diventa un trattino.
    """
    return re.sub(r"[^A-Za-z0-9-]", "-", percorso)


def nel_cestino(p: Path) -> tuple[bool, str]:
    try:
        r = subprocess.run(["gio", "trash", str(p)], capture_output=True,
                           text=True, timeout=30)
        return (r.returncode == 0), (r.stderr or "").strip()
    except (OSError, subprocess.SubprocessError) as e:
        return False, str(e)


def trascrizioni_di(cwd: str) -> list[Path]:
    out = []
    if not PROJECTS.is_dir():
        return out
    for f in PROJECTS.glob("*/*.jsonl"):
        try:
            for riga in f.open("rb"):
                try:
                    d = json.loads(riga)
                except Exception:
                    continue
                if isinstance(d, dict) and d.get("cwd"):
                    if d["cwd"] == cwd:
                        out.append(f)
                    break
        except OSError:
            continue
    return out


def file_citati(files: list[Path], cwd: str) -> set[str]:
    """Percorsi relativi citati nelle trascrizioni, sotto la vecchia cwd."""
    # Niente spazi nel pattern: includendoli il match si porta dietro le
    # parole della frase che segue il nome del file.
    rx = re.compile(re.escape(cwd) + r"/[\w./-]+")
    visti = set()
    for f in files:
        try:
            for riga in f.open("rb"):
                for m in rx.findall(riga.decode("utf-8", "replace")):
                    rel = m[len(cwd) + 1:].rstrip("./")
                    # si scartano i frammenti troppo corti o senza estensione:
                    # sono quasi sempre pezzi di frase, non nomi di file
                    if len(rel) > 2 and "." in Path(rel).name:
                        visti.add(rel)
        except OSError:
            continue
    return visti


def verifica(cwd: str, nuova: str) -> dict:
    nuova = os.path.realpath(nuova)
    files = trascrizioni_di(cwd)
    citati = file_citati(files, cwd)
    trovati = sorted(r for r in citati if (Path(nuova) / r).exists())
    mancanti = sorted(citati - set(trovati))

    esiste = Path(nuova).is_dir()
    stesso_nome = Path(cwd).name == Path(nuova).name

    # Il verdetto pesa le prove: un file ritrovato vale più di un nome uguale.
    if not esiste:
        verdetto, motivo = "no", "La cartella indicata non esiste."
    elif trovati:
        verdetto = "sicuro"
        motivo = (f"{len(trovati)} file citati nelle conversazioni esistono qui"
                  + (" e il nome coincide." if stesso_nome else "."))
    elif not citati:
        verdetto = "incerto"
        motivo = ("Le conversazioni non citano file, quindi non c'è modo di "
                  + ("verificare. Il nome però coincide." if stesso_nome
                     else "verificare, e il nome è diverso."))
    elif stesso_nome:
        verdetto = "incerto"
        motivo = (f"Nessuno dei {len(citati)} file citati si trova qui, "
                  "ma il nome della cartella coincide.")
    else:
        verdetto = "no"
        motivo = (f"Nessuno dei {len(citati)} file citati si trova qui e il "
                  "nome è diverso: probabilmente non è questo il progetto.")

    return {
        "vecchia": cwd, "nuova": nuova, "esiste": esiste,
        "stessoNome": stesso_nome,
        "sessioni": [f.stem for f in files],
        "trascrizioni": [str(f) for f in files],
        "citati": len(citati), "trovati": trovati[:10],
        "mancanti": mancanti[:10],
        "verdetto": verdetto, "motivo": motivo,
        "cartellaDestinazione": str(PROJECTS / codifica(nuova)),
    }


def sposta(ris: dict) -> tuple[list[str], int]:
    """Riscrive la cwd e porta le trascrizioni nella cartella nuova.

    Ritorna (errori, quante spostate davvero): annunciare il numero di sessioni
    *trovate* farebbe dire «riagganciate N» anche quando non se n'è mossa
    nessuna.
    """
    errori = []
    spostate = 0
    dest = Path(ris["cartellaDestinazione"])
    vecchia, nuova = ris["vecchia"], ris["nuova"]
    try:
        dest.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        return [f"{dest}: {e}"], 0

    for s in ris["trascrizioni"]:
        orig = Path(s)
        arrivo = dest / orig.name
        if arrivo.exists():
            errori.append(f"{arrivo}: esiste già, saltata")
            continue
        try:
            righe = []
            for riga in orig.open("rb"):
                try:
                    d = json.loads(riga)
                except Exception:
                    righe.append(riga.decode("utf-8", "replace").rstrip("\n"))
                    continue
                if isinstance(d, dict) and d.get("cwd") == vecchia:
                    d["cwd"] = nuova
                righe.append(json.dumps(d, ensure_ascii=False))
            scrivi_atomico(arrivo, "\n".join(righe) + "\n")
        except OSError as e:
            errori.append(f"{orig}: {e}")
            continue
        # L'originale va nel cestino solo dopo che la copia è a posto.
        ok, msg = nel_cestino(orig)
        if not ok:
            errori.append(f"{orig}: non spostata nel cestino ({msg})")
        else:
            spostate += 1

    # I job registrano la cwd nel loro state.json: va allineata.
    if JOBS.is_dir():
        for j in JOBS.iterdir():
            st = j / "state.json"
            if not st.is_file():
                continue
            try:
                d = json.loads(st.read_text())
                if d.get("cwd") == vecchia:
                    d["cwd"] = nuova
                    st.write_text(json.dumps(d, ensure_ascii=False, indent=1))
            except (OSError, ValueError) as e:
                errori.append(f"{st}: {e}")
    return errori, spostate


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("vecchia")
    ap.add_argument("nuova")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--forza", action="store_true",
                    help="esegue anche con verdetto «no»")
    args = ap.parse_args()

    ris = verifica(args.vecchia, args.nuova)

    if args.apply:
        if ris["verdetto"] == "no" and not args.forza:
            ris["errori"] = [f"rifiutato: {ris['motivo']}"]
            ris["eseguito"] = False
        else:
            ris["errori"], ris["spostate"] = sposta(ris)
            ris["eseguito"] = ris["spostate"] > 0

    if args.json:
        json.dump(ris, sys.stdout, ensure_ascii=False)
        print()
        return 1 if ris.get("errori") else 0

    simbolo = {"sicuro": "✓", "incerto": "?", "no": "✗"}[ris["verdetto"]]
    print(f"Da: {ris['vecchia']}")
    print(f"A:  {ris['nuova']}")
    print(f"\n{simbolo} {ris['verdetto'].upper()} — {ris['motivo']}\n")
    print(f"{len(ris['sessioni'])} sessioni · {ris['citati']} file citati nelle conversazioni")
    for r in ris["trovati"]:
        print(f"   trovato:  {r}")
    for r in ris["mancanti"][:5]:
        print(f"   assente:  {r}")
    print(f"\nLe trascrizioni andrebbero in:\n   {ris['cartellaDestinazione']}")
    if not args.apply:
        print(f"\nPer eseguire: project-relocate.py {args.vecchia!r} {args.nuova!r} --apply")
    else:
        if ris.get("errori"):
            print("\nProblemi:")
            for e in ris["errori"]:
                print(f"   ⚠️ {e}")
        elif ris.get("eseguito"):
            print(f"\nSpostate {ris['spostate']} trascrizioni. "
                  "Gli originali sono nel cestino.")
        else:
            print("\nNessuna trascrizione spostata.")
    return 1 if ris.get("errori") else 0


if __name__ == "__main__":
    sys.exit(main())
