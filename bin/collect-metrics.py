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
HOME = Path.home()
CLAUDE = HOME / ".claude"
OUT_DIR = Path(os.environ.get("XDG_DATA_HOME", HOME / ".local/share")) / "claude-code-watchdog"
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
    top = sorted(by_proj.values(), key=lambda e: -e["mb"])[:40]
    for e in top:
        e["mb"] = round(e["mb"], 1)

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
    cache_mb = du_mb(HOME / ".cache")
    if cache_mb > num("ALERT_HOME_CACHE_MB", 2048):
        allarmi.append(f"~/.cache a {cache_mb} MB")
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

    now = datetime.now(timezone.utc)
    data = {
        "generatoIl": now.isoformat(timespec="seconds"),
        # Solo se il progetto c'è davvero: dichiarare la cartella delle
        # estensioni come «progetto» farebbe creare lì i progetti nuovi.
        "progetto": str(ROOT) if ROOT else None,
        "disco": disco,
        "claude": {
            "totaleMb": claude_mb,
            # «Conversazioni» è la voce che riguarda l'utente: è quella che il
            # popup mostra in evidenza, con il totale come contesto.
            "conversazioniMb": parti.get("conversazioni", 0),
            "scomposizione": parti,
            "cacheHomeMb": cache_mb,
            **sess,
        },
        # Le soglie viaggiano con i dati: così il pannello colora le barre agli
        # stessi valori a cui gli scan suonano l'allarme, senza una seconda
        # copia da tenere allineata a mano.
        "soglie": {"attenzione": warn, "critico": crit},
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
