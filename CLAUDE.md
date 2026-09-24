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
    bin/prova-js.sh         esegue le funzioni pure di extension.js con gjs
    bin/prova-shell.sh      carica l'estensione in una GNOME Shell annidata
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

**`~/.cache/claude/staging` non è cache: è l'aggiornamento in volo.** Claude
Code ci scarica la versione nuova, ~220 MB che compaiono in pochi secondi e
spariscono appena il file passa in `versions/`. Contarli faceva sbattere la
barra della cache al massimo e tornare giù a ogni aggiornamento — segnalato
dall'uso il 2026-09-24 e verificato nello storico: `204 → 215 → 223 → 227 →
228 MB` in cinque secondi alle 00:10:55-59, e la versione `2.1.281` scritta
in `versions/` alle 00:10:59, lo stesso secondo. Escluso dalla misura **e**
dal target `claude-cache`, che altrimenti poteva cestinare il download a metà.

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

**Il raccoglitore non rilegge le trascrizioni che non sono cambiate.**
Erano 70 MB e 24.600 righe riparsate ogni dieci minuti per riottenere gli
stessi numeri. `claude-sessions.py` tiene una cache dei metadati per file in
`~/.cache/claude-code-watchdog/sessioni.json`, con chiave su data di modifica
**e** dimensione: la sola data non basta se due scritture cadono nello stesso
nanosecondo, la sola dimensione se una riga ne sostituisce un'altra di pari
lunghezza. `CACHE_VERSIONE` va alzata quando `scan_file()` cambia cosa
restituisce, se no una cache vecchia dà numeri sbagliati senza segnalare
niente. Sta in `~/.cache` perché è rigenerabile, si scrive con rename atomico e
conserva solo i file visti nel giro corrente. Raccolta: **0,69 s → 0,37 s**.

**La deduzione della radice si fa avvelenare dalle sottocartelle, se non
sta attenta.** Con `progetto/src` e `progetto/docs` come cwd, due voti vanno a
`progetto`, che verrebbe eletto radice: i progetti fratelli finirebbero tutti
fuori e ogni sottocartella comparirebbe come progetto a zero sessioni.
**Non si contano i genitori dei `cwd`: si contano i progetti.** Per ogni
possibile radice si guarda quante sue *figlie dirette* contengono almeno un
`cwd`, e vince chi ne ha di più; a parità la meno profonda. Tre versioni di
questa regola hanno sbagliato prima di arrivarci, e ogni volta il difetto era
nella correzione precedente:
1. contando i genitori, `progetto/src` e `progetto/docs` eleggevano `progetto`;
2. ripiegando ogni candidato annidato, una sessione in `~/Documenti/Scaricati`
   spostava la radice a `~/Documenti` e Scaricati diventava un progetto;
3. ripiegando solo i candidati che sono `cwd`, un progetto le cui sessioni
   stanno tutte in sottocartelle non veniva ripiegato e vinceva lui.
Contando i progetti vengono giusti senza casi speciali, **purché i candidati
siano limitati**: `/home` e `/` farebbero anche loro due «progetti» (le home
degli utenti) e, essendo meno profondi, vincerebbero il pareggio. Niente che
stia sopra la home può essere una radice, e la home si confronta **risolta**
perché i `cwd` nelle trascrizioni sono percorsi fisici — `getcwd` scioglie i
collegamenti.
**Limite noto**: se un progetto ha più sottocartelle con sessioni di quanti
progetti abbia la radice (`L/a/src`, `L/a/docs`, `L/a/test` contro `L/b`),
vince `L/a`. Dai soli dati le due letture sono equivalenti; si risolve
scrivendo la radice nelle preferenze. C'è una prova che fissa il
comportamento, così il giorno che la regola cambia si sa che cambia anche
questo. La prova è tabellare (`radice: la regola su tutti i casi noti`) e
verificata con una mutazione sul criterio di parità. Rilevato da `/code-review` il 2026-09-23, riprodotto prima di
correggere. **`/tmp` si scarta come cartella, non come prefisso**: `/tmp/lavoro`
è una radice legittima, e scartare tutto ciò che comincia per `/tmp` rendeva
impossibile provare la deduzione, perché la sandbox di `prova.sh` vive lì.
**Senza radice dedotta `dentroRadice` non si emette**: scrivere `false` su
tutto svuoterebbe la sezione «Progetti» mentre il «+» continua a proporre la
home, e si creerebbe un progetto che poi non compare.

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

## Quanto costa, misurato

    raccolta metriche    0,41 s ogni  600 s   0,07% di una CPU
    lettura quota        2,57 s ogni 1800 s   0,14%  (picco 323 MB)
                                              ----
                                              0,21%

Aprire il popup **non lancia nessun processo**: rilegge il JSON e avvia
l'orologio dell'età, che si ferma alla chiusura. Il costo è tutto nei due
timer, e la quota è la voce più pesante — ma quei 323 MB sono la CLI di
Claude, non codice nostro, e il dato di quota in locale non esiste.

Il 2026-09-23 la raccolta stava a 0,69 s: riparsava 70 MB e 24.600 righe di
trascrizioni a ogni giro per riottenere gli stessi numeri. Con la cache dei
metadati l'inventario è passato da 0,62 s a 0,08 s. Se un domani risale, è lì
che si guarda per primo.

## Come si lavora qui

Regole nate dal 2026-09-23, quando la stessa regola è stata riscritta quattro
volte e ogni correzione conteneva il difetto successivo. Cinque giri di
`/code-review`, quattro difetti trovati dentro le correzioni precedenti.

**1. La tabella dei casi prima del codice.** Toccando una regola con casi
limite — quale cartella è la radice, quale percorso sta dentro quale — si
scrive prima l'elenco dei casi con la risposta attesa, e lo si fa fallire.
Chi implementa senza tabella scopre i casi uno alla volta, dal revisore.

**2. Ogni prova nuova va verificata con una mutazione.** Si rimette il difetto
e si controlla che la prova diventi rossa. Due prove scritte qui passavano col
difetto reintrodotto: una non riproduceva lo scenario, l'altra scriveva JSON
non valido invece del payload voluto. **Una prova che non fallisce mai è
peggio di nessuna prova**, perché autorizza a non guardare.

**3. Una correzione che aggiunge una condizione a una condizione è un
sintomo.** «Si ripiega, ma solo se…», «solo se è anche…»: a quel punto la
regola non è capita. Si riscrive dall'enunciato, non dall'eccezione.

**4. Chi confronta percorsi risolve entrambi i lati e confronta i
componenti.** `resolve()` su tutti e due, e `in p.parents` invece di
`startswith`. Qui è costato quattro difetti distinti: la rete di sicurezza di
`project-purge`, `ammissibile()` in `reclaim`, l'esclusione della home nella
deduzione della radice, la cartella dati del cruscotto.

**5. Un file nasce coi permessi giusti, non li riceve dopo.** `os.open` con il
modo, mai `write_text` seguito da `chmod`: in mezzo il contenuto è leggibile a
tutti, e qui dentro ci sono i nomi dei clienti.

## Prima di dire «fatto»

    ./bin/prova.sh              83 prove funzionali, sandbox con HOME dirottata
    ./bin/prova-js.sh           25 prove sulle funzioni pure di extension.js
    ./bin/prova-shell.sh        carica l'estensione in una shell annidata (~1 min)
    ./bin/verifica-estensione.sh  controlli statici + le prove JS (gira dentro
                                  install e pack, che si fermano se qualcosa
                                  non torna)

**E va caricato in una shell vera.** `prova-shell.sh` avvia una GNOME Shell
annidata **headless** su un monitor virtuale — non tocca la sessione in corso —
e ci attiva l'estensione: enable(), la costruzione del pannello, il timer, il
sottoprocesso. Verifica stato attivo, nessuna eccezione, nessuno stack che
nomini il nostro file. Provata con una mutazione: un `TypeError` dentro
`enable()`, che nessun controllo statico vede, fa scattare tutti e tre i
controlli.
**Non cambia impostazioni**: dconf è condiviso con la sessione vera, e una
prova che modifica le preferenze dell'utente è una prova che fa danni. E il
«dati riscritti» resta un indizio, non un esito: l'estensione della sessione
vera gira in parallelo e riscrive lo stesso file, quindi quel dato può essere
suo.

**Il JavaScript va eseguito, non solo controllato.** Fino al 2026-09-24 nessuna
prova ne eseguiva una riga: si verificavano sintassi, metodi, chiavi GSettings,
classi CSS e campi letti, ma il comportamento no — e su GNOME il comportamento
si vede solo dopo logout e login, quindi un difetto lì resta invisibile per
ore. `prova-js.sh` estrae le funzioni senza dipendenze da GNOME **dal sorgente
vero** (non da una copia, che diverge) e le esegue con `gjs`.

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
