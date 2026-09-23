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
import hashlib, json, os, shutil, subprocess, sys, time
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
    "claude-cache":       ("CLAUDE_CACHE_RETENTION_DAYS", 7),
}

# Quante versioni di Claude Code tenere, quella in uso compresa. Due e non una:
# se un aggiornamento rompe qualcosa serve poterci tornare, e una versione pesa
# ~220 MB — il prezzo del ripensamento e' noto e accettabile.
KEEP_VERSIONI_DEFAULT = 2

# Sottocartella di ~/.claude per i target a scadenza, e nome leggibile.
CARTELLE = {
    "claude-jobs":        ("jobs", "Job Claude"),
    "claude-snapshots":   ("shell-snapshots", "Shell snapshot"),
    "claude-filehistory": ("file-history", "File history"),
    "claude-paste":       ("paste-cache", "Paste cache"),
}

VERSIONI = Path(os.environ.get("XDG_DATA_HOME") or (HOME / ".local/share")) / "claude/versions"

# Coda delle segnalazioni: percorsi trovati a mano che il pannello mostra come
# tutte le altre voci. Non e' un campo dove si digita un percorso — ci si
# scrive con `segnala.py`, e reclaim.py agisce solo su cio' che trova qui.
SEGNALATI = (Path(os.environ.get("XDG_DATA_HOME") or (HOME / ".local/share"))
             / "claude-code-watchdog" / "segnalati.jsonl")

# Le due cartelle di ~/.cache che sono di Claude Code: lo staging degli
# aggiornamenti e i log degli MCP, divisi per progetto. Sono diagnostica: si
# rigenerano al primo uso.
CACHE_CLAUDE = [HOME / ".cache/claude", HOME / ".cache/claude-cli-nodejs"]

TARGET = ["trash", "usercache", "claude-cache", "claude-stubs",
          "claude-versions", *CARTELLE]


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


def versione_in_uso() -> Path | None:
    """Il binario di Claude Code che il PATH risolve adesso.

    Si risolve il link invece di prendere il numero di versione piu' alto:
    `claude install` puo' aver riportato indietro il link dopo un guasto, e
    cancellare «la piu' vecchia» in quel caso toglierebbe quella in uso.
    """
    candidati = []
    dove = shutil.which("claude")
    if dove:
        candidati.append(Path(dove))
    # Anche fuori dal PATH e anche se il permesso di esecuzione manca: il link
    # c'e' lo stesso, e sbagliare qui vuol dire cestinare il binario in uso.
    candidati.append(HOME / ".local/bin/claude")
    for c in candidati:
        try:
            vero = c.resolve()
        except OSError:
            continue
        if vero.is_file() and vero.parent == VERSIONI.resolve():
            return vero
    return None


def versioni_vecchie() -> list[Path]:
    """Le versioni di Claude Code da togliere.

    Si tengono KEEP_VERSIONI le piu' recenti per data, e in ogni caso quella
    in uso, che potrebbe non essere la piu' recente.
    """
    if not VERSIONI.is_dir():
        return []
    try:
        quante = int(conf().get("CLAUDE_KEEP_VERSIONS", KEEP_VERSIONI_DEFAULT))
    except ValueError:
        quante = KEEP_VERSIONI_DEFAULT
    quante = max(1, quante)

    binari = [f for f in VERSIONI.iterdir() if f.is_file() and not f.is_symlink()]
    binari.sort(key=lambda f: f.stat().st_mtime, reverse=True)
    in_uso = versione_in_uso()
    if in_uso is None:
        # Non si riesce a stabilire quale versione stia girando. Non si tira a
        # indovinare «la piu' recente»: se il link fosse stato riportato
        # indietro dopo un aggiornamento andato male, la piu' recente sarebbe
        # proprio quella da non toccare. Meglio che la voce non compaia.
        if binari:
            print("versione di Claude in uso non identificabile: non tolgo niente",
                  file=sys.stderr)
        return []

    tenere = set(binari[:quante])
    tenere.add(in_uso)
    return [f for f in binari if f not in tenere]


def ammissibile(percorso: Path) -> str | None:
    """None se il percorso si puo' cestinare, altrimenti il motivo del rifiuto.

    Vale sia quando si segnala sia quando si cancella. La seconda volta non e'
    ridondante: fra le due puo' passare del tempo, e un progetto puo' essere
    nato nel frattempo proprio li' dentro.
    """
    try:
        p = percorso.resolve()
        # Risolti anche questi: `p` passa da resolve(), e con una home che è
        # un collegamento (`/home/tizio` → `/dati/tizio`) il confronto con un
        # `HOME` non risolto dichiara «fuori dalla home» qualunque cosa — e il
        # pulsante non cestinerebbe più niente. Chi confronta percorsi deve
        # risolvere entrambi i lati.
        casa = HOME.resolve()
        claude = CLAUDE.resolve()
    except OSError:
        return "percorso irrisolvibile"
    if not p.is_absolute():
        return "percorso non assoluto"
    if p == casa or casa not in p.parents:
        return "fuori dalla home"
    if p == claude or claude in p.parents:
        # Trascrizioni e memorie hanno strumenti loro, che verificano prima di
        # toccare: session-purge.py e project-purge.py. Passare di qui
        # salterebbe quelle verifiche.
        return "sotto ~/.claude: usa session-purge.py o project-purge.py"
    try:
        dati = SEGNALATI.parent.resolve()
    except OSError:
        dati = SEGNALATI.parent
    if p == dati:
        return "e' la cartella dati del cruscotto"
    for lavoro in cartelle_di_lavoro():
        if p == lavoro or p in lavoro.parents:
            return f"contiene la cartella di lavoro di un progetto ({lavoro})"
    return None


def cartelle_di_lavoro() -> list[Path]:
    """Le cartelle di lavoro dei progetti note al cruscotto.

    Si leggono da metrics.json invece di ricalcolarle: se il file non c'e'
    ancora si torna una lista vuota e restano gli altri controlli.
    """
    f = SEGNALATI.parent / "metrics.json"
    try:
        d = json.loads(f.read_text())
    except Exception:
        return []
    out = []
    for e in d.get("claude", {}).get("progetti", []):
        perc = e.get("percorso") or ""
        if not perc.startswith("/"):
            continue
        # Risolti: `ammissibile()` risolve il percorso da cestinare, e
        # confrontarlo con uno non risolto fa mancare il riconoscimento
        # quando di mezzo c'e' un collegamento — per esempio una home che
        # e' un link. Chi confronta percorsi deve risolvere entrambi i lati.
        try:
            out.append(Path(perc).resolve())
        except OSError:
            out.append(Path(perc))
    return out


def ident(percorso: Path) -> str:
    """Sigla stabile di un percorso segnalato, usata come nome di target."""
    return hashlib.sha256(str(percorso).encode()).hexdigest()[:12]


def segnalati() -> list[dict]:
    """La coda, già filtrata: solo voci esistenti e ammissibili."""
    out = []
    if not SEGNALATI.is_file():
        return out
    for riga in SEGNALATI.read_text().splitlines():
        riga = riga.strip()
        if not riga:
            continue
        try:
            v = json.loads(riga)
        except ValueError:
            continue
        perc = v.get("percorso") or ""
        if not perc.startswith("/"):
            continue
        p = Path(perc)
        if not p.exists() or ammissibile(p):
            continue
        out.append({"percorso": p, "nome": v.get("nome") or p.name,
                    "motivo": v.get("motivo") or "", "id": ident(p)})
    return out


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

    if target == "claude-versions":
        return versioni_vecchie()

    if target.startswith("segnalato:"):
        sigla = target.split(":", 1)[1]
        return [v["percorso"] for v in segnalati() if v["id"] == sigla]

    if target == "usercache":
        return scaduti(HOME / ".cache", giorni("usercache"))

    if target == "claude-cache":
        gg = giorni("claude-cache")
        return [f for d in CACHE_CLAUDE for f in scaduti(d, gg)]

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

    if target == "claude-versions" or target.startswith("segnalato:"):
        # Nel cestino, sempre. Una versione si recupera reinstallandola, ma
        # una segnalazione puo' essere qualunque cosa: l'unico modo per non
        # dover indovinare quanto era importante e' non cancellarla.
        return b if cestina(percorsi) else 0

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
    if target == "usercache":
        pota_vuote(HOME / ".cache")
    elif target == "claude-cache":
        for d in CACHE_CLAUDE:
            pota_vuote(d)
    else:
        pota_vuote(CLAUDE / CARTELLE[target][0])
    return b


def main() -> int:
    argv = sys.argv[1:]
    applica_davvero = "--apply" in argv
    come_json = "--json" in argv
    scelti = [a for a in argv if not a.startswith("-")]

    ignoti = [t for t in scelti
              if t not in TARGET and not t.startswith("segnalato:")]
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
