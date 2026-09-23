# claude-code-watchdog

Manutenzione del PC (Fedora 44) e dei dati di Claude Code: monitoraggio,
pulizia, inventario delle sessioni.

## Regola non negoziabile

**Prima si guarda, poi si cancella. E si cancella nel cestino.**

`session-purge.py` e `project-purge.py` **spostano nel cestino** con `gio trash`,
non cancellano: `--definitivo` serve a cancellare davvero. Il 2026-09-17 sono
andate due conversazioni di `~/Claude` — una da **4380 messaggi** —
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
    bin/clean.sh            pulizia completa, solo Fedora — dry-run di default
    bin/reclaim.py          pulizia portabile per l'estensione — dry-run di default
    bin/segnala.py          mette in coda un percorso perché il pannello lo mostri
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

Dati del cruscotto in `~/.local/share/claude-code-watchdog/`: `metrics.json`
(fotografia corrente), `usage.json` (quota) e `history.jsonl` (serie storica,
potata a 2000 righe). Cartella `700`, file `600`: contengono i nomi dei
progetti, quindi dei clienti.

**`~/.claude` non è tutto lavoro dell'utente.** Il 2026-09-17 il plugin
`claude-security` si è installato un ambiente Python da **276 MB**, e una
metrica che somma tutto faceva sembrare che fossero cresciute le conversazioni.
`collect-metrics.py` pubblica `conversazioniMb` accanto a `totaleMb` e una
`scomposizione` per cartella; il popup mostra le conversazioni, con il resto
come contesto.

**Le versioni vecchie di Claude Code pesano più di tutto il resto.**
`~/.local/share/claude/versions/` ne tiene una per aggiornamento, ~220 MB
l'una, e non ne toglie mai nessuna: il 2026-09-21 erano quattro, 883 MB, contro
i 394 MB di tutto ciò che il cruscotto misurava. Il target `claude-versions`
tiene le `CLAUDE_KEEP_VERSIONS` più recenti più quella in uso. **Quella in uso
si ricava risolvendo il link di `claude`, mai dal numero più alto**: dopo un
aggiornamento andato male `claude install` può aver riportato indietro il link,
e in quel caso la più recente sarebbe proprio quella da non toccare. Se non si
riesce a stabilire quale sia, `versioni_vecchie()` torna una lista vuota: non
si indovina.

**Le segnalazioni sono l'unico modo per far arrivare nel pannello una cosa che
nessuna categoria conosce.** `segnala.py` scrive un percorso in
`segnalati.jsonl`, `collect-metrics.py` lo pubblica fra le voci recuperabili,
il pulsante lo cestina. **Il pannello non accetta percorsi digitati** — un
campo di testo che cancella sarebbe l'opposto di tutto il resto. `reclaim.py`
agisce solo su percorsi che ritrova nella coda, qualunque target gli venga
passato, e rivaluta i controlli al momento di cancellare: fra la segnalazione e
il clic può essere nato un progetto proprio lì dentro.

**`collect-metrics.py` importa `reclaim` invece di rifare i conti.** Le due
voci nuove le calcola chi poi cancella, così il numero annunciato e quello
liberato non possono divergere. L'import è dentro un `try`: se la copia dentro
l'estensione fosse incompleta, mancano quelle due voci e non tutto il
cruscotto. `verifica-estensione.sh` controlla anche gli `import` fra script
fratelli, non solo le chiamate per nome.

**L'estensione può finire su una distribuzione qualsiasi.** Purché ci sia
GNOME: `metadata.json` dichiara 48, 49 e 50. Gli script che viaggiano dentro
di lei invocano solo `du`, `gio`, `gsettings` e `claude` — mai `dnf5`, mai
`rpm`, mai percorsi sotto `/var`. Le parti specifiche di Fedora stanno in
`scan-system.sh` e `clean.sh`, che non vengono copiati. Il pulsante «Libera
spazio» chiama `reclaim.py`, non `clean.sh`: quest'ultimo si cercava dentro il
checkout del progetto — che in un'installazione normale non esiste — e il
pulsante rispondeva «Niente di selezionato» anche con tutto spuntato, qui come
altrove. `reclaim.py` fa solo i sette target portabili (cestino, `~/.cache`,
scarti di Claude), non chiede privilegi, ed è in dry-run senza `--apply`.
Serve **Python 3.10** o superiore: le annotazioni `Path | None` si valutano a
runtime.

**«Dentro la radice» vuol dire a qualunque profondità, e lo decide Python.**
Il 2026-09-23 un progetto creato col «+» è comparso fra quelli «fuori dai
progetti»: dentro ci era nata una sottocartella e una sessione ci aveva
lavorato, quindi il suo `cwd` era `progetto/Electra`. La regola in
`extension.js` confrontava **solo il genitore** con la radice, e una
sottocartella non è figlia diretta. Succede ogni volta che si lavora dentro un
repository clonato nel progetto, cioè spesso.
Ora la calcola `collect-metrics.py` (`dentro_radice()`) e la pubblica come
`dentroRadice` su ogni progetto; l'estensione la legge e basta. Il motivo non è
estetico: **in JavaScript quella regola non si può provare**, in Python sì, e
ora cinque prove coprono figlia diretta, annidata, fuori, radice ignota e il
tranello del prefisso (`~/Documenti/Claude-vecchio` comincia come
`~/Documenti/Claude` ma non è dentro niente — il confronto è sui componenti del
percorso, non sul testo).
**Le righe annidate non si fondono con quella del progetto padre.**
`project-purge.py` abbina per `cwd` esatto: una riga che sommasse due sessioni
direbbe «2» e ne cancellerebbe una sola, in silenzio. Restano righe distinte, e
il nome porta il percorso relativo (`electra-release/Electra`) perché due
sottocartelle `src` di progetti diversi non si chiamino uguale.

**La radice dei progetti si deduce, non si indovina.** L'impostazione
`projects-root` ha come default la stringa vuota, che per lo schema significa
«rilevamento automatico». Il rilevamento stava in `extension.js`, che lo
ricavava da `progetto` — e `progetto` è `null` per costruzione quando lo script
gira copiato dentro l'estensione, cioè in uso normale: l'automatismo promesso
dalle preferenze non ha mai funzionato da installato. Dal 2026-09-21 la deduce
`collect-metrics.py` dai progetti già noti (la cartella che ne contiene di più,
almeno due, mai la home né `/tmp`) e la pubblica come `radiceProgetti`.
L'estensione la passa con `--radice-progetti` solo quando l'utente ne ha
scritta una a mano. **Lo script non legge gsettings**: lo schema non è
installato a livello di sistema, e una seconda copia della regola di scelta è
una copia che diverge.

## Prima di dire «fatto»

    ./bin/prova.sh              53 prove funzionali, sandbox con HOME dirottata
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
  È cambiata tra le versioni (`cliente_alfa` è diventato `cliente-alfa`), quindi
  il percorso reale di un progetto si legge dal campo `cwd` dentro le
  trascrizioni, mai dal nome della cartella.
- **Una cartella di `projects/` può contenere sessioni di `cwd` diversi.**
  Succede quando un progetto viene spostato e Claude Code continua a scrivere
  nella cartella vecchia. Verificato il 2026-09-16:
  `-home-utente-Documenti-Claude-posta-aziendale` ne contiene **tre**
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
- **Le sessioni-fantasma in `~/.claude/projects/-home-utente/` le genera
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
  `~/.claude/projects/-home-utente/` e guarda a che distanza compare lo stub
  successivo.
- **Se le finestre si aprono lente, sono le estensioni di GNOME: due, non
  una.** Il 2026-09-22 dialoghi e avvii di app impiegavano secondi.
  `burn-my-windows` anima apertura e chiusura di ogni finestra e aveva **due**
  effetti accesi insieme (`glitch` e `tv`); spenta, i dialoghi sono tornati
  immediati ma l'avvio delle app no. Il resto era **`dash-to-panel`**, che si
  mette in mezzo all'avvio: spenta anche quella, veloce. È di serie in tutto —
  nessuna sua opzione differisce dal default — quindi non c'è niente da
  regolare: o la si tiene col ritardo o si sta senza.
  Non serve logout: `gnome-extensions disable` ha effetto subito, perché lì non
  si ricarica codice, si ferma e basta.
  **Il colpevole non è l'applicazione.** Dal journal: scope creato alle
  17:56:33.481, primo disegno a 17:56:33.700 — 219 ms. Scartati prima, con
  misura: enumerazione delle cartelle (3 ms), rete e GVfs (7 ms), indicizzatore
  fermo, nessuna unità utente in errore, PSI a zero su CPU, memoria e I/O con
  20 GB liberi e swap intatta, GPU a posto (la shell rende sull'AMD integrata,
  la NVIDIA è sveglia a P8 — niente attese di risveglio).
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
