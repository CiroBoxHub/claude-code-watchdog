#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 CiroBoxHub
"""Mette e toglie gli hook di Watchface in ~/.claude/settings.json.

    watchface-hooks.py stato [--json]       cosa c'e' adesso
    watchface-hooks.py installa             aggiunge i nostri hook e il mod
    watchface-hooks.py rimuovi              toglie i nostri hook e il mod
    watchface-hooks.py mod-attiva           solo il mod
    watchface-hooks.py mod-disattiva        solo il mod
    watchface-hooks.py rimuovi-altro NOME   toglie gli hook del programma NOME
    watchface-hooks.py ripristina FILE      rimette un backup
    watchface-hooks.py elimina FILE         cestina un backup
    watchface-hooks.py elimina --tutti      cestina tutti i backup

settings.json contiene anche le impostazioni dell'utente, quindi:
- prima di ogni modifica se ne fa un backup, e i backup si elencano;
- si scrive su un temporaneo e si rinomina, con i permessi dell'originale;
- un file che non e' JSON valido non si riscrive mai: si esce con errore.
Le preferenze dell'estensione chiamano questo script; la logica sta qui, in
Python, perche' qui si puo' provare.

**Il mod va insieme agli hook, non accanto.** Dalla versione 2.1.29x Claude
Code carica dei «mod»: plugin di hook-funzione che girano dentro il suo
processo e sanno due cose che da fuori si indovinano — la quota (che il motore
ha in casa) e quali aiutanti sono ancora al lavoro. Si attivano scrivendo la
loro cartella in `env.CLAUDE_CODE_PLUGIN_DIRS`, lo stesso file degli hook, ed
e' documentato proprio per le sessioni dove non si puo' passare un flag: quelle
che avvia l'app desktop. Un pulsante solo, perche' per chi installa e' una cosa
sola; `installa` e `rimuovi` fanno entrambi.
`mod-attiva` e `mod-disattiva` ci sono per spegnere il mod **senza** togliere
gli hook: gli hook sono la base, il mod il miglioramento, e se un giorno fosse
lui a dare problemi si vuole poter tornare alla base senza restare al buio.
Vale per le sessioni avviate **dopo**, come gli hook.
"""
import json, os, re, subprocess, sys
from datetime import datetime
from pathlib import Path

HOME = Path.home()
SETTINGS = HOME / ".claude" / "settings.json"
BACKUP = (Path(os.environ.get("XDG_DATA_HOME") or (HOME / ".local/share"))
          / "claude-code-watchdog" / "backup-settings")
# Tre, non dieci: chiesto dall'uso il 2026-10-08. Un backup serve a tornare
# indietro di un passo o due, non a tenere l'archivio di settings.json — e
# quelli vecchi sono copie di una configurazione che non c'e' piu'.
BACKUP_DA_TENERE = 3
HOOK = Path(__file__).resolve().parent / "watchface-hook"
MARCA = "/watchface-hook'"

# Il mod sta in `mods/watchdog`: accanto allo script nella copia installata
# dentro l'estensione, un piano sopra quando si lavora dal progetto (bin/).
CHIAVE_MOD = "CLAUDE_CODE_PLUGIN_DIRS"
_QUI = Path(__file__).resolve().parent
MOD = next((p for p in (_QUI / "mods" / "watchdog",
                        _QUI.parent / "mods" / "watchdog") if p.is_dir()),
           _QUI / "mods" / "watchdog")

# Gli eventi che servono a dire cosa sta facendo Claude: gli stessi che
# coucou ascoltava, perche' sono quelli che cambiano lo stato visibile, piu'
# PreCompact per il limone del /compact (dalla versione 4).
# `PermissionDenied` dalla versione 6: quando neghi un permesso Claude Code
# non manda nient'altro, e l'ultimo evento restava `PermissionRequest` — cioe'
# «aspetta te» per un'ora, dopo che avevi gia' risposto. Segnalato dall'uso il
# 2026-10-08 come faccina poco reattiva.
EVENTI = ["SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse",
          "PostToolUse", "PostToolUseFailure", "PermissionRequest",
          "PermissionDenied", "Notification", "Stop", "StopFailure",
          "SubagentStart", "SubagentStop", "PreCompact"]


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
    # Una forma che non si capisce non si tocca: riscriverla vorrebbe dire
    # indovinare cosa intendeva chi l'ha scritta.
    if "hooks" in d and not isinstance(d["hooks"], dict):
        raise Illeggibile(f"in {SETTINGS} «hooks» non e' un oggetto: non lo modifico")
    return d


def env_leggibile(d: dict) -> bool:
    """Se `env` ha una forma che conosciamo.

    **Non e' un motivo per rifiutare tutto.** Il controllo stava in `leggi()`
    e faceva fallire anche `rimuovi`, cioe' proprio il comando che serve
    quando qualcosa e' andato storto: gli hook si toglievano solo dopo aver
    sistemato a mano una chiave che non c'entra niente con loro. Stessa regola
    degli eventi di forma ignota — si salta quel pezzo e si fa il resto.
    Rilevato da /code-review il 2026-10-08.
    """
    env = d.get("env")
    if env is None:
        return True
    if not isinstance(env, dict):
        return False
    return CHIAVE_MOD not in env or isinstance(env[CHIAVE_MOD], str)


def comando(evento: str) -> str:
    # `|| true`: se un giorno l'estensione sparisce senza togliere gli hook,
    # Claude Code non deve mostrare un errore a ogni strumento.
    # `bash` esplicito: lo zip delle estensioni puo' perdere il bit di
    # esecuzione, e un hook non eseguibile tacerebbe senza dire perche'.
    return f"bash '{HOOK}' {evento} 2>/dev/null || true"


def nostro(h: dict) -> bool:
    return MARCA in str(h.get("command", ""))


def voci_mod(valore: str) -> list[str]:
    """Le cartelle di CLAUDE_CODE_PLUGIN_DIRS, separate come fa il sistema.

    Le vuote si buttano: un separatore di troppo e' un errore di battitura,
    non una cartella.
    """
    return [v for v in (valore or "").split(os.pathsep) if v]


# Il nostro mod, qualunque copia lo installi: dal progetto e'
# `<progetto>/mods/watchdog`, dall'estensione installata e' un'altra cartella.
# Installando da tutte e due, Claude Code caricava lo stesso plugin due volte.
SUFFISSO_MOD = os.path.join("mods", "watchdog")


def nostra_cartella(c: str) -> bool:
    return c.rstrip("/").endswith(os.sep + SUFFISSO_MOD)


def mod_installa(d: dict, percorso: str) -> bool:
    """Aggiunge la nostra cartella in coda. Torna False se c'era gia' quella.

    In coda e non in testa: chi ha messo i suoi plugin prima di noi li ha
    messi in quell'ordine, e non siamo noi a cambiarlo. Una **altra** copia
    dello stesso mod si toglie: due percorsi diversi che portano allo stesso
    plugin lo fanno caricare due volte, e il pannello vedrebbe due scrittori.
    Rilevato da /code-review il 2026-10-08.
    """
    env = d.setdefault("env", {})
    voci = voci_mod(env.get(CHIAVE_MOD, ""))
    if voci == [v for v in voci if not nostra_cartella(v)] + [percorso]:
        return False
    voci = [v for v in voci if not nostra_cartella(v)]
    voci.append(percorso)
    env[CHIAVE_MOD] = os.pathsep.join(voci)
    return True


def mod_rimuovi(d: dict, percorso: str) -> bool:
    """Toglie solo la nostra cartella. Torna False se non c'era.

    La chiave sparisce se restava solo la nostra, e `env` se non resta niente:
    una chiave vuota e' una riga che qualcuno un giorno prendera' per una
    scelta.
    """
    env = d.get("env")
    if not isinstance(env, dict) or CHIAVE_MOD not in env:
        return False
    voci = voci_mod(env.get(CHIAVE_MOD, ""))
    restano = [v for v in voci if v != percorso]
    if len(restano) == len(voci):
        return False
    if restano:
        env[CHIAVE_MOD] = os.pathsep.join(restano)
    else:
        del env[CHIAVE_MOD]
    if not env:
        del d["env"]
    return True


def mod_installato(d: dict, percorso: str) -> bool:
    env = d.get("env")
    if not isinstance(env, dict):
        return False
    return percorso in voci_mod(env.get(CHIAVE_MOD, ""))


# Interpreti e lanciatori: il programma vero e' lo script che segue. Senza
# saltarli, tutti gli hook «python3 ...» finivano in un gruppo solo, e
# «Rimuovi» su uno li toglieva tutti (revisione del 2026-10-03).
LANCIATORI = {"bash", "sh", "zsh", "dash", "env", "python", "python3", "node",
              "npx", "uv", "uvx", "deno", "bun", "ruby", "perl", "exec"}


def programma(cmd: str) -> str | None:
    """Lo script che un comando di hook lancia, per raggruppare e togliere.

    None se non si riesce a dirlo: un hook cosi' si mostra ma non si toglie.
    """
    parti = re.findall(r"'([^']*)'|\"([^\"]*)\"|(\S+)", cmd or "")
    for p in ("".join(g) for g in parti):
        if p.startswith("-") or "=" in p.split("/")[0]:
            continue                    # opzioni e VAR=valore di env
        if Path(p).name in LANCIATORI:
            continue
        return p
    return None


def backup() -> Path | None:
    """Copia settings.json nei backup, nato con permessi 600.

    Il nome porta i microsecondi: con un suffisso «-1» per le collisioni nello
    stesso secondo, l'ordine alfabetico metteva il piu' nuovo prima.
    """
    if not SETTINGS.exists():
        return None
    BACKUP.mkdir(parents=True, exist_ok=True)
    os.chmod(BACKUP, 0o700)
    nome = BACKUP / f"settings-{datetime.now().strftime('%Y%m%d-%H%M%S-%f')}.json"
    fd = os.open(nome, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as fh:
        fh.write(SETTINGS.read_bytes())
    for vecchio in elenco_backup()[:-BACKUP_DA_TENERE]:
        nel_cestino(vecchio)
    return nome


def nel_cestino(f: Path) -> bool:
    """Nel cestino, non cancellato — la regola non negoziabile del progetto.

    `gio` manca o fallisce (niente sessione grafica, niente GIO): si lascia il
    file dov'e'. Un backup di troppo non ha mai fatto male a nessuno, e
    `unlink` come ripiego sarebbe proprio il pattern che il 2026-09-17 e'
    costato due conversazioni.
    """
    if not f.exists():
        return False
    try:
        r = subprocess.run(["gio", "trash", str(f)], capture_output=True,
                           text=True, timeout=30)
        return r.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def elenco_backup() -> list[Path]:
    if not BACKUP.is_dir():
        return []
    return sorted(BACKUP.glob("settings-*.json"))


def scrivi(d: dict) -> None:
    scrivi_testo(json.dumps(d, indent=2, ensure_ascii=False) + "\n")


def scrivi_testo(testo: str) -> None:
    """Temporaneo accanto e rinomina: chi legge vede il file vecchio o il
    nuovo, mai uno a meta'. Con i permessi dell'originale, 600 se nuovo.

    Se settings.json e' un collegamento (dotfiles, stow) si scrive nel file a
    cui punta: rinominare sopra il collegamento lo sostituirebbe con un file
    normale, e il repository dei dotfiles smetterebbe di vedere le modifiche.
    """
    dest = SETTINGS.resolve() if SETTINGS.is_symlink() else SETTINGS
    dest.parent.mkdir(parents=True, exist_ok=True)
    modo = dest.stat().st_mode & 0o777 if dest.exists() else 0o600
    tmp = dest.with_name(f".{dest.name}.{os.getpid()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, modo)
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write(testo)
        os.chmod(tmp, modo)
        tmp.replace(dest)
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
        gruppi = hooks[ev]
        if not isinstance(gruppi, list):
            continue                     # forma ignota: resta com'e'
        nuovi = []
        for g in gruppi:
            dentro = g.get("hooks") if isinstance(g, dict) else None
            if not isinstance(dentro, list):
                nuovi.append(g)          # forma ignota: resta com'e'
                continue
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
            dentro = g.get("hooks") if isinstance(g, dict) else None
            for h in dentro if isinstance(dentro, list) else []:
                if not isinstance(h, dict):
                    continue
                if nostro(h):
                    installati.append(ev)
                    continue
                cmd = str(h.get("command", ""))
                chi = programma(cmd)
                if chi is None:
                    continue             # hook di tipo prompt, o illeggibile
                a = altri.setdefault(chi, {"programma": Path(chi).name,
                                           "percorso": chi, "comando": cmd,
                                           "eventi": []})
                a["eventi"].append(ev)
    leggibile = env_leggibile(d)
    env = d.get("env") if isinstance(d.get("env"), dict) else {}
    valore = env.get(CHIAVE_MOD, "")
    cartelle = voci_mod(valore) if isinstance(valore, str) else []
    return {"settings": str(SETTINGS), "hook": str(HOOK),
            "hookPresente": HOOK.is_file(),
            "installati": sorted(set(installati)),
            "mancanti": [e for e in EVENTI if e not in installati],
            "altri": list(altri.values()),
            "backup": [str(p) for p in elenco_backup()],
            "mod": str(MOD),
            "modPresente": (MOD / ".claude-plugin" / "plugin.json").is_file(),
            "modInstallato": str(MOD) in cartelle,
            "modEnvLeggibile": leggibile,
            # Le cartelle di plugin degli altri: si mostrano, non si toccano.
            "modAltri": [c for c in cartelle if c != str(MOD)]}


def messaggio_mod(d: dict, metti: bool) -> tuple[str, bool]:
    """Mette o toglie il mod in `d` e dice cosa e' successo, in una riga.

    Il separatore dentro il percorso lo renderebbe due cartelle: non si
    scrive, e lo si dice. Capita con una cartella che contiene «:», che su
    Linux e' lecita in un nome di file.
    """
    percorso = str(MOD)
    if not env_leggibile(d):
        return (f"mod non toccato: in {SETTINGS} «env» ha una forma che non "
                "conosco", False)
    if metti:
        if os.pathsep in percorso:
            return (f"mod non attivato: «{os.pathsep}» nel percorso {percorso}",
                    False)
        if not (MOD / ".claude-plugin" / "plugin.json").is_file():
            return (f"mod non trovato in {MOD}: non attivato", False)
        return (("mod attivato (vale per le sessioni nuove)"
                 if mod_installa(d, percorso) else "mod gia' attivo"), True)
    return (("mod disattivato" if mod_rimuovi(d, percorso)
             else "mod non era attivo"), True)


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
            # Un evento che non e' un elenco e' una forma che non conosciamo:
            # resta com'e', e quell'evento si salta. Fino al 2026-10-03 qui
            # c'era un crash, e non si installava nemmeno il resto.
            saltati = [ev for ev in EVENTI
                       if not isinstance(hooks.setdefault(ev, []), list)]
            for ev in EVENTI:
                if ev not in saltati:
                    hooks[ev].append(
                        {"hooks": [{"type": "command", "command": comando(ev),
                                    "timeout": 5}]})
            # Il mod va con gli hook: per chi installa e' una cosa sola.
            # Se manca o non si puo' scrivere il percorso, gli hook si
            # installano comunque — meglio meta' che niente.
            esito_mod, _ = messaggio_mod(d, metti=True)
            scrivi(d)
            print(f"installati {len(EVENTI) - len(saltati)} hook")
            print(esito_mod)
            if saltati:
                print("saltati, forma che non conosco: " + ", ".join(saltati),
                      file=sys.stderr)
            return 0

        if azione == "rimuovi":
            d = leggi()
            backup()
            n = togli(d, nostro)
            esito_mod, _ = messaggio_mod(d, metti=False)
            scrivi(d)
            print(f"tolti {n} hook")
            print(esito_mod)
            return 0

        if azione in ("mod-attiva", "mod-disattiva"):
            d = leggi()
            backup()
            esito, ok = messaggio_mod(d, metti=azione == "mod-attiva")
            if not ok:
                print(esito, file=sys.stderr)
                return 1
            scrivi(d)
            print(esito)
            return 0

        if azione == "rimuovi-altro":
            if len(resto) != 1:
                print("serve il nome del programma", file=sys.stderr)
                return 2
            # Si identifica per percorso dello script, non per nome: due
            # «hook.py» in cartelle diverse sono due programmi diversi.
            chi = resto[0]
            d = leggi()
            backup()
            n = togli(d, lambda h: not nostro(h)
                      and programma(str(h.get("command", ""))) == chi)
            scrivi(d)
            print(f"tolti {n} hook di {Path(chi).name}")
            return 0

        if azione == "elimina":
            # Stessa rete di «ripristina»: solo file della cartella dei
            # backup. Questo comando lo chiama un pulsante, e un percorso
            # qualsiasi diventerebbe un file cestinato a caso.
            if len(resto) != 1:
                print("serve il file di backup, oppure --tutti", file=sys.stderr)
                return 2
            if resto[0] == "--tutti":
                quali = elenco_backup()
            else:
                f = Path(resto[0]).resolve()
                if f.parent != BACKUP.resolve() or not f.is_file():
                    print("non e' un backup di watchface-hooks", file=sys.stderr)
                    return 1
                quali = [f]
            if not quali:
                print("nessun backup da eliminare")
                return 0
            # Non si fa un backup prima di cestinare un backup: aggiungerne
            # uno mentre se ne tolgono e' un giro che non finisce.
            fatti = sum(1 for q in quali if nel_cestino(q))
            if fatti < len(quali):
                print(f"cestinati {fatti} backup su {len(quali)}: "
                      "«gio» non ha potuto, restano dove sono", file=sys.stderr)
                return 1
            print(f"cestinati {fatti} backup" if fatti != 1
                  else "cestinato 1 backup")
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
            # Si legge PRIMA del backup: il backup pota i piu' vecchi, e
            # ripristinare il piu' vecchio lo cancellava prima di copiarlo.
            testo = f.read_text()
            try:
                json.loads(testo)
            except ValueError:
                print("il backup non e' JSON valido", file=sys.stderr)
                return 1
            backup()
            scrivi_testo(testo)
            print(f"ripristinato {f.name}")
            return 0
    except Illeggibile as e:
        print(e, file=sys.stderr)
        return 1
    except OSError as e:
        print(f"{e.strerror or e}: {e.filename or ''}", file=sys.stderr)
        return 1

    print(f"azione sconosciuta: {azione}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
