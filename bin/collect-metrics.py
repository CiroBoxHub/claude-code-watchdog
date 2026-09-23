#!/usr/bin/env python3
"""Raccoglie le metriche per il cruscotto e le scrive in JSON.

Scrive due file sotto ~/.local/share/claude-code-watchdog/:
  metrics.json   la fotografia corrente, che l'estensione GNOME legge
  history.jsonl  una riga per esecuzione, per i grafici nel tempo

Deve restare veloce: lo lancia l'estensione a intervalli. Niente scansioni
dell'intera home, niente comandi che richiedono privilegi.
"""
import json, os, shutil, subprocess, sys, time
from datetime import datetime, timezone
from pathlib import Path

def _radici() -> tuple[Path | None, Path]:
    """(radice del progetto o None, cartella che contiene gli script).

    Questo file vive in due posti: `<progetto>/bin/` e, copiato, nella cartella
    dell'estensione GNOME dove gli script stanno tutti insieme e il progetto non
    c'è. Dedurre la radice come `parent.parent` funziona solo nel primo caso:
    nel secondo puntava alla cartella delle estensioni, e da lì non si trovava
    né watchdog.conf né claude-sessions.py — con l'effetto di riportare una
    macchina vuota senza dire niente a nessuno.
    """
    qui = Path(__file__).resolve().parent
    if (qui.parent / "config" / "watchdog.conf").is_file() and qui.name == "bin":
        return qui.parent, qui
    return None, qui


ROOT, SCRIPT_DIR = _radici()

# Le versioni vecchie di Claude Code e la coda delle segnalazioni le sa
# reclaim.py, che è anche chi le cestina. Importarlo invece di rifare il
# conto qui è l'unico modo perché il numero annunciato nel pannello e quello
# liberato dal pulsante coincidano.
sys.path.insert(0, str(SCRIPT_DIR))
try:
    import reclaim
except Exception as _e:  # pragma: no cover - dipende da come e' stato copiato
    # Se manca, le due voci che ne dipendono non compaiono e tutto il resto
    # continua a funzionare. Un raccoglitore che muore per una voce in piu'
    # lascerebbe il pannello senza nessun dato.
    reclaim = None
    print(f"reclaim.py non importabile, due voci non calcolate: {_e}",
          file=sys.stderr)
HOME = Path.home()
CLAUDE = HOME / ".claude"
OUT_DIR = Path(os.environ.get("XDG_DATA_HOME") or (HOME / ".local/share")) / "claude-code-watchdog"
METRICS = OUT_DIR / "metrics.json"
USAGE = OUT_DIR / "usage.json"
HISTORY = OUT_DIR / "history.jsonl"
# Tenere la storia illimitata farebbe crescere un file che nessuno pota:
# 2000 righe a un campione ogni 10 minuti sono circa due settimane.
HISTORY_MAX_LINES = 2000


def conf() -> dict:
    """Legge config/watchdog.conf senza eseguirlo (è un file bash)."""
    out = {}
    if ROOT is None:
        return out                      # copia nell'estensione: solo predefiniti
    f = ROOT / "config" / "watchdog.conf"
    if not f.exists():
        return out
    for line in f.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        v = v.split("#")[0].strip().strip('"').strip("'")
        out[k.strip()] = v
    return out


def du_mb(path: Path) -> int:
    if not path.exists():
        return 0
    try:
        r = subprocess.run(["du", "-sm", "--one-file-system", str(path)],
                           capture_output=True, text=True, timeout=30)
        return int(r.stdout.split()[0])
    except Exception:
        return 0


def stale_mb(path: Path, days: int) -> int:
    if not path.is_dir():
        return 0
    cutoff = time.time() - days * 86400
    total = 0
    for f in path.rglob("*"):
        try:
            st = f.stat()
        except OSError:
            continue
        if f.is_file() and st.st_mtime < cutoff:
            total += st.st_size
    return total // 1048576


def arg(nome: str) -> str | None:
    """Valore di un'opzione «--nome valore» sulla riga di comando, o None."""
    if nome in sys.argv:
        i = sys.argv.index(nome)
        if i + 1 < len(sys.argv):
            return sys.argv[i + 1]
    return None


CASA = None          # HOME risolta, calcolata una volta sola


def candidabile(cartella: Path) -> bool:
    """Se una cartella può essere la radice dei progetti.

    La home no: prenderla vorrebbe dire elencare Scaricati, Immagini e il
    resto come se fossero lavoro. `/tmp` no, ed è escluso come cartella e non
    come prefisso — `/tmp/lavoro` è una radice legittima quanto un'altra.

    E **niente che stia sopra la home**: `/home` e `/` non sono cartelle di
    progetti, ma contando ogni antenato entravano in gara, e a parità vincono
    perché sono le meno profonde. Con due progetti in `~/Documenti/Claude` e
    uno in `/home/lavoro/cliente`, `/home` faceva due «progetti» (`tizio` e
    `lavoro`) e vinceva: il pannello avrebbe elencato la home di ogni utente.

    La home si confronta **risolta**: i `cwd` nelle trascrizioni sono percorsi
    fisici, perché `getcwd` scioglie i collegamenti. Con `/home/tizio` che è
    un link a `/dati/tizio`, un `HOME` non risolto non combacia con nessun cwd
    e l'esclusione non scatta mai.
    """
    global CASA
    if CASA is None:
        try:
            CASA = HOME.resolve()
        except OSError:
            CASA = HOME
    if cartella in (HOME, CASA, Path("/"), Path("/tmp")):
        return False
    # Sopra la home: `/`, `/home`, e su qualche sistema anche di più.
    if cartella in CASA.parents:
        return False
    return True


def radice_progetti(esplicita: str | None, progetti: list[dict]) -> Path | None:
    """La cartella dove nascono i progetti nuovi, o None se non si sa.

    Due sorgenti, in quest'ordine. L'estensione passa `--radice-progetti`
    quando l'utente l'ha scritta nelle preferenze: quella vince sempre.
    Altrimenti si deduce dai progetti già noti, prendendo la cartella che ne
    contiene di più.

    La deduzione non è un lusso: nello schema dell'estensione il valore vuoto
    significa «rilevamento automatico», ed è il caso normale. Senza, la
    funzione risponderebbe None proprio a chi non ha configurato niente.

    Non si legge gsettings da qui. La regola di scelta sta in extension.js
    (`_radiceProgetti`), e riscriverla in Python vorrebbe dire vederla
    divergere senza accorgersene — è già successo con la codifica delle
    cartelle di ~/.claude/projects/.
    """
    if esplicita:
        p = Path(esplicita).expanduser()
        return p if p.is_dir() else None

    # Per ogni possibile radice si contano i PROGETTI che avrebbe: le sue
    # figlie dirette che contengono almeno un cwd. La radice e' quella che ne
    # ha di piu'.
    #
    # Contare i genitori dei cwd non basta, e le due versioni precedenti sono
    # cadute qui: `progetto/src` e `progetto/docs` fanno sembrare `progetto`
    # una radice con due progetti, e una sessione in `~/Documenti/Scaricati`
    # ne fa sembrare una `~/Documenti`. Contando i figli distinti, `progetto`
    # ne ha due (`src`, `docs`) ma anche `L` ne ha due (`a`, `b`) — e a parita'
    # vince la meno profonda, che e' quella giusta. Con `~/Documenti/Claude`
    # a quattro progetti e `~/Documenti` a due, vince Claude senza pareggi.
    progetti_per_radice: dict[Path, set[Path]] = {}
    for e in progetti:
        perc = e.get("percorso") or ""
        if not perc.startswith("/"):
            continue
        p = Path(perc)
        # Ogni antenato e' una radice possibile; il progetto che avrebbe sotto
        # e' la figlia diretta dell'antenato lungo questo percorso.
        figlia = p
        for antenato in p.parents:
            if candidabile(antenato):
                progetti_per_radice.setdefault(antenato, set()).add(figlia)
            figlia = antenato
    if not progetti_per_radice:
        return None

    # A parita' di progetti vince la meno profonda, e a parita' di profondita'
    # l'ordine alfabetico: due esecuzioni di fila devono dare la stessa
    # risposta, se no l'elenco cambia da un giro all'altro.
    migliore = max(progetti_per_radice,
                   key=lambda r: (len(progetti_per_radice[r]), -len(r.parts), str(r)))
    quanti = len(progetti_per_radice[migliore])
    # Un progetto solo non e' un indizio: con due progetti in due posti diversi
    # si sceglierebbe a sorte, e l'elenco cambierebbe da un giro all'altro.
    if quanti < 2 or not migliore.is_dir():
        return None
    return migliore


def cache_claude() -> tuple[int, str, int]:
    """(MB della cache di Claude Code, nome del pezzo piu' grosso, suoi MB).

    Solo le cartelle di Claude, non tutta ~/.cache: li' dentro il grosso e'
    sempre il browser, e un pannello che si chiama claude-code-watchdog non
    deve misurare la cache di Chrome. Se un giorno servisse la cache intera,
    e' un'altra estensione.

    Sono due: `claude/` (staging degli aggiornamenti) e `claude-cli-nodejs/`,
    che tiene i log degli MCP divisi per progetto.
    """
    cartelle = [HOME / ".cache/claude", HOME / ".cache/claude-cli-nodejs"]
    voci = []
    for d in cartelle:
        if d.is_dir():
            voci.append((du_mb(d), d.name))
    if not voci:
        return 0, "", 0
    voci.sort(reverse=True)
    return sum(m for m, _ in voci), voci[0][1], voci[0][0]


def dentro_radice(percorso: str, radice: Path | None) -> bool:
    """Se il progetto sta dentro la radice, a qualunque profondita'.

    Il confronto e' sui componenti del percorso e non sul prefisso testuale:
    con `radice = ~/Documenti/Claude`, la cartella `~/Documenti/Claude-vecchio`
    comincia con la stessa stringa ma non e' dentro niente.

    Profondita' qualunque, non solo figlia diretta: una sessione aperta in una
    sottocartella del progetto ha quel cwd, ed e' dentro la radice comunque.
    """
    if not radice:
        return False
    try:
        return Path(percorso) == radice or radice in Path(percorso).parents
    except (OSError, ValueError):
        return False


def nome_progetto(percorso: str, radice: Path | None) -> str:
    """Come si chiama un progetto nell'elenco.

    Il nome della cartella, salvo quando sta annidato dentro la radice: li'
    serve il percorso relativo, se no due sottocartelle «src» di progetti
    diversi comparirebbero come due righe chiamate uguale.
    """
    p = Path(percorso)
    if radice:
        try:
            rel = p.relative_to(radice)
            if len(rel.parts) > 1:
                return str(rel)
        except ValueError:
            pass
    return p.name or percorso


def problemi_progetto(cwd: str, cartelle_condivise: set[str]) -> list[dict]:
    """Cosa c'è che non va in un progetto, in forma leggibile.

    Non sono errori dello strumento: sono cose che l'utente vorrebbe sapere
    prima che diventino una perdita di lavoro.
    """
    out = []
    if not cwd:
        return [{"codice": "cwd-ignota", "testo":
                 "Non si riesce a risalire alla cartella di lavoro."}]

    if not Path(cwd).is_dir():
        out.append({"codice": "cartella-sparita", "testo":
                    f"La cartella di lavoro {cwd} non esiste più. "
                    "Le conversazioni restano leggibili, ma «Cartella» e "
                    "«Riprendi» non hanno dove andare."})
    elif cwd == "/tmp" or cwd.startswith("/tmp/"):
        # Su questa macchina è già successo: il 2026-09-02 un riavvio ha
        # portato via i file di lavoro di progetti che giravano da /tmp.
        out.append({"codice": "in-tmp", "testo":
                    "Il progetto lavora sotto /tmp, che il sistema svuota al "
                    "riavvio. I file di lavoro non sopravvivono; le "
                    "conversazioni sì, perché stanno in ~/.claude."})

    if cwd in cartelle_condivise:
        out.append({"codice": "cartella-condivisa", "testo":
                    "Le sue trascrizioni stanno in una cartella di "
                    "~/.claude/projects/ condivisa con altri progetti: succede "
                    "quando un progetto viene spostato. Eliminare i dati tocca "
                    "solo i file suoi, non l'intera cartella."})
    return out


def sessions() -> dict:
    """Delega a claude-sessions.py: la logica di lettura sta in un posto solo."""
    try:
        # Accanto a questo file, non sotto ROOT: nella copia dentro
        # l'estensione gli script stanno tutti nella stessa cartella.
        r = subprocess.run([sys.executable, str(SCRIPT_DIR / "claude-sessions.py"),
                            "--format", "json"],
                           capture_output=True, text=True, timeout=60)
        d = json.loads(r.stdout)
    except Exception as e:
        print(f"claude-sessions.py non eseguibile: {e}", file=sys.stderr)
        return {"conversazioni": 0, "messaggi": 0, "fantasma": 0, "duplicati": 0,
                "progetti": [], "mbTotali": 0}
    reali = d.get("reali", [])
    by_proj = {}
    for s in reali:
        p = s.get("cwd") or "?"
        e = by_proj.setdefault(p, {"nome": Path(p).name or p, "percorso": p,
                                   "mb": 0, "sessioni": 0, "messaggi": 0,
                                   "esiste": Path(p).is_dir()})
        e["mb"] += s["bytes"] / 1048576
        e["sessioni"] += 1
        e["messaggi"] += s["n_msg"]
    # Se ne emettono molti: l'estensione li divide in due sezioni (progetti e
    # fuori dai progetti) e applica lì il suo limite. Tagliare a 8 qui
    # significherebbe far competere le due sezioni per gli stessi posti.
    # A parità di peso si ordina per percorso: l'ordine di partenza è quello
    # del glob, che il filesystem non garantisce uguale fra due giri. Se
    # cambiasse, cambierebbe la firma delle righe e il pannello le
    # ridisegnerebbe tutte senza motivo.
    top = sorted(by_proj.values(), key=lambda e: (-e["mb"], e["percorso"]))[:40]
    for e in top:
        e["mb"] = round(e["mb"], 1)

    # Cartelle di progetto che non hanno ancora conversazioni.
    #
    # L'elenco qui sopra nasce dalle sessioni, raggruppate per cwd: una cartella
    # appena creata, o su cui si è lavorato senza Claude, non comparirebbe mai.
    # Il caso non è teorico: succede ogni volta che si apre un progetto nuovo e
    # ci si chiede perché il pannello non lo veda.
    #
    # Si aggiungono in fondo e non si riordina: «top» è ordinato per peso, e
    # queste pesano zero. Il campo «problemi» lo riempie il giro più sotto,
    # insieme a tutte le altre.
    radice = radice_progetti(arg("--radice-progetti"), top)

    # I nomi si assegnano ora, non nel raggruppamento: la radice si deduce dai
    # progetti, quindi prima di averli tutti non si sa rispetto a cosa il nome
    # sarebbe relativo.
    for e in top:
        e["nome"] = nome_progetto(e["percorso"], radice)
        # La regola «sta dentro la radice» la decide qui, non l'estensione:
        # in JavaScript non si puo' provarla, e sbagliarla ha gia' fatto
        # comparire un progetto vero fra quelli «fuori dai progetti».
        #
        # Senza radice dedotta il campo NON si emette. Scrivere `false` su
        # tutto svuoterebbe la sezione «Progetti» mentre il pulsante «+»
        # continua a proporre la home: si creerebbe un progetto che poi non
        # compare. Omettendolo, l'estensione usa il proprio ripiego, che la
        # home la considera radice — e le due meta' del pannello tornano
        # d'accordo su dove stiano i progetti.
        if radice:
            e["dentroRadice"] = dentro_radice(e["percorso"], radice)

    if radice:
        gia_elencati = {e["percorso"] for e in top}
        for c in sorted(radice.iterdir()):
            if not c.is_dir() or c.name.startswith("."):
                continue
            if str(c) in gia_elencati:
                continue
            # Stessi campi delle altre righe, `dentroRadice` compreso: sono
            # dentro per costruzione, ma lasciarlo assente faceva ricadere
            # l'estensione sulla vecchia regola del genitore proprio sulle
            # righe nate qui.
            top.append({"nome": nome_progetto(str(c), radice), "percorso": str(c),
                        "mb": 0, "sessioni": 0, "messaggi": 0, "esiste": True,
                        "dentroRadice": True})

    # Elenco delle sessioni per il menu cliccabile dell'estensione: id intero
    # (serve a --resume e alla rimozione), percorso di lavoro e peso.
    # Cartelle di projects/ che ospitano sessioni di cwd diversi: chi ci sta
    # dentro va segnalato, perché è il caso in cui una cancellazione ingenua
    # farebbe danni.
    per_cartella: dict[str, set[str]] = {}
    for x in reali:
        per_cartella.setdefault(x.get("folder", ""), set()).add(x.get("cwd") or "")
    condivise = set()
    for cartella, cwds in per_cartella.items():
        if len(cwds) > 1:
            condivise |= cwds

    for e in top:
        e["problemi"] = problemi_progetto(e["percorso"], condivise)

    elenco = []
    for x in sorted(reali, key=lambda s: s.get("mtime", 0), reverse=True)[:25]:
        cwd = x.get("cwd") or ""
        elenco.append({
            "id": x["id"],
            "titolo": x.get("title") or "senza titolo",
            "cwd": cwd,
            "progetto": Path(cwd).name if cwd else "?",
            "messaggi": x["n_msg"],
            "mb": round(x["bytes"] / 1048576, 1),
            "ultimo": (x.get("last") or "")[:10],
            "esiste": bool(cwd) and Path(cwd).is_dir(),
        })
    return {
        "conversazioni": len(reali),
        "messaggi": sum(s["n_msg"] for s in reali),
        "fantasma": len(d.get("fantasma", [])),
        "duplicati": len(d.get("duplicati", [])),
        "mbTotali": round(sum(s["bytes"] for s in reali) / 1048576, 1),
        "progetti": top,
        "elenco": elenco,
        "radiceProgetti": str(radice) if radice else None,
    }


def main() -> int:
    c = conf()
    def num(key, default):
        try:
            return int(c.get(key, default))
        except ValueError:
            return default

    usage = shutil.disk_usage("/")
    disco = {
        "pct": round(usage.used / usage.total * 100),
        "usatiGb": round(usage.used / 1024**3),
        "totaliGb": round(usage.total / 1024**3),
        "liberiGb": round(usage.free / 1024**3),
    }

    claude_mb = du_mb(CLAUDE)
    # Scomposizione di ~/.claude. Senza questa, «Dati Claude» somma le
    # conversazioni dell'utente e l'ingombro dei plugin: il 2026-09-17 il
    # plugin claude-security si è installato un ambiente Python da 276 MB e la
    # linea di tendenza è schizzata di 265 MB per un motivo che non c'entrava
    # niente con il lavoro. Una misura di sorveglianza che confonde «il mio
    # lavoro cresce» con «un plugin si è installato» fa perdere fiducia.
    parti = {}
    for nome, sotto in (("conversazioni", "projects"),
                        ("plugin", "plugins"),
                        ("sicurezza", "security"),
                        ("skill", "skills"),
                        ("job", "jobs"),
                        ("cronologia file", "file-history")):
        mb = du_mb(CLAUDE / sotto)
        if mb:
            parti[nome] = mb
    altro = max(0, claude_mb - sum(parti.values()))
    if altro:
        parti["altro"] = altro

    sess = sessions()

    # Spazio recuperabile: solo le voci che un utente non-root può liberare,
    # perché il cruscotto non deve promettere quello che non può mantenere.
    # Ogni voce porta il nome del target di clean.sh, così il pulsante di
    # pulizia nell'estensione sa esattamente cosa lanciare.
    rec = []
    def add(nome, mb, target, dettaglio=None):
        if mb > 0 or dettaglio:
            rec.append({"nome": nome, "mb": mb, "target": target,
                        "dettaglio": dettaglio or f"{mb} MB"})

    add("Cestino", stale_mb(HOME / ".local/share/Trash", num("TRASH_RETENTION_DAYS", 30)),
        "trash")
    add("~/.cache stantia", stale_mb(HOME / ".cache", num("USER_CACHE_RETENTION_DAYS", 60)),
        "usercache")
    add("Job Claude", stale_mb(CLAUDE / "jobs", num("CLAUDE_JOBS_RETENTION_DAYS", 30)),
        "claude-jobs")
    add("Shell snapshot", stale_mb(CLAUDE / "shell-snapshots", num("CLAUDE_SHELL_SNAPSHOT_RETENTION_DAYS", 14)),
        "claude-snapshots")
    add("File history", stale_mb(CLAUDE / "file-history", num("CLAUDE_FILE_HISTORY_RETENTION_DAYS", 30)),
        "claude-filehistory")
    add("Paste cache", stale_mb(CLAUDE / "paste-cache", num("CLAUDE_PASTE_CACHE_RETENTION_DAYS", 14)),
        "claude-paste")

    # La cache di Claude sta in ~/.cache, non in ~/.claude: due cartelle, e i
    # MB li conta chi poi cancella.
    try:
        if reclaim:
            log = reclaim.elenca("claude-cache")
            if log:
                add("Cache di Claude", int(reclaim.peso(log) / 1048576),
                    "claude-cache", f"{len(log)} file di log oltre la scadenza")
    except Exception as e:
        print(f"cache di Claude non leggibile: {e}", file=sys.stderr)
    try:
        vecchie = reclaim.versioni_vecchie() if reclaim else []
        if vecchie:
            add("Versioni di Claude Code", int(reclaim.peso(vecchie) / 1048576),
                "claude-versions",
                f"{len(vecchie)} versioni oltre quelle da tenere")
    except Exception as e:
        print(f"versioni di Claude non leggibili: {e}", file=sys.stderr)

    # Segnalazioni: percorsi messi in coda a mano con segnala.py, che nessuna
    # categoria conosce. Hanno sempre un dettaglio, così compaiono anche
    # quando pesano meno di un MB — il motivo per cui sono lì è l'unica cosa
    # che le rende comprensibili a chi le vede nel pannello.
    try:
        for s in (reclaim.segnalati() if reclaim else []):
            add(s["nome"], int(reclaim.peso([s["percorso"]]) / 1048576),
                f"segnalato:{s['id']}", s["motivo"] or str(s["percorso"]))
    except Exception as e:
        print(f"segnalazioni non leggibili: {e}", file=sys.stderr)

    # Le sessioni-fantasma pesano quasi nulla ma sporcano il selettore: qui
    # conta il numero, non i MB, altrimenti la voce non comparirebbe mai.
    if sess["fantasma"]:
        rec.append({"nome": "Sessioni-fantasma", "mb": 0, "target": "claude-stubs",
                    "dettaglio": f"{sess['fantasma']} trascrizioni vuote"})

    # La quota si raccoglie a parte (costa un giro di rete): qui si riprende
    # l'ultimo valore letto, con la sua età, così il cruscotto può dire se è
    # fresco o vecchio invece di spacciarlo per attuale.
    quota = None
    try:
        q = json.loads(USAGE.read_text())
        eta = (datetime.now(timezone.utc)
               - datetime.fromisoformat(q["letteIl"])).total_seconds()
        quota = {"limiti": q.get("limiti", []), "extra": q.get("extra", {}),
                 "letteIl": q["letteIl"], "etaSecondi": int(eta)}
    except Exception:
        pass

    allarmi = []
    warn = num("ALERT_WARN_PCT", 75)
    crit = num("ALERT_CRIT_PCT", 90)
    if disco["pct"] >= warn:
        allarmi.append(f"Disco al {disco['pct']}%")
    if claude_mb > num("ALERT_CLAUDE_MB", 500):
        allarmi.append(f"~/.claude a {claude_mb} MB")
    cache_mb, cache_top, cache_top_mb = cache_claude()
    if cache_mb > num("ALERT_CLAUDE_CACHE_MB", 200):
        allarmi.append(f"cache di Claude a {cache_mb} MB")
    if sess["fantasma"] > 50:
        allarmi.append(f"{sess['fantasma']} sessioni-fantasma")
    # Si distingue per `tipo`: un account può avere weekly_all e weekly_opus,
    # e chiamarli entrambi "settimana" produrrebbe due allarmi identici.
    nomi = {"session": "sessione", "weekly_all": "settimana",
            "weekly_opus": "settimana Opus"}
    for l in (quota or {}).get("limiti", []):
        if (l.get("percento") or 0) >= warn:
            nome = nomi.get(l.get("tipo"), l.get("tipo") or "quota")
            allarmi.append(f"Quota {nome} al {l['percento']}%")

    # Sale al primo livello accanto a «progetto»: la leggono il pannello e le
    # preferenze, che finora la deducevano da «progetto» — null quando lo
    # script gira copiato dentro l'estensione, cioè in uso normale.
    radice_prog = sess.pop("radiceProgetti", None)

    now = datetime.now(timezone.utc)
    data = {
        "generatoIl": now.isoformat(timespec="seconds"),
        # Solo se il progetto c'è davvero: dichiarare la cartella delle
        # estensioni come «progetto» farebbe creare lì i progetti nuovi.
        "progetto": str(ROOT) if ROOT else None,
        "radiceProgetti": radice_prog,
        "disco": disco,
        "claude": {
            "totaleMb": claude_mb,
            # «Conversazioni» è la voce che riguarda l'utente: è quella che il
            # popup mostra in evidenza, con il totale come contesto.
            "conversazioniMb": parti.get("conversazioni", 0),
            "scomposizione": parti,
            "cacheMb": cache_mb,
            "cacheTop": cache_top,
            "cacheTopMb": cache_top_mb,
            **sess,
        },
        # Le soglie viaggiano con i dati: così il pannello colora le barre agli
        # stessi valori a cui gli scan suonano l'allarme, senza una seconda
        # copia da tenere allineata a mano.
        # `cacheMb` e' il fondoscala della barra della cache: senza, il pannello
        # dovrebbe inventarsi un massimo e colorerebbe a soglie diverse da
        # quelle a cui suona l'allarme.
        "soglie": {"attenzione": warn, "critico": crit,
                   "cacheMb": num("ALERT_CLAUDE_CACHE_MB", 200)},
        "recuperabile": {"totaleMb": sum(r["mb"] for r in rec), "voci": rec},
        "quota": quota,
        "allarmi": allarmi,
    }

    # I dati contengono i nomi dei progetti — quindi dei clienti. Sono già
    # protetti da ~/.local/share (700), ma non c'è motivo di lasciarli
    # leggibili a tutti: difesa in profondità a costo zero.
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    try:
        OUT_DIR.chmod(0o700)
    except OSError:
        pass
    # Scrittura atomica: l'estensione può leggere in qualunque momento e non
    # deve mai trovare un JSON troncato a metà.
    tmp = METRICS.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1))
    tmp.replace(METRICS)
    try:
        METRICS.chmod(0o600)
        if HISTORY.exists():
            HISTORY.chmod(0o600)
    except OSError:
        pass

    riga = {"t": now.isoformat(timespec="seconds"),
            "discoPct": disco["pct"], "claudeMb": claude_mb,
            "conversazioniMb": parti.get("conversazioni", 0),
            "cacheMb": cache_mb, "conversazioni": sess["conversazioni"],
            "messaggi": sess["messaggi"], "recuperabileMb": data["recuperabile"]["totaleMb"],
            "quotaSessione": next((l["percento"] for l in (quota or {}).get("limiti", [])
                                   if l.get("gruppo") == "session"), None),
            "quotaSettimana": next((l["percento"] for l in (quota or {}).get("limiti", [])
                                    if l.get("gruppo") == "weekly"), None)}
    with HISTORY.open("a") as fh:
        fh.write(json.dumps(riga) + "\n")
    righe = HISTORY.read_text().splitlines()
    if len(righe) > HISTORY_MAX_LINES:
        HISTORY.write_text("\n".join(righe[-HISTORY_MAX_LINES:]) + "\n")

    if "--quiet" not in sys.argv:
        print(json.dumps(data, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
