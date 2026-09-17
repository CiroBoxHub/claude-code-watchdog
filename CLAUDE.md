# fedora_watchdog

Manutenzione del PC (Fedora 44) e dei dati di Claude Code: monitoraggio,
pulizia, inventario delle sessioni.

## Regola non negoziabile

**Prima si guarda, poi si cancella. E si cancella nel cestino.**

`session-purge.py` e `project-purge.py` **spostano nel cestino** con `gio trash`,
non cancellano: `--definitivo` serve a cancellare davvero. Il 2026-09-17 sono
andate due conversazioni di `/home/cirobox/Claude` — una da **4380 messaggi** —
perché lì c'era un `unlink()` e basta. L'elenco di conferma era corretto e
l'utente ha confermato; il difetto era non lasciare un'ora di ripensamento su
dati che non si ricostruiscono. Nessuno script di questa cartella
cancella qualcosa senza che l'utente l'abbia visto elencato e abbia detto di
sì. `bin/clean.sh` è in dry-run se non riceve `--apply`, e deve restare così.

Se in una sessione ti viene chiesto "libera spazio" senza altro contesto: fai
il dry-run, mostra l'elenco, chiedi. Anche quando la risposta sembra ovvia.

## Struttura

    bin/scan-system.sh      stato del sistema         — sola lettura
    bin/scan-claude.sh      stato di ~/.claude        — sola lettura
    bin/claude-sessions.py  inventario conversazioni  — sola lettura
    bin/clean.sh            pulizia                   — dry-run di default
    bin/collect-metrics.py  metriche per il cruscotto — sola lettura
    bin/collect-usage.py    quota Claude               — pulisce il proprio scarto
    bin/session-purge.py    rimozione completa di una sessione — elenca, poi --apply
    bin/project-purge.py    rimozione dei dati Claude di un progetto — mai la cartella di lavoro
    bin/project-relocate.py riaggancia un progetto a una cartella spostata
    bin/fix-cwd.py          allinea la cwd dichiarata alla cartella reale
    bin/trash-scaduti.py    elementi del cestino oltre la retention
    bin/prova.sh            collaudo funzionale su dati finti in sandbox
    bin/verifica-estensione.sh controlli statici, obbligatori prima di installare
    bin/install-extension.sh installa l'estensione GNOME
    bin/pack-extension.sh   crea lo zip distribuibile in dist/
    bin/lib.sh              funzioni condivise
    config/watchdog.conf    soglie e retention: si modifica qui, non negli script
    gnome-extension/        sorgente dell'estensione di pannello
    reports/                report datati, per confrontare due momenti

Dati del cruscotto in `~/.local/share/fedora-watchdog/`: `metrics.json`
(fotografia corrente), `usage.json` (quota) e `history.jsonl` (serie storica,
potata a 2000 righe). Cartella `700`, file `600`: contengono i nomi dei
progetti, quindi dei clienti.

**`~/.claude` non è tutto lavoro dell'utente.** Il 2026-09-17 il plugin
`claude-security` si è installato un ambiente Python da **276 MB**, e una
metrica che somma tutto faceva sembrare che fossero cresciute le conversazioni.
`collect-metrics.py` pubblica `conversazioniMb` accanto a `totaleMb` e una
`scomposizione` per cartella; il popup mostra le conversazioni, con il resto
come contesto.

## Prima di dire «fatto»

    ./bin/prova.sh              19 prove funzionali, sandbox con HOME dirottata
    ./bin/verifica-estensione.sh  controlli statici (gira dentro install e pack)

`prova.sh` esiste perché i controlli statici non bastano: dei difetti trovati
dalla revisione del 2026-09-17, tre sarebbero caduti lì — la radice sbagliata
nella copia dentro l'estensione, il cestino potato per mtime invece che per
data di cancellazione, la codifica delle cartelle divergente fra due script.

Il progetto è un **repository git** dal 2026-09-18. `dist/` e `reports/` sono
ignorati, e con loro le copie degli script dentro `gnome-extension/`: le mette
`install-extension.sh` copiandole da `bin/`, e versionarle due volte significa
vederle divergere senza accorgersene.

## Comandi

`/watchdog-check` · `/watchdog-clean` · `/watchdog-sessions`

## Cose da sapere su questa macchina

- **Le trascrizioni in `~/.claude/projects/-tmp/` sono backup voluti.** Il
  2026-09-02 il PC si è spento e i progetti che giravano da `/tmp` hanno perso
  i file di lavoro; le conversazioni si sono salvate solo perché stavano lì.
  Compaiono come "duplicati" negli inventari: non sono spazzatura.
- **La codifica cartella↔percorso in `~/.claude/projects/` non è invertibile.**
  È cambiata tra le versioni (`mattioli_19` è diventato `mattioli-19`), quindi
  il percorso reale di un progetto si legge dal campo `cwd` dentro le
  trascrizioni, mai dal nome della cartella.
- **Una cartella di `projects/` può contenere sessioni di `cwd` diversi.**
  Succede quando un progetto viene spostato e Claude Code continua a scrivere
  nella cartella vecchia. Verificato il 2026-09-16:
  `-home-cirobox-Documenti-Claude-posta-aziendale` ne contiene **tre**
  (`/tmp`, `/tmp/migrazione_posta`, e la sua), `progetto-beta` due.
  **Chi cancella deve abbinare per singolo file, mai per cartella**: una prima
  versione di `project-purge.py` abbinava per cartella e avrebbe cancellato
  l'intera `posta-aziendale`, memorie comprese, cliccando "Elimina" sulla riga
  `/tmp`. Il rilievo è venuto da `/code-review`.
- **`PROJECTS.rglob("*.jsonl")` pesca anche i subagenti.** I file
  `<sessione>/subagents/agent-*.jsonl` hanno risposte dell'assistente ma non
  sono conversazioni: hanno id che `claude -r` non sa riprendere e gonfiano i
  conteggi (33 invece di 23). Si usa `glob("*/*.jsonl")`.
- **`~/.claude.json` non va editato mentre Claude Code gira**: tiene anche i
  permessi accordati e la cronologia, e viene riscritto alla chiusura.
- **Le sessioni-fantasma in `~/.claude/projects/-home-cirobox/` le genera
  l'estensione GNOME `claude-status@oakz.org`**, che mostra la quota Claude nel
  pannello lanciando `claude -p "/usage"` a intervalli. Non consuma token
  (`/usage` è un comando locale), ma ogni giro accende una CLI completa: 1,7 s
  di CPU, 330 MB di picco, una trascrizione da 2,8 KB.
  Il 2026-09-16 l'intervallo è stato portato da 300 a 900 secondi editando
  `REFRESH_SECONDS` in `~/.local/share/gnome-shell/extensions/claude-status@oakz.org/extension.js`
  (originale salvato lì accanto come `extension.js.orig-300s`).
  **L'estensione non ha impostazioni** — l'intervallo è una costante nel
  sorgente — e `update-extension@purejava.org` aggiorna le estensioni in
  automatico: **un aggiornamento rimette i 300 secondi senza avvisare.** Se gli
  stub tornano a comparire ogni 5 minuti, è successo questo.
  **`gnome-extensions disable/enable` NON ricarica il codice**: GNOME Shell
  tiene in cache il modulo ES già importato, quindi `REFRESH_SECONDS` resta al
  valore vecchio anche se il file su disco è cambiato. Verificato il
  2026-09-16: file a 900, comportamento ancora a 300. Serve un riavvio della
  shell, che su Wayland vuol dire **logout e login**.
  Per controllare se il nuovo valore è attivo: svuota
  `~/.claude/projects/-home-cirobox/` e guarda a che distanza compare lo stub
  successivo.
- `dnf5 repoquery --unneeded` elenca come "non necessari" anche pacchetti
  installati a mano (`7zip`, `arj`, `cabextract`). Non è una lista da eseguire
  alla cieca.

## Estensione GNOME

Tutto quello che riguarda l'estensione di pannello — regole di scrittura,
estetica, colori e contrasto, suggerimenti, icone, terminale di «Riprendi»,
controlli prima di installare — sta in `gnome-extension/CLAUDE.md`, che si
carica da solo quando si lavora in quella cartella.

## Quota Claude

Dal 2026-09-16 la quota la legge `bin/collect-usage.py`, che sostituisce
l'estensione `claude-status@oakz.org`. Due differenze che contano:

- **Rimuove la trascrizione che l'invocazione stessa genera.** È l'unico modo
  per leggere la quota senza accumulare sessioni-fantasma. La cancellazione
  avviene solo se il file non contiene nessuna risposta dell'assistente: se per
  una corsa sfortunata comparisse una conversazione vera, resta intatta.
- **Legge il record `usageReport.rate_limits`** dalla trascrizione, non la
  regex sul testo per l'utente. È dato strutturato: `kind`, `percent`,
  `resets_at`, `severity`.

**«Sessione» non è la giornata.** È una finestra mobile di circa cinque ore che
riparte dal primo uso: verificato il 2026-09-17, azzeramento alle 13:59 letto
alle 09:05, mentre il giorno prima cadeva alle 17:10. Per questo l'etichetta è
«Sessione corrente» e sotto la percentuale si scrive **l'ora esatta**
dell'azzeramento e non solo il relativo: «fra 5 ore» lascia pensare a una quota
giornaliera.

I due limiti hanno `gruppo` `session` e `weekly`, e `tipo` `session`,
`weekly_all`, eventualmente `weekly_opus`. Il pannello prende il **massimo** fra
i limiti dello stesso gruppo: con due settimanali diversi, mostrare il primo
nasconderebbe quello che morde davvero.

Il dato di quota **non esiste in locale**: `policy-limits.json` riguarda le
restrizioni, `stats-cache.json` è l'attività storica. Serve la chiamata.

## Stile

Italiano. Asciutto. I numeri contano quando si muovono: un disco al 14% non è
una notizia, un disco che è passato dal 14% al 40% in una settimana sì.
