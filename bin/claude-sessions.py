#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 CiroBoxHub
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
import hashlib, json, os, sys, argparse
from datetime import datetime, timezone
from pathlib import Path

HOME = Path.home()
PROJECTS = HOME / ".claude" / "projects"

def testa(path: Path, quanti: int = 4096) -> str:
    """Impronta dei primi byte, per accorgersi che un file è stato riscritto.

    Una trascrizione si scrive in coda: la testa non cambia mai. Se cambia,
    qualcuno l'ha riscritta — `fix-cwd.py` e `project-relocate.py` lo fanno — e
    riprendere dalla metà darebbe conteggi vecchi mescolati a quelli nuovi.
    """
    try:
        with path.open("rb") as fh:
            return hashlib.sha256(fh.read(quanti)).hexdigest()[:16]
    except OSError:
        return ""


# Oltre questa soglia il contesto di una richiesta e' «grande»: la stessa che usa
# /usage nella sezione «What's contributing to your limits usage?», cosi' i
# consigli del pannello parlano la stessa lingua dei numeri di Claude Code.
CONTESTO_GRANDE = 150_000


def contesto(u: dict) -> int:
    """Token di contesto di una richiesta: quelli nuovi, letti e scritti in cache.

    Tutti e tre entrano nella finestra: la cache costa meno, ma il contesto
    che la richiesta si porta dietro e' la somma.
    """
    tot = 0
    for k in ("input_tokens", "cache_read_input_tokens",
              "cache_creation_input_tokens"):
        v = u.get(k)
        if isinstance(v, int):
            tot += v
    return tot


def scan_file(path: Path, da: dict | None = None) -> dict | None:
    """Estrae i metadati di una trascrizione.

    Si parsa ogni riga con json.loads: un'estrazione a regex qui sbaglia — nei
    record `assistant` il campo annidato "type":"message" precede quello
    esterno "type":"assistant".

    Con `da` si riparte da dove si era arrivati, sommando solo la coda nuova:
    la conversazione in corso arriva a decine di MB e cresce a ogni messaggio,
    quindi rileggerla intera a ogni giro è il costo che domina tutto il resto.
    Chi chiama garantisce che la testa del file non sia cambiata.
    """
    n_user = n_asst = 0
    first_ts = last_ts = None
    cwd = None
    entrypoint = None
    ai_title = custom_title = None
    n_req = n_grande = 0
    ultimo_mid = None
    inizio = 0
    if da:
        n_user = da.get("n_user", 0)
        n_asst = da.get("n_asst", 0)
        first_ts = da.get("first")
        last_ts = da.get("last")
        cwd = da.get("cwd")
        entrypoint = da.get("entrypoint")
        n_req = da.get("n_req", 0)
        n_grande = da.get("n_grande", 0)
        ultimo_mid = da.get("ultimo_mid")
        custom_title = da.get("title")
        inizio = da.get("offset", 0)
    try:
        with path.open("rb") as fh:
            if inizio:
                fh.seek(inizio)
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
                    # Una richiesta all'API e' un messaggio, ma il messaggio
                    # occupa una riga per blocco di contenuto, tutte con lo
                    # stesso id e una dopo l'altra. Si conta al primo.
                    m = d.get("message")
                    u = m.get("usage") if isinstance(m, dict) else None
                    mid = m.get("id") if isinstance(m, dict) else None
                    if isinstance(u, dict) and mid and mid != ultimo_mid:
                        ultimo_mid = mid
                        n_req += 1
                        if contesto(u) > CONTESTO_GRANDE:
                            n_grande += 1
                else:
                    continue
                ts = d.get("timestamp")
                if ts:
                    if first_ts is None:
                        first_ts = ts
                    last_ts = ts
                if cwd is None and d.get("cwd"):
                    cwd = d["cwd"]
                # Chi ha avviato la sessione: `cli` e' una persona al
                # terminale, `sdk-*` un programma. Serve a orfane_automatiche().
                if entrypoint is None and d.get("entrypoint"):
                    entrypoint = d["entrypoint"]
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
        "entrypoint": entrypoint,
        "n_user": n_user,
        "n_asst": n_asst,
        "n_msg": n_user + n_asst,
        "n_req": n_req,
        "n_grande": n_grande,
        # Serve alla lettura incrementale: se riparte a meta' di un messaggio,
        # la riga che trova ha lo stesso id e non e' una richiesta nuova.
        "ultimo_mid": ultimo_mid,
        "first": first_ts,
        "last": last_ts,
        "bytes": st.st_size,
        # Fin dove si è letto: il prossimo giro riparte da qui invece di
        # rileggere tutto.
        "offset": st.st_size,
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
CACHE_VERSIONE = 4

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
        s = None
        if dati and voce.get("impronta") == impronta:
            s = dict(dati)
            s["file"] = f
        elif (dati and voce.get("testa") and dati.get("offset")
              and st.st_size > dati["offset"]
              and voce["testa"] == testa(f)):
            # Il file e' cresciuto e la testa e' la stessa: e' stato scritto in
            # coda, si somma solo la parte nuova. Se la testa fosse cambiata
            # sarebbe una riscrittura, e ripartire da meta' mescolerebbe
            # conteggi vecchi e nuovi.
            s = scan_file(f, da=dati)
        if s is None:
            s = scan_file(f)
        if s:
            voce = {"impronta": impronta, "testa": testa(f),
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


def inventario(sessions: list[dict] | None = None) -> tuple[list, list, list]:
    """(conversazioni vere, duplicati, scarti).

    Sta qui e non dentro main() perché la usa anche collect-metrics.py, che la
    chiama importando questo file invece di lanciarlo: il sottoprocesso costa
    0,085 s contro 0,004, e a una raccolta al minuto è la metà del conto.
    Duplicarla in due posti vorrebbe dire vederla divergere.

    Una sessione senza nemmeno una risposta dell'assistente non è una
    conversazione: sono gli scarti lasciati da invocazioni non interattive
    (statusline che chiama /usage, hook, script SDK). Si contano a parte,
    altrimenti seppelliscono il lavoro vero.

    Ma una trascrizione senza risposte scritta ADESSO non è uno scarto: è
    un'invocazione in corso — la nostra lettura della quota, che accende una
    CLI e la spegne un secondo dopo, oppure una sessione interattiva vera che
    ha già scritto la domanda e non ha ancora ricevuto risposta. Per qualunque
    controllo automatico le due sono identiche, quindi si aspetta.
    """
    if sessions is None:
        sessions = collect()
    adesso = datetime.now(timezone.utc).timestamp()
    stubs = [s for s in sessions
             if s["n_asst"] == 0 and adesso - s["mtime"] > ATTESA_SCARTO_S]
    real, dups = split_duplicates([s for s in sessions if s["n_asst"] > 0])
    return real, dups, stubs


def orfane_automatiche(sessions: list[dict]) -> list[dict]:
    """Conversazioni avviate da un programma in una cartella che non c'e' piu'.

    Il caso che l'ha fatta nascere, il 2026-10-03: skillspector lancia Claude
    in una cartella temporanea per ogni analisi e ne aveva lasciate 62, ognuna
    con la sua cartella in projects/ e la sua riga «fuori dai progetti».

    Servono tutte e due le condizioni. «Cartella sparita» da sola pescherebbe
    i backup voluti: le conversazioni interattive dei progetti persi con /tmp
    il 2026-09-02 si sono salvate solo perche' stavano li'. «Avviata da un
    programma» da sola pescherebbe le automazioni di progetti vivi. Senza
    entrypoint — trascrizioni di versioni vecchie — non si indovina.

    Le scritte da poco si aspettano, come per gli scarti: possono essere
    un'invocazione in corso. E quelle senza risposta sono gia' scarti: stanno
    in quell'elenco, non in due.
    """
    adesso = datetime.now(timezone.utc).timestamp()
    return [s for s in sessions
            if (s.get("entrypoint") or "").startswith("sdk-")
            and s["cwd"] and not Path(s["cwd"]).is_dir()
            and s["n_asst"] > 0
            and adesso - s["mtime"] > ATTESA_SCARTO_S]


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
    ap.add_argument("--orfane", action="store_true",
                    help="elenca i percorsi delle sessioni avviate da un "
                         "programma in cartelle che non esistono piu'")
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
    real, dups, stubs = inventario(sessions)

    if args.stubs:
        for s in stubs:
            print(s["file"])
        return 0

    if args.orfane:
        for s in orfane_automatiche(sessions):
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
