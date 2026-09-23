#!/usr/bin/env python3
"""Inventario delle sessioni Claude Code.

Legge ~/.claude/projects/**/*.jsonl e produce una tabella markdown con, per
ogni sessione: titolo, progetto, date, numero di messaggi, dimensione e il
comando per riprenderla.

Il progetto NON viene dedotto dal nome della cartella: quella codifica è
cambiata tra le versioni di Claude Code (cliente_alfa è diventato
cliente-alfa) e non è invertibile. Si usa il campo `cwd` scritto dentro la
trascrizione, che è il percorso reale.

SOLA LETTURA sui dati di Claude: non ne tocca nessuno. Scrive soltanto
la propria cache dei metadati sotto ~/.cache, che e' rigenerabile —
cancellarla costa una lettura in piu', non un dato.
"""
import json, os, sys, argparse
from datetime import datetime, timezone
from pathlib import Path

HOME = Path.home()
PROJECTS = HOME / ".claude" / "projects"

def scan_file(path: Path) -> dict | None:
    """Estrae i metadati di una trascrizione.

    Si parsa ogni riga con json.loads: sull'intera cartella costa meno di un
    secondo, e un'estrazione a regex qui sbaglia — nei record `assistant` il
    campo annidato "type":"message" precede quello esterno "type":"assistant".
    """
    n_user = n_asst = 0
    first_ts = last_ts = None
    cwd = None
    ai_title = custom_title = None
    try:
        with path.open("rb") as fh:
            for raw in fh:
                try:
                    d = json.loads(raw)
                except Exception:
                    continue
                if not isinstance(d, dict):
                    continue
                t = d.get("type")
                if t == "ai-title":
                    ai_title = d.get("aiTitle") or ai_title
                    continue
                if t == "custom-title":
                    custom_title = d.get("customTitle") or custom_title
                    continue
                if t == "user":
                    n_user += 1
                elif t == "assistant":
                    n_asst += 1
                else:
                    continue
                ts = d.get("timestamp")
                if ts:
                    if first_ts is None:
                        first_ts = ts
                    last_ts = ts
                if cwd is None and d.get("cwd"):
                    cwd = d["cwd"]
    except OSError as e:
        print(f"  (illeggibile: {path.name}: {e})", file=sys.stderr)
        return None

    if n_user == 0 and n_asst == 0:
        return None  # file di soli metadati, non una vera conversazione

    st = path.stat()
    return {
        "id": path.stem,
        "file": path,
        # un titolo messo a mano dall'utente vale più di quello generato
        "title": custom_title or ai_title,
        "cwd": cwd,
        "n_user": n_user,
        "n_asst": n_asst,
        "n_msg": n_user + n_asst,
        "first": first_ts,
        "last": last_ts,
        "bytes": st.st_size,
        "mtime": st.st_mtime,
        "folder": path.parent.name,
    }


# Cache dei metadati per file. Le trascrizioni si scrivono in coda: una
# conversazione chiusa non cambia più, ma senza cache si riparsa a ogni giro —
# qui sono 70 MB e 24.600 righe ogni dieci minuti, per riottenere gli stessi
# numeri. Sta in ~/.cache perché è materiale rigenerabile: cancellarla costa
# una lettura in più, non un dato.
CACHE = (Path(os.environ.get("XDG_CACHE_HOME") or (HOME / ".cache"))
         / "claude-code-watchdog" / "sessioni.json")
# Da alzare quando scan_file cambia cosa restituisce: una cache scritta dalla
# versione precedente contiene campi vecchi, e riusarla darebbe numeri
# sbagliati senza che niente segnali l'errore.
CACHE_VERSIONE = 1

# Quanto si aspetta prima di dire che una trascrizione senza risposte è uno
# scarto. Due minuti: la lettura della quota ne impiega due o tre secondi, una
# sessione interattiva può metterci molto di più a ricevere la prima risposta.
ATTESA_SCARTO_S = 120


def _cache_leggi() -> dict:
    try:
        d = json.loads(CACHE.read_text())
        if not isinstance(d, dict) or d.get("versione") != CACHE_VERSIONE:
            return {}
        voci = d.get("voci")
        # Anche la forma va controllata, non solo la versione: un file scritto
        # a meta', modificato a mano o prodotto da una versione che ha scordato
        # di alzare CACHE_VERSIONE puo' essere JSON valido e struttura
        # sbagliata. Senza questo, `[]` al posto dell'oggetto faceva saltare
        # l'intero inventario — `--stubs` compreso, da cui dipendono reclaim.py
        # e clean.sh.
        return voci if isinstance(voci, dict) else {}
    except Exception:
        return {}


def _cache_scrivi(voci: dict) -> None:
    """Scrive la cache senza lasciarla a metà se il processo muore.

    Su file temporaneo e poi rename, che è atomico: un JSON troncato verrebbe
    scartato al giro dopo, ma meglio non produrlo affatto.
    """
    try:
        CACHE.parent.mkdir(parents=True, exist_ok=True)
        CACHE.parent.chmod(0o700)
        # Nome temporaneo per processo: due esecuzioni in parallelo — il
        # giro dell'estensione e una invocazione a mano — scriverebbero lo
        # stesso file e una rinominerebbe il buffer a meta' dell'altra.
        tmp = CACHE.with_suffix(f".{os.getpid()}.tmp")
        try:
            tmp.write_text(json.dumps({"versione": CACHE_VERSIONE, "voci": voci}))
            tmp.chmod(0o600)
            tmp.replace(CACHE)
        except BaseException:
            # Col nome per pid, un temporaneo abbandonato non verrebbe mai
            # riusato ne' potato da nessuno: si toglie subito.
            tmp.unlink(missing_ok=True)
            raise
    except OSError:
        # Una cache che non si scrive non è un errore: si riparsa e basta.
        pass


def collect(usa_cache: bool = True) -> list[dict]:
    if not PROJECTS.is_dir():
        return []
    vecchia = _cache_leggi() if usa_cache else {}
    nuova = {}
    out = []
    # glob e non rglob: rglob pesca anche <sessione>/subagents/agent-*.jsonl,
    # che hanno risposte dell'assistente ma non sono conversazioni — hanno id
    # che `claude -r` non sa riprendere e gonfiano tutti i conteggi.
    for f in PROJECTS.glob("*/*.jsonl"):
        try:
            st = f.stat()
        except OSError:
            continue
        chiave = str(f)
        # Dimensione E data di modifica: la sola data non basta se due
        # scritture cadono nello stesso nanosecondo, la sola dimensione non
        # basta se una riga ne sostituisce un'altra di pari lunghezza.
        impronta = [st.st_mtime_ns, st.st_size]
        voce = vecchia.get(chiave)
        dati = voce.get("dati") if isinstance(voce, dict) else None
        # `dati` si legge con get: una cache scritta a meta', modificata a
        # mano o da una versione che ha scordato di alzare CACHE_VERSIONE
        # farebbe saltare l'intero inventario — compreso `--stubs`, da cui
        # dipendono reclaim.py e clean.sh. Mancando, si riparsa.
        if dati and voce.get("impronta") == impronta:
            s = dict(dati)
            s["file"] = f
        else:
            s = scan_file(f)
            if s:
                voce = {"impronta": impronta,
                        "dati": {k: (str(v) if isinstance(v, Path) else v)
                                 for k, v in s.items()}}
        if s:
            out.append(s)
            if voce:
                # Solo i file visti adesso: così la cache non conserva
                # trascrizioni cancellate e non cresce senza fine.
                nuova[chiave] = voce
    if usa_cache:
        _cache_scrivi(nuova)
    out.sort(key=lambda s: s["mtime"], reverse=True)
    return out


def human(n: int) -> str:
    for unit in ("B", "K", "M", "G"):
        if n < 1024 or unit == "G":
            return f"{n:.0f}{unit}" if unit == "B" else f"{n:.1f}{unit}"
        n /= 1024
    return f"{n:.1f}G"


def day(ts: str | None) -> str:
    return ts[:10] if ts else "?"


def age_days(mtime: float) -> int:
    return int((datetime.now(timezone.utc).timestamp() - mtime) / 86400)


def split_duplicates(sessions: list[dict]) -> tuple[list[dict], list[dict]]:
    """Separa le copie della stessa sessione presenti in più cartelle progetto.

    Quando un progetto viene spostato (tipicamente da /tmp a una cartella
    stabile) Claude Code ricrea la cartella con il nuovo percorso e la vecchia
    resta: la stessa trascrizione finisce in due posti, byte per byte identica.
    Si tiene la copia che sta nella cartella corrispondente al `cwd` reale,
    l'altra va nell'elenco dei duplicati.
    """
    by_id: dict[str, list[dict]] = {}
    for s in sessions:
        by_id.setdefault(s["id"], []).append(s)
    keep, dups = [], []
    for rows in by_id.values():
        if len(rows) == 1:
            keep.append(rows[0])
            continue
        # preferisci la copia più recente in una cartella che esiste ancora
        rows.sort(key=lambda r: (Path(r["cwd"] or "/nonesiste").is_dir(),
                                 r["mtime"]), reverse=True)
        keep.append(rows[0])
        dups.extend(rows[1:])
    return keep, dups


def _ser(s: dict) -> dict:
    return {k: (str(v) if isinstance(v, Path) else v) for k, v in s.items()}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--format", choices=("table", "json"), default="table")
    ap.add_argument("--min-msg", type=int, default=0,
                    help="mostra solo sessioni con almeno N messaggi")
    ap.add_argument("--older-than", type=int, metavar="GIORNI",
                    help="mostra solo sessioni non toccate da più di N giorni")
    ap.add_argument("--stubs", action="store_true",
                    help="elenca i percorsi delle sole sessioni-fantasma, "
                         "uno per riga (per darli in pasto alla pulizia)")
    args = ap.parse_args()

    sessions = collect()
    if args.older_than is not None:
        sessions = [s for s in sessions if age_days(s["mtime"]) > args.older_than]
    sessions = [s for s in sessions if s["n_msg"] >= args.min_msg]

    # Una sessione senza nemmeno una risposta dell'assistente non è una
    # conversazione: sono gli scarti lasciati da invocazioni non interattive
    # (statusline che chiama /usage, hook, script SDK). Si contano a parte,
    # altrimenti seppelliscono il lavoro vero.
    # Una trascrizione senza risposte dell'assistente ma scritta ADESSO non è
    # uno scarto: è un'invocazione in corso. Può essere la nostra lettura della
    # quota, che accende una CLI e la spegne un secondo dopo — nel pannello si
    # vedeva «1 sessione fantasma» comparire e sparire a ogni aggiornamento —
    # oppure una sessione interattiva vera che ha già scritto la domanda e non
    # ha ancora ricevuto risposta. Per qualunque controllo automatico le due
    # sono identiche, quindi si aspetta.
    adesso = datetime.now(timezone.utc).timestamp()
    stubs = [s for s in sessions
             if s["n_asst"] == 0 and adesso - s["mtime"] > ATTESA_SCARTO_S]
    real, dups = split_duplicates([s for s in sessions if s["n_asst"] > 0])

    if args.stubs:
        for s in stubs:
            print(s["file"])
        return 0

    if args.format == "json":
        json.dump({"reali": [_ser(s) for s in real],
                   "duplicati": [_ser(s) for s in dups],
                   "fantasma": [_ser(s) for s in stubs]},
                  sys.stdout, indent=2, ensure_ascii=False)
        print()
        return 0

    if not real and not stubs and not dups:
        print("_Nessuna sessione trovata._")
        return 0

    by_proj: dict[str, list[dict]] = {}
    for s in real:
        by_proj.setdefault(s["cwd"] or "(cwd sconosciuta)", []).append(s)

    total_b = sum(s["bytes"] for s in real)
    total_m = sum(s["n_msg"] for s in real)
    print(f"**{len(real)} conversazioni** in **{len(by_proj)} progetti** · "
          f"{total_m} messaggi · {human(total_b)} su disco")
    extra = []
    if dups:
        extra.append(f"{len(dups)} copie doppie da "
                     f"{human(sum(s['bytes'] for s in dups))}")
    if stubs:
        extra.append(f"{len(stubs)} sessioni-fantasma da "
                     f"{human(sum(s['bytes'] for s in stubs))}")
    if extra:
        print(f"\n_(più {' e '.join(extra)} — vedi in fondo)_")

    for proj in sorted(by_proj, key=lambda p: max(s["mtime"] for s in by_proj[p]),
                       reverse=True):
        rows = by_proj[proj]
        exists = Path(proj).is_dir() if proj.startswith("/") else False
        flag = "" if exists else "  ⚠️ _cartella non esiste più_"
        print(f"\n#### `{proj}`{flag}")
        print("\n| Titolo | Ultimo uso | Msg | Peso | Riprendi |")
        print("|---|---|---|---|---|")
        for s in rows:
            t = s["title"] or "_senza titolo_"
            if len(t) > 46:
                t = t[:45] + "…"
            print(f"| {t} | {day(s['last'])} | {s['n_msg']} | "
                  f"{human(s['bytes'])} | `claude -r {s['id'][:8]}` |")

    if dups:
        print("\n#### Trascrizioni duplicate\n")
        print("La stessa sessione in due cartelle progetto: succede quando il "
              "progetto viene spostato di posto. Le copie sono identiche byte "
              "per byte, ma **possono essere backup voluti** — controlla prima "
              "di eliminarle.\n")
        print("| Sessione | Copia superflua in | Peso |")
        print("|---|---|---|")
        for s_ in sorted(dups, key=lambda r: -r["bytes"]):
            t = s_["title"] or s_["id"][:8]
            if len(t) > 40:
                t = t[:39] + "…"
            print(f"| {t} | `{s_['folder']}` | {human(s_['bytes'])} |")

    if stubs:
        by_sp: dict[str, list[dict]] = {}
        for s in stubs:
            by_sp.setdefault(s["cwd"] or "(cwd sconosciuta)", []).append(s)
        print("\n#### Sessioni-fantasma\n")
        print("Trascrizioni senza nessuna risposta dell'assistente: scarti di "
              "invocazioni non interattive (statusline, hook, script SDK). "
              "Si rigenerano da sole, eliminarle non perde niente.\n")
        print("| Cartella | Quante | Peso | Più vecchia |")
        print("|---|---|---|---|")
        for proj, rows in sorted(by_sp.items(),
                                 key=lambda kv: -sum(r["bytes"] for r in kv[1])):
            print(f"| `{proj}` | {len(rows)} | "
                  f"{human(sum(r['bytes'] for r in rows))} | "
                  f"{max(age_days(r['mtime']) for r in rows)} gg fa |")

    print("\n_Per riprendere: `cd` nella cartella del progetto, poi il comando "
          "in tabella._")
    return 0


if __name__ == "__main__":
    sys.exit(main())
