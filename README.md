# fedora_watchdog

Monitoraggio e pulizia del PC (Fedora 44) e dei dati di Claude Code.

## Da dentro Claude Code

| Comando | Cosa fa |
|---|---|
| `/watchdog-check` | Report su sistema e Claude. Non tocca niente. |
| `/watchdog-clean` | Mostra cosa si può liberare, chiede, poi libera. |
| `/watchdog-sessions` | Elenco di tutte le chat, con il comando per riprenderle. |

## Da terminale

    ./bin/scan-system.sh              # stato del sistema
    ./bin/scan-claude.sh              # stato di ~/.claude
    ./bin/claude-sessions.py          # inventario conversazioni
    ./bin/claude-sessions.py --older-than 90
    ./bin/clean.sh                    # anteprima: cosa si potrebbe liberare
    ./bin/clean.sh --list             # target disponibili
    ./bin/clean.sh --apply dnf journal   # esegue solo questi due

Gli scan sono a sola lettura. `clean.sh` senza `--apply` non cancella niente.

I target che richiedono privilegi di root non possono usare `sudo` da dentro
Claude Code: manca un terminale per la password, e nemmeno il prefisso `!` lo
risolve. Lo script ripiega su `pkexec`, che mostra il dialogo di
autenticazione di GNOME sul desktop.

## Cruscotto nel pannello GNOME

Estensione `claude-code-watchdog@cirobox.local`: disco, peso di `~/.claude`,
conversazioni per progetto, spazio recuperabile e andamento nel tempo.

    ./bin/collect-metrics.py      # raccoglie le metriche (0,5 s)
    ./bin/collect-usage.py        # legge la quota Claude (~2 s, un giro di rete)
    ./bin/session-purge.py <id>   # elenca tutto ciò che appartiene a una sessione
    ./bin/session-purge.py <id> --apply    # e lo rimuove
    ./bin/project-purge.py <cartella>      # i dati Claude di un intero progetto
    ./bin/project-purge.py <cartella> --apply
    ./bin/install-extension.sh    # installa o reinstalla dopo una modifica
    ./bin/pack-extension.sh       # crea lo zip per un altro PC

Nel popup: disco, dati Claude con la tendenza, quota (sessione e settimana),
spazio recuperabile, e l'elenco dei **progetti cliccabili** — ogni riga si apre
su tre azioni: **Cartella**, **Riprendi** (apre il terminale ed esegue
`claude --resume` lì dentro), **Elimina dati**.

«Elimina dati» rimuove solo quello che Claude Code tiene per proprio conto —
trascrizioni, memorie, job, scratchpad. **La cartella di lavoro non viene mai
toccata**: lì ci sono i file veri. Lo script ha una rete di sicurezza che salta
qualunque percorso caschi dentro la cartella di lavoro, anche se ci finisse per
errore.

Il «+» accanto a «Progetti» crea una cartella nuova e ci apre subito una
sessione di Claude Code.

Le impostazioni (icona `Impostazioni e guida` nel popup) scelgono cosa compare
nella barra, quali sezioni mostrare, ogni quanto aggiornare, ogni quanto
rileggere la quota e dove nascono i nuovi progetti. La prima pagina è una guida
che spiega ogni indicatore.

Nel popup c'è un pulsante **Libera spazio…**. Non pulisce: apre l'elenco di
cosa verrebbe tolto, voce per voce, con un interruttore per ciascuna. Si
elimina solo dopo un secondo clic su **Elimina**. Tocca esclusivamente dati
dell'utente — cache pacchetti, journal e kernel richiedono root e restano
appannaggio di `/watchdog-clean`.

L'estensione **non calcola niente**: legge
`~/.local/share/fedora-watchdog/metrics.json`, prodotto dal raccoglitore, e
`history.jsonl` per il grafico. Correggere una misura vuol dire toccare gli
script, non il codice della shell.

**Nessun parametro è una costante in `extension.js`.** GNOME Shell tiene in
cache il modulo già importato, quindi una costante lì richiederebbe logout e
login per cambiare. La cadenza si regola con `DASHBOARD_REFRESH_SECONDS` in
`config/watchdog.conf`, finisce nel JSON e viene riletta a ogni giro.

Dopo una modifica al sorgente dell'estensione: `./bin/install-extension.sh`,
poi logout e login. Non esiste scorciatoia su Wayland.

### Installarla su un altro PC

    ./bin/pack-extension.sh                      # produce dist/*.zip (32 KB)
    # sull'altra macchina:
    gnome-extensions install --force <file>.zip
    # logout e login, poi:
    gnome-extensions enable claude-code-watchdog@cirobox.local

Lo zip porta con sé i quattro script Python e le icone, quindi funziona anche
dove la cartella `fedora_watchdog` non c'è. Serve GNOME Shell 48 o successivo e, per la
sola quota, la CLI `claude` nel PATH.

## Soglie e retention

Tutto in `config/watchdog.conf`: quanti giorni tenere i sottoprodotti di
Claude, il tetto del journal, quanti kernel lasciare installati, le soglie
oltre le quali `/watchdog-check` suona l'allarme. Gli script leggono da lì,
non hanno numeri cablati dentro.

## Target di pulizia

**Sicuri** — inclusi quando non specifichi niente:
`dnf` `journal` `coredump` `logs` `trash` `usercache` `flatpak`
`claude-stubs` `claude-jobs` `claude-snapshots` `claude-paste`
`claude-filehistory`

**Delicati** — solo se li chiedi per nome, e comunque non vengono eseguiti in
automatico: `kernels` `orphans` `claude-dups` `claude-projects`

## Cosa sono le "sessioni-fantasma"

Trascrizioni in cui l'assistente non ha mai risposto: le lascia dietro chi
invoca Claude in modo non interattivo — una statusline che chiama `/usage`, un
hook, uno script SDK. Si rigenerano da sole. Al primo giro qui erano 190.

Su questa macchina le genera l'estensione GNOME `claude-status@oakz.org`
(indicatore di quota nel pannello), che lancia `claude -p "/usage"` a
intervalli. Non consuma token. Dal 2026-09-16 l'intervallo è di 15 minuti
invece di 5 — vedi `CLAUDE.md`, perché un aggiornamento dell'estensione lo
rimette a 5.

## Attenzione

Le trascrizioni in `~/.claude/projects/-tmp/` risultano duplicate ma sono
**backup voluti**: i progetti giravano da `/tmp`, il 2026-09-02 il PC si è
spento e quelle copie sono l'unica cosa che si è salvata. Vedi il README in
`~/Documenti/Claude/`.
