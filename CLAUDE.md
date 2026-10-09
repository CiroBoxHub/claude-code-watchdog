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
    bin/watchface-hook      hook di Claude Code per Watchface — bash, niente output
    bin/watchface-hooks.py  mette, toglie e ripristina gli hook in settings.json
    bin/fotografa-pannello.sh foto di barra, popup e preferenze (shell annidata)
    bin/fotografa-icone.sh  foto delle icone come le disegna la shell
    bin/fotografa-preferenze.sh foto di ogni pagina delle preferenze, chiaro e scuro
    bin/simula-watchface.sh fa passare Watchface per tutti gli stati, sessioni finte
    bin/dati-demo.py        home finta con progetti inventati, per le foto pubbliche
    grafica/mascotte.py     disegna la mascotte e consegna le icone in icons/
    bin/install-extension.sh installa l'estensione GNOME
    bin/pack-extension.sh   crea lo zip distribuibile in dist/
    bin/lib.sh              funzioni condivise
    config/watchdog.conf    soglie e retention: si modifica qui, non negli script
    mods/watchdog/          mod di Claude Code: quota e aiutanti dal motore
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

Lo stesso inciampo era rimasto in `_apriPulizia`, e lì bloccava tutto prima:
`collect-metrics.py` pubblica `progetto: null` quando gira dalla cartella
dell'estensione invece che da `<progetto>/bin` — cioè **sempre**, perché il
pannello lancia la copia installata, e `_radici()` lo fa per scelta. La
condizione `!progetto || !voci.length` scattava a ogni apertura: «Progetto
watchdog non trovato» con tre voci pronte da cestinare. Segnalato dall'uso il
2026-10-01. Il checkout non serve a niente qui, `reclaim.py` viaggia dentro
l'estensione: decide `voci.length` e basta.

Il campo **oscilla**, e questo spiega perché il difetto sembrava capriccioso:
`install-extension.sh` chiude facendo una raccolta da `$WD_ROOT/bin/`, che la
radice la trova. Subito dopo l'installazione `progetto` c'è e il pulsante
funziona; al primo giro del timer del pannello la raccolta riparte dalla copia
installata, riscrive `null`, e da quel momento il pulsante non apre più niente.
Verificato alternando i due:

    copia installata → progetto: None
    da <progetto>/bin → progetto: '/opt/extension/claude-code-watchdog'

**Morale che vale oltre questo caso**: quando si toglie la dipendenza dal
checkout da una funzione, va cercata in tutte. `progetto` resta pubblicato in
`metrics.json` ed è giusto così — serve a chi lavora dal progetto — ma non può
essere la condizione che abilita un pulsante dell'estensione installata.

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

**Le sessioni automatiche orfane si tolgono in blocco, i backup no.**
Il 2026-10-03 il pannello mostrava 62 righe «fuori dai progetti», una per
cartella: le aveva lasciate `skillspector`, che lancia Claude via SDK in una
`/tmp/skillspector_cli_*` diversa per ogni analisi. Il target `claude-orfane`
le prende tutte insieme, ma **la regola vuole due condizioni**:
`entrypoint` che comincia per `sdk-` (avviata da un programma) **e** cartella
di lavoro sparita. «Cartella sparita» da sola pescherebbe i backup interattivi
dei progetti persi con `/tmp` (vedi sotto); «avviata da un programma» da sola,
le automazioni di progetti vivi. Senza `entrypoint` — trascrizioni di versioni
vecchie — non si indovina. Si cestina per trascrizione, e la cartella di
`projects/` si toglie con `rmdir` solo se è rimasta vuota. La regola sta in
`orfane_automatiche()` di `claude-sessions.py`, usata sia dal conteggio del
pannello sia da `reclaim.py`; otto casi in `prova.sh`, ognuno verificato con
una mutazione. **`clean.sh` non ha questo target**: il pulsante usa `reclaim.py`.

**I consigli sulla quota si calcolano, non si copiano da `/usage`.** `/usage`
chiude con «What's contributing to your limits usage?», ma è solo testo
inglese per l'utente, non dato strutturato: estrarlo si romperebbe al primo
cambio di formato, e comunque dice *quanto* pesa il contesto lungo, non
*dove*. Il 2026-10-03 il «51% oltre 150k» veniva quasi tutto da una sola
sessione di `agg_dell_fedora`, aperta da 23 giorni. `claude-sessions.py` conta
per sessione `n_req` e `n_grande` (contesto oltre `CONTESTO_GRANDE` = 150k,
la soglia di `/usage`) dal campo `usage` di ogni risposta; `consigli_quota()`
in `collect-metrics.py` ne ricava al massimo tre, con le soglie
`QUOTA_CONSIGLIO_*` in `watchdog.conf`, e li pubblica in `consigliQuota`. Un
messaggio occupa **più righe con lo stesso id**, una per blocco: si conta al
primo, e `ultimo_mid` passa nella cache perché la lettura incrementale può
ripartire a metà di un messaggio. Le percentuali di quota restano quelle di
`/usage`, verificate identiche il 2026-10-03.
**Il consiglio guarda il contesto di adesso, e riparte da ogni `/compact`.**
Contando tutta la vita della sessione, «fai /compact» restava anche dopo
averlo fatto (segnalato dall'utente il 2026-10-04). Claude Code scrive una riga
`system`/`compact_boundary` con `postTokens`: lì `n_req` e `n_grande` si
azzerano, `ctx_ultimo` riparte dal contesto rimasto e `compattata` segna da
quando contare i giorni. Senza un'ultima richiesta oltre 150k non c'è
consiglio. **E una sessione ferma da più di 12 ore non ne ha**
(`QUOTA_CONSIGLIO_INATTIVA_ORE`): con la finestra di 7 giorni, chi seguiva il
consiglio e apriva una sessione nuova se lo vedeva ripetere per una settimana
sulla vecchia. Ogni consiglio sparisce quando viene seguito: `/compact` azzera
i conti al giro dopo, una sessione nuova lascia ferma la vecchia.

**La copia installata legge il `watchdog.conf` che le sta accanto.** Fino al
2026-10-03 `conf()` tornava `{}` quando `ROOT` è `None` — cioè sempre, per il
pannello — e ogni soglia del file veniva ignorata: colori, scadenze, consigli.
Stessa famiglia del difetto di `progetto` qui sopra. `install-extension.sh` ora
mette nella cartella dell'estensione un **collegamento** a `config/watchdog.conf`
(una modifica vale subito) e `pack-extension.sh` una copia vera. Trovato da
`/code-review`.

**Watchface, revisione del 2026-10-03: dieci rilievi, tutti corretti.** I tre
che contavano: l'hook faceva leggi-modifica-scrivi senza lock, e venti aiutanti
avviati in parallelo ne contavano otto (ora `flock -w 2` e rinomina atomica);
Claude Code non manda `Stop` quando si interrompe con Esc o si nega un permesso,
quindi gli stati scadono col silenzio (10 minuti fra un passo e l'altro, un'ora
con uno strumento in esecuzione o un permesso in attesa); `watchface-hooks.py`
raggruppava gli hook degli altri per interprete, e «Rimuovi» su un
`python3 …` li avrebbe tolti tutti — ora si identificano per percorso dello
script, e gli hook senza comando non si toccano mai.
**Gli aiutanti si contano per id, non con un contatore.** Registrando gli
eventi veri: Claude Code manda `SubagentStop` anche per agenti interni mai
partiti (`agent_type` vuoto), che toglievano il robot a un aiutante vero; e
un aiutante che aspetta un lavoro in background manda `SubagentStop`, poi di
nuovo `SubagentStart` quando si risveglia. L'elenco degli id sta in
`<sessione>.aiutanti`, accanto alla riga di stato. **La lettura della quota è
anch'essa una sessione di Claude**: compariva come «box» a ogni «Aggiorna».
`collect-usage.py` la lancia con `WATCHFACE_IGNORA=1` e l'hook la salta.
In generale l'hook salta ogni sessione con `CLAUDE_CODE_ENTRYPOINT=sdk-…`
(misurato: `cli` nel terminale, `sdk-cli` con `-p`), la stessa regola delle
orfane automatiche. **Il clic su una riga porta al terminale** risalendo da
`CLAUDE_PID` (sesto campo della riga) agli antenati fino al primo che
possiede una finestra; ci si ferma alla shell, che è antenata dei terminali
aperti da «Riprendi». Ptyxis non espone l'id della scheda al processo figlio
(ha `focus-tab-by-uuid`, ma l'uuid non arriva nell'ambiente): con più schede
nella stessa finestra si arriva alla finestra, non alla scheda.
**Quando approvi un permesso Claude Code non manda nessun evento** (verificato
il 2026-10-04 registrando gli hook: PermissionRequest alle 00:37:29,
PostToolUse alle 00:37:55, nulla in mezzo; c'è `PermissionDenied`, ma non un
«concesso»). La faccina restava «aspetta te» per tutta la durata del comando,
segnalato dall'utente. Ora, finché una sessione aspetta un permesso, Watchface
legge una volta al secondo i figli del processo di Claude: il comando
approvato è un figlio nuovo (`bash -c …`), visto nascere nello stesso secondo
dell'approvazione. Regola in `approvazioneVista()`: due letture di fila, e il
nostro hook non conta. Vale per i comandi che avviano un processo; un Write o
un Edit approvato finisce comunque in un attimo. Provato dall'utente dal vivo
lo stesso giorno: la faccina torna subito a «lavora».
**Il /compact è il limone con gli occhi all'insù** (stato `compatta`, idea
dell'utente: «povero limone solo per gli errori»). Il limone resta giallo: il
blu è del bordo del disco della mascotte (e della tinta nella barra), come
ha chiarito l'utente. Il disco della mascotte respira (opacità 255↔165,
`_pulsa()` in `fumetto.js`) in aspetta, errore e lavora; mai con le
animazioni di GNOME spente. Eventi registrati il 2026-10-04 con Claude Code
2.1.289: `PreCompact` (con `trigger` manual o auto), poi `SessionStart` con
`source: "compact"`, poi `PostCompact`; **nessun UserPromptSubmit e nessuno
Stop**, per questo la faccina restava sullo stato di prima. La fine si legge
da `SessionStart(compact)`, che c'è anche nelle versioni senza PostCompact. Il
trigger arriva solo all'inizio e resta nel nome dell'evento (`PreCompact`,
`PreCompactAuto`): finito quello a mano si scrive `Stop` (tocca a te),
finito quello automatico `PostToolUse` (Claude riprende il turno). Prima
quel SessionStart azzerava gli aiutanti, che dopo un compact automatico sono
ancora al lavoro. Per gli altri lavori «non conversazione» gli hook non danno
segnali distinguibili. Chi aggiorna deve reinstallare gli hook (la pagina
dice «Installati in parte»).

**Da Claude Code 2.1.291 una sessione non è più un terminale.** Per il lavoro
in background Claude avvia **processi `claude` figli**, e il demone ne tiene di
riserva già accesi (`claude bg-spare`). Ognuno ha un `session_id` suo, quindi
l'hook gli scrive il suo file di stato e il pannello li mostrava come sessioni
a sé: un terminale solo compariva come tre righe con lo stesso nome di
progetto, che si leggono come tre copie. Segnalato dall'uso il 2026-10-06 e
verificato sull'albero dei processi — i pid 2312568, 2312569 e 2312570 erano
tutti discendenti del 1861003, che era la sessione aperta in un terminale.
`parentela()` in `watchface.js` dice, per ogni sessione, chi l'ha avviata e se
è impianto: le riserve spariscono dall'elenco (i loro aiutanti no, si contano a
chi le ha avviate), le altre si annidano sotto la madre con `ordinaAlbero()`.
Il padre è **il primo antenato che è una sessione vera**, così un nipote si
attacca al nonno quando in mezzo c'è solo impianto, senza una regola a parte.
**La parentela si legge dai processi, che però muoiono.** Una figlia finita
lascia la sua riga (visibile fino a `VISIBILE_S`) ma non ha più antenati da
interrogare, e tornerebbe a galla come doppione: misurato sui dati veri, di tre
figlie dello stesso terminale una sola si annidava ancora. `ricordaPadri()`
tiene quello che si è capito finché la riga c'è, e pota da sé.

**Gli aiutanti si contano per id, ma gli id vanno fatti scadere.** Il
2026-10-06 una sessione ne mostrava **sette**, fermi dalle 11:52 e ancora
contati alle 15:40: le trascrizioni in `subagents/` dicevano che avevano finito
da quattro ore. La causa è la stessa di sopra — gli aiutanti in background
girano nei processi figli, con un `session_id` loro, quindi lo `SubagentStart`
finisce nel file del padre e lo `SubagentStop` in quello del figlio, dove la
rimozione cerca un id che lì non c'è. `<sessione>.aiutanti` ora tiene
`id <TAB> epoca` e si pota a **ogni** evento, non solo ai `Subagent*`: una
sessione al lavoro ne manda di continuo, così il numero scende da sé. Il prezzo
è dichiarato: un aiutante che lavora davvero più di un'ora smette di essere
contato — meglio uno in meno che sette che non esistono. Le righe del formato
vecchio, senza epoca, si buttano.
**Due cause sono state escluse con la prova, non a naso**: venti
`SubagentStart` e venti `SubagentStop` in parallelo danno 20 e poi 0, quindi
non è contesa sul lock; e il rapporto finale di un aiutante pesa 1,5 KB, quindi
non era lui a sfondare la testa letta. **Il troncamento però esisteva**: con
`agent_id` oltre gli 8192 byte lo Stop non toglieva niente, riprodotto con un
payload da 9 KB. Per i soli eventi `Subagent*` l'hook ora legge 256 KB.

**`read` con `IFS=$'\t'` fonde i campi vuoti, e questo ha un prezzo.** La
tabulazione è uno dei separatori «bianchi» di bash: due di fila contano come
una, e un campo vuoto in mezzo sparisce. La riga di stato di Watchface ha il
pid vuoto quando Claude Code non lo passa, quindi sette campi ne davano sei e
tutto ciò che veniva dopo slittava di uno — il campo `riserva` andava perso a
ogni evento. Finché si leggevano solo i primi cinque campi non si vedeva. Ora i
campi si spezzano a mano con `${riga%%$'\t'*}`, che non fonde niente e non
forka. **Preso da una prova**, non a occhio: la prova che controllava la
persistenza del campo è diventata rossa al primo giro.

**Due giri di `/code-review` sulla stessa giornata, sei rilievi, cinque dentro
le correzioni del giro prima.** Vale la pena elencarli perché sono tutti della
stessa famiglia — una regola nuova che non si guarda attorno:
1. lo stato `aiutanti` spezzava la sequenza che fa scattare «Claude ha finito»
   (`lavora → aiutanti → finito` non passa mai dal confronto), e la notifica
   spariva proprio nei turni lunghi, che sono quelli per cui esiste;
2. la potatura degli aiutanti girava solo all'arrivo di un evento, cioè mai in
   una sessione ferma — il caso da cui era partito tutto. Ora li conta il
   pannello (`contaAiutanti`) rileggendo le epoche a ogni giro;
3. l'elenco si scriveva con un troncamento mentre il pannello lo legge **senza
   lock**: una lettura caduta in quell'istante avrebbe fatto scattare un «ha
   finito» falso. Temporaneo più rinomina, come la riga di stato;
4. il taglio a cinque righe avveniva **dopo** l'annidamento, quindi le figlie
   di una sessione in cima mangiavano i posti a sessioni più urgenti. Prima si
   taglia, poi si annida;
5. lo stato `aiutanti` non aveva la sua regola CSS e prendeva lo stesso verde
   di `finito`, cioè proprio quello da cui deve distinguersi.
   `verifica-estensione.sh` non può prenderlo: raccoglie i nomi di classe
   scritti per esteso, non quelli composti;
6. il pareggio fra due righe con lo stesso pid diceva «vince la prima», ma le
   righe arrivano nell'ordine del disco: «la prima» voleva dire «a caso». Il
   sistema riusa i pid e una riga sopravvive dodici ore, quindi il caso è
   raggiungibile: ora vince la più recente.

**La riserva si dichiara nella riga, non si deduce dal processo.** `bg-spare`
si riconosce dalla riga di comando, che sparisce col processo mentre la riga
resta visibile per ore: dopo un riavvio della shell una riserva morta
ricompariva come riga doppia — il difetto che si stava correggendo.
L'hook lo scrive una volta, all'avvio della sessione, nel settimo campo.
`ricordaPadri()` copre il caso dentro la stessa sessione della shell, il campo
copre il riavvio.

**Una riserva ceduta e' una sessione vera, e la riga di comando non lo dice.**
Il 2026-10-08 un progetto (su un altro PC) non compariva nel
pannello mentre era aperto — segnalato dall'uso. Il pid 3152601 era ancora
`claude bg-spare --bg-spare .../e5387224.claim.sock` e ospitava la
conversazione `71e45a0a`, trentuno prompt scritti a mano: quando il demone
cede una riserva a una sessione il processo resta quello, con la sua riga di
comando, e noi la nascondevamo come tubatura. **L'ambiente non distingue**:
`CLAUDE_CODE_SESSION_KIND=bg` e `CLAUDE_BG_BACKEND=daemon` erano identici
nella riserva libera (pid 3529221) e in quella ceduta. **Gli antenati nemmeno**:
entrambe risalgono a `bg-pty-host` e poi a `systemd --user`, non al terminale,
quindi `parentela()` non poteva cavarsela con la catena dei pid.
Quello che cambia e' la **cartella di lavoro**: `/tmp/cc-daemon-<uid>/<id>/spare`
finche' la riserva e' libera, la cartella del progetto appena e' ceduta.
Percio' riserva vuol dire `bg-spare` **e** `cartellaDelDemone(cwd)`, nell'hook
e nel pannello. Due conseguenze volute:
- **finche' il processo e' vivo decide lui**, perche' sa anche se la riserva e'
  stata ceduta; la dichiarazione nel settimo campo vale quando il processo non
  c'e' piu', che e' il motivo per cui quel campo esiste. Senza questo una
  sessione ferma — nessun evento in arrivo — sarebbe rimasta nascosta per ore
  anche dopo la correzione;
- **l'hook ritira la dichiarazione** al primo evento che mostra una cartella
  vera, nel caso il `SessionStart` arrivi prima del cambio di cartella. Costa
  due fork, pagati solo all'avvio di una sessione o finche' una riserva resta
  dichiarata.
Provato con processi veri (`exec -a` per la riga di comando, un `cd` per la
cartella) e non con un `/proc` finto: cinque prove in `prova.sh`, quattro in
`prova-js.sh`. E verificato sui dati veri di quel momento — le stesse righe di
stato e lo stesso `/proc` davano `impianto=true` col codice di prima e
`impianto=false` con quello nuovo.

**Un mod di Claude Code, perche' due cose da fuori non si vedono.**
`mods/watchdog/` e' un plugin di hook-funzione che gira **dentro** il processo
di Claude Code. Non sostituisce l'hook: scrive **gli stessi file** (`usage.json`
e `<sessione>.aiutanti`), quindi il pannello non cambia di una riga e senza il
mod si torna esattamente a prima. Si attiva scrivendo la sua cartella in
`env.CLAUDE_CODE_PLUGIN_DIRS` di `~/.claude/settings.json` — lo stesso file
degli hook, e lo stesso pulsante: per chi installa e' una cosa sola. Misurato
prima di scegliere la forma: funzionano sia `--plugin-dir` sulla cartella del
plugin sia sulla cartella che lo contiene, e `CLAUDE_CODE_PLUGIN_DIRS` e'
documentato proprio per le sessioni dove non si puo' passare un flag, cioe'
quelle che avvia l'app desktop. `mod-attiva` e `mod-disattiva` ci sono perche'
gli hook sono la base e il mod il miglioramento: se un giorno fosse lui a dare
problemi si torna alla base senza restare al buio. Vale per le sessioni
avviate **dopo**, come gli hook.

**La quota non si sa all'avvio della sessione.** Misurato: in un `claude -p`
`$.session.usage().rateLimits` torna `[]` a `session.start`, e si popola solo
con la prima risposta del modello — `session.measure` scatta con
`changed=["context","rateLimits","cost"]` e i limiti dentro. Quindi il mod non
rende inutile `collect-usage.py`: lo rende **l'eccezione**. Una sessione appena
aperta che non ha ancora parlato non ha quota da pubblicare, il file invecchia,
e la lettura con la CLI riparte da se'. I numeri sono stati verificati contro
la CLI nello stesso minuto: settimanale 39 in entrambi, azzeramenti uguali al
secondo (17:29:59.95 contro 17:30:00).
**Il risparmio pero' non c'era, e la prima versione di questa riga mentiva.**
Il controllo sull'eta' stava solo in `_riprogrammaQuota`, cioe' nel colpo
iniziale; il timer periodico chiamava `_leggiQuota()` comunque, quindi la CLI
si accendeva ogni mezz'ora anche col file fresco. Ora la condizione sta
**dentro `_leggiQuota`**, dove passano tutti, e il pulsante «Aggiorna» la
scavalca con `{forza: true}` perche' l'ha chiesto l'utente. Rilevato da
`/code-review` il 2026-10-08: una funzione nuova che promette un risparmio va
verificata sul chiamante che conta, non su quello che si e' appena scritto.
**Il vocabolario non coincide**: il motore dice `five_hour` e `seven_day`, la
trascrizione di `/usage` diceva `session` e `weekly_all`. La traduzione sta in
una funzione sola (`voci()` in `mods/watchdog/hooks/quota.ts`) perche' e'
l'unico posto dove avviene. `spend_limit` si scarta: e' il tetto di spesa di un
gateway, non una finestra di quota.
**Prezzo dichiarato**: il motore espone solo quelle due finestre, quindi un
`weekly_opus` — che la CLI vedeva — il mod non lo scrive. Il campo
`fonte: "mod"` nel file dice chi l'ha scritto, se no un limite mancante
sembrerebbe sparito senza motivo. Su questo account non c'e'; il giorno che ci
fosse, si rimette la CLI a cadenza lunga.

**Gli aiutanti: il mod corregge l'elenco, non lo sostituisce.** L'hook tiene
`id <TAB> epoca` e li fa scadere a un'ora perche' lo `SubagentStop` di un
aiutante in background finisce nel file del processo figlio. Il mod sta nel
ciclo del padre e puo' chiedere `$.agent.list()`, che da' lo stato di ogni
agente:
- un id che il motore dice `completed`/`failed`/`killed` si toglie **subito**,
  non dopo un'ora: e' il difetto del 2026-10-06;
- un id vivo tiene l'epoca fresca, quindi **il prezzo dichiarato della
  scadenza sparisce**: un aiutante che lavora davvero due ore resta contato;
- un id vivo che manca dall'elenco si aggiunge;
- un id che il motore **non nomina non si tocca**: resta dell'hook, con la sua
  scadenza. Correggere non vuol dire sostituire, e questa e' la riga che tiene
  il mod e l'hook dalla stessa parte invece di farli divergere.
`idle` non conta: e' un compagno di squadra fra due turni, e l'hook non lo
contava nemmeno (un aiutante che aspetta manda `SubagentStop`).
**Due scrittori sullo stesso file, e il mod non prende il lock dell'hook.**
Scrivono entrambi su temporaneo e rinomina, quindi nessun lettore vede un file
a meta' — era il difetto da cui veniva il «Claude ha finito» falso — e un
aggiornamento perso torna al giro dopo, dieci secondi. Prendere il lock
vorrebbe dire un fork per giro, che e' il costo che si sta togliendo.

**Tre cose imparate scrivendo un mod, che non erano ovvie:**
1. **il motore rifiuta `$` passato a una funzione dichiarata dentro
   `register`**: l'aiutante deve stare in cima al file. Lo dice
   `claude plugin validate` con il numero di riga, e non e' un dettaglio di
   stile — senza, il modulo non carica;
2. `agent.spawn` e' un hook che **puo' negare**: un inciampo nostro
   impedirebbe l'avvio di un aiutante. Un osservatore la' dentro vuole
   `.catch(($, e, next) => next(e))`, se no un difetto in una riga di
   contabilita' blocca il lavoro;
3. **`$.fs.write` non sa dare un modo ai file.** La cartella dati nasce 700 e
   i file 600 perche' contengono i nomi dei progetti, cioe' dei clienti
   (regola 5). Il mod quindi **non crea nessuna cartella**: se non c'e'
   ancora, sta zitto. Le creano il pannello e l'hook. E scrive con un
   `sh -c` che fa `chmod` e `mv`, un fork per cambiamento vero — niente
   cambia, niente si scrive.

**La regola delle mutazioni vale anche qui.** `claude plugin test` esegue le
`*.test.ts` contro il motore vero: quattordici mutazioni, ognuna fa rossa la
prova giusta. Una prova passava col difetto rimesso — una voce senza `id` con
stato `completed` non toglie niente comunque, serviva uno stato **vivo** per
vedere la riga `undefined` comparire nel file. E due prove di `prova.sh`
passavano su un **traceback** invece che su un rifiuto: «il file e' rimasto
com'era» lo lascia anche un programma che muore prima di scrivere, quindi ora
si controlla il messaggio. E' la terza volta che questo tranello costa una
prova inutile in questo progetto.

**Non c'e' prova automatica del cancello.** Il mod si ferma sulle sessioni non
interattive (`isInteractive`), la stessa regola dell'hook per `sdk-*`, e un
`claude -p` e' per definizione non interattivo: il percorso completo si e'
misurato togliendo quel cancello in una copia nella sandbox, e il cancello
stesso resta verificato solo a occhio. Stessa famiglia di `_leggiQuota`.

**La faccina era lenta perche' Claude Code tace, non perche' il pannello
dorma.** Segnalato dall'uso il 2026-10-08. Misurato prima di toccare
qualcosa, e il percorso normale e' gia' veloce: il monitor della cartella si
sveglia in **0 ms** (misurato su una raffica di cinque scritture: cinquanta
risvegli, attesa zero dopo ognuna, e il `rate-limit` di GIO non morde), l'hook
scrive il file **entro 14-62 ms** dall'evento (misurato sulla sessione vera,
confrontando l'ora dei comandi con quella delle scritture), e il pannello
aspetta 150 ms per non rileggere a ogni evento di una raffica. Due decimi di
secondo in tutto: non e' li'.
La lentezza sta dove **non arriva nessun evento**, e sono tre casi:
1. **interrompi con Esc**: Claude Code non manda niente, l'ultimo evento resta
   `PreToolUse` e `statoProprio` lo legge «lavora» **per un'ora**;
2. **neghi un permesso**: restava `PermissionRequest`, cioe' «aspetta te» per
   un'ora, dopo che avevi gia' risposto;
3. il modello rifiuta o la chiamata va in errore: come il primo.
Il secondo si chiude con l'hook: `PermissionDenied` esiste fra gli eventi di
Claude Code ed e' entrato nell'elenco (chi aggiorna deve reinstallare: la
pagina dice «Installati in parte»). Il primo e il terzo no — da fuori quel
momento non esiste — e li chiude il mod: `turn.complete` scatta **comunque**,
e `reason` dice perche' (`answer`, `aborted`, `refusal`, `error`). Il mod
riscrive la riga come l'avrebbe scritta l'hook: `Stop`, epoca adesso,
fallimenti a zero, **e tutto il resto intatto** — cwd, pid, riserva e il numero
degli aiutanti sono suoi.
**Il motivo si conserva**: `error` scrive `StopFailure`, non `Stop`. Una prima
versione li schiacciava tutti su `Stop`, e un turno finito in errore diventava
la faccina verde «ha finito» invece del limone — con l'aggravante che quale
delle due vincesse dipendeva da chi scriveva per ultimo. Rilevato da
`/code-review` lo stesso giorno.
**E qui il lucchetto serve.** Sull'elenco degli aiutanti un aggiornamento
perso torna al giro dopo, dieci secondi; sulla riga di stato no — `turn.complete`
scatta una volta sola, e se l'hook riscrive dopo di noi la riga torna «lavora»
per l'ora intera, cioe' esattamente il difetto che si sta correggendo. Il mod
prende `<sessione>.lock`, lo stesso dell'hook, dentro lo `sh -c` che fa gia' la
rinomina: nessun fork in piu'.

**I backup di settings.json sono tre, e si possono buttare** (chiesto dall'uso
il 2026-10-08). Erano dieci: un backup serve a tornare indietro di un passo,
non a tenere l'archivio di una configurazione che non c'e' piu'. La rotazione
e il pulsante **cestinano**, non cancellano — la regola non negoziabile vale
anche per un file scritto da noi, e `gio` che fallisce lascia il file dov'e'
invece di ripiegare su `unlink`. `elimina` ha la stessa rete di `ripristina`:
solo file della cartella dei backup, perche' lo chiama un pulsante.

**Limite noto, non corretto**: se gli aiutanti finiscono senza che nessun
evento raggiunga la sessione padre, allo scadere dell'ora lo stato passa da
`aiutanti` direttamente a `dorme` — `statoProprio` dà `finito` solo entro dieci
minuti — e la notifica «Claude ha finito» non arriva. Notificare un'ora dopo
sarebbe comunque rumore più che informazione, quindi si è scelto di lasciarlo
così e scriverlo qui.

**Uno schianto nella mascotte che non si riproduce.** Nella shell annidata è
comparso, circa un giro su quattro, uno stack dentro `Fumetto.aggiorna`. La
prima ipotesi — i riferimenti agli attori non azzerati in `_smonta()`, che
`_pulsa()` si salvava per caso con un'uscita anticipata e `_mostraSegno()` no —
era un difetto vero ed è stata corretta, ma non era quella: dieci esecuzioni
col log tenuto non l'hanno ripreso. La chiamata è ora sotto `try`, con
`logError`: **non è la spiegazione, è il contenimento**, e finché non si trova
l'errore finisce nel journal invece di interrompere il giro di aggiornamento.
Chi ci torna: serve il log della shell annidata nel momento in cui succede.

**Il clic sulla mascotte guarda dove finisce il dito, non se si è mosso.**
Bastavano sei pixel di tremolio durante la pressione perché il rilascio valesse
come trascinamento: la mascotte si spostava di un'inezia e il terminale non si
apriva mai. Segnalato dall'uso il 2026-10-06. Ora se il rilascio cade entro
`SOGLIA_TRASCINA` dal punto di partenza è un clic, e la mascotte torna dov'era.
Resta senza prova automatica: nella shell annidata il puntatore virtuale non
centra la finestra.

**Niente lampeggia per abitudine.** Il respiro del disco (`_pulsa()`) è stato
tolto da tutti gli stati su richiesta dell'utente: una cosa che respira sempre
diventa fondale e smette di dire qualcosa. Al suo posto un **segno** che
compare solo quando serve e lampeggia lui — due punti interrogativi sul disco
quando Claude aspetta te, due esclamativi quando si è inceppato, una lampadina
sopra la testa quando c'è lavoro in corso (suo o dei suoi aiutanti). A
lampeggiare è il segno, mai la faccia: una faccia che sbiadisce si legge
peggio. `segnoStato()` decide, `grafica/mascotte.py` disegna. Niente lampeggio
con le animazioni di GNOME spente, come prima.

**Lo stato «aiutanti».** Una sessione ferma su `Stop` con tre agenti in
background diceva «ha finito» e non c'era modo di accorgersene:
`statoSessione()` non guardava `s.aiutanti`. Ora la regola sta **fuori dai
rami** — se lo stato proprio è tranquillo (`finito` o `dorme`) e ci sono
aiutanti, lo stato è `aiutanti` — perché sono gli stati tranquilli a doverla
sentire, e dirlo una volta sola evita di dimenticarne uno. L'icona è il
robottino. Se Claude aspetta te, lavora o si è inceppato, quello viene prima:
gli aiutanti non sono la notizia.

**`grafica/mascotte.py` gira anche senza inkscape.** La conversione dei tratti
in forme piene serve alle icone *-symbolic; senza lo strumento non si converte
e non si finge di averlo fatto: un'icona già in posto resta quella, una nuova
si scrive com'è e lo script lo dice. Un tratto non convertito tiene il grigio
di ripiego invece del colore del tema — si vede, ma si legge su tutti e due i
fondi, ed è meglio di un'icona che sparisce.

**La mascotte fluttuante** (`fumetto.js`) usa la stessa decisione delle
notifiche (`_avviso()` in `watchface.js`): le due non possono divergere. È
**una sola, con l'elenco degli avvisi** (scelta dell'utente: «è il
monitoratore»): un avviso per sessione, i più urgenti in cima, uno
evidenziato che dà il colore a tutto. Le regole dell'elenco sono funzioni pure
(`aggiungiAvviso`, `potaAvvisi`, `togliAvviso`) con una tabella di casi in
`prova-js.sh`, ognuno verificato con una mutazione. **Notifiche e mascotte
sono alternative** (`watchface-alerts`: notifiche, mascotte, nessuno): insieme
dicevano la stessa cosa due volte, segnalato dall'utente. La regola è
`canaleAvviso()`. La chiave vecchia `watchface-notifications`, uscita nella
versione 3, resta nello schema solo per la migrazione: chi l'aveva spenta
riceve «nessuno». **Sempre visibile** (`watchface-floating-always`, richiesta
dell'utente): la mascotte resta senza nuvoletta e la sua faccia è quella dello
stato più urgente, come nella barra; ridisegna solo quando cambia la firma di
ciò che si vede, perché gli eventi arrivano a raffica. Sta in
`addChrome(..., {trackFullscreen: true})` (GNOME 50 accetta solo
`trackFullscreen` e `affectsStruts`): la shell la nasconde sopra lo schermo
intero, e siccome ne governa la visibilità, il nostro mostra/nascondi sta su un
attore interno. Il posto ricordato è l'angolo in basso a destra della faccina;
se non cade su nessun monitor (dock staccato) torna nell'angolo del
principale. **La faccina sta su un disco chiaro**: capelli e barba sono quasi
neri, e su un desktop scuro sparivano — visto nella shell di prova. Il
trascinamento e il clic **non hanno una prova automatica**: il puntatore
virtuale nella shell annidata ha cliccato altrove (ha aperto le impostazioni
rapide). Si provano a mano dopo il login, con `bin/simula-watchface.sh` che fa
passare tutti gli stati su tre sessioni finte: provati così dall'utente il
2026-10-03, trascinamento, clic sulle righe e clic che porta al terminale.
**Le preferenze si fotografano con `bin/fotografa-preferenze.sh`**: nella
shell annidata il clic simulato non raggiunge la finestra, e si vedeva solo la
prima pagina — così un menu a tendina che nascondeva il valore scelto è
arrivato fino all'utente. Lo script apre la finestra in un processo suo, con
una base minima al posto di `ExtensionPreferences`, sceglie le pagine da solo e
le disegna in PNG con GTK. Il ridisegno del 2026-10-03 (cinque pagine,
ricerca, tessere colorate, «?» verso la guida) è stato controllato così, e
le foto hanno trovato due difetti prima dell'utente: una tessera che si
espandeva e spostava le righe, e i «valori rapidi» schiacciati.
**Una prova che controlla «resta com'era» passa anche se il programma muore
prima di scrivere.** Così `installa` andava in crash su un evento
che non è un elenco, con la prova verde: lo ha visto abrt nel journal, non
noi. Ora la prova controlla anche che gli altri undici hook ci siano.
`pack-extension.sh` ora include **tutti** i `*.js`: con l'elenco a mano,
`fumetto.js` sarebbe rimasto fuori dallo zip.

**Un inciampo nella lettura della quota non è un guasto.** Il 2026-09-30 alle
16:02:07, un minuto dopo l'accesso, `collect-usage.py` è uscito con esito
diverso da zero: in 23 ore non si è più ripetuto, e non era il `PATH` — la
shell ha `~/.local/bin`. Al login la rete o il CLI possono non essere ancora
pronti. Il triangolo di guasto però restava acceso fino alla lettura buona
successiva, mezz'ora dopo. Ora si ritenta una volta dopo `RIPROVA_QUOTA_S`
(45 s) e si segnala solo se fallisce anche il secondo tentativo.
**Non è coperto da nessuna prova automatica**: nella shell annidata il
percorso della quota non parte mai, nemmeno togliendo il dato o invecchiandolo
— misurato con uno script-spia che non è mai stato invocato. Chi tocca
`_leggiQuota` lo verifica al login vero, nel journal.

## Quanto costa, misurato

    raccolta metriche    0,10 s ogni   60 s   0,17% di una CPU  (mediana di 9)
    lettura quota        2,57 s ogni 1800 s   0,14%  (picco 323 MB)
                         — con il mod attivo e una sessione aperta: zero
                                              ----
                                              0,31%

**La cadenza qui è 60 secondi, non i 600 di serie**: i conti vanno fatti su
quella, se no si sottostima di dieci volte.

Aprire il popup **non lancia nessun processo**: rilegge il JSON e avvia
l'orologio dell'età, che si ferma alla chiusura. Il costo è tutto nei due
timer, e la quota è la voce più pesante — ma quei 323 MB sono la CLI di
Claude, non codice nostro, e il dato di quota in locale non esiste.

Due volte la raccolta è stata dimezzata togliendo lavoro rifatto da zero:
- **0,69 → 0,41 s**: riparsava 70 MB e 24.600 righe di trascrizioni a ogni
  giro. Cache dei metadati per file, inventario da 0,62 a 0,08 s.
- **0,41 → 0,14 s**: `stale_mb(~/.cache)` attraversava **40.471 file** per un
  numero che cambia al massimo una volta ogni 60 giorni per file — l'80% del
  costo. Ora si tiene da parte per dieci minuti, e `reclaim.py` lo butta
  quando libera davvero quello spazio: una memoria su un numero che il
  pulsante fa scendere annuncerebbe spazio già liberato.

- **0,41 → 0,18 s**: `stale_mb` passa da `os.walk` a `find` (0,58 → 0,155 s su
  40.000 file: in Python ogni file paga una `stat` dall'interprete), e le
  trascrizioni si leggono **in modo incrementale**. Sono file in sola
  aggiunta: si tiene l'offset raggiunto e si somma solo la coda nuova. La
  conversazione in corso arriva a decine di MB e cresce a ogni messaggio,
  quindi rileggerla intera era il costo che dominava tutto il resto.
  **Il controllo sulla testa non è un di più**: `fix-cwd.py` e
  `project-relocate.py` riscrivono le trascrizioni, e riprendere da metà di un
  file riscritto conta due volte gli stessi messaggi — misurato, 13 invece di
  11. Si confrontano i primi 4 KB: in un file scritto in coda non cambiano mai.

- **0,18 → 0,12 s**: `collect-metrics.py` **importa** `claude-sessions.py`
  invece di lanciarlo. Il sottoprocesso costa 0,085 s contro 0,004 — quasi
  tutto avvio dell'interprete — ed era metà del conto. La classificazione sta
  in `inventario()`, una funzione sola usata da entrambi: duplicarla
  vorrebbe dire vederla divergere. Il sottoprocesso resta come ripiego se il
  caricamento fallisce, e una prova controlla che le due strade diano gli
  stessi numeri — quale venga usata dipende da come è stato installato.

- **0,12 → 0,10 s**: la scomposizione di `~/.claude` si fa con **un** `du` sui
  figli invece di sette sull'intero albero (uno per il totale, sei per le
  parti). In KB e non in MB: arrotondare ogni parte e poi sommare gonfiava il
  totale di 24 MB su 407. Due prove controllano che le parti sommino al totale
  e che il totale concordi con `du` entro un MB.

Se un domani risale, si profila con lo stesso metodo: importare il modulo e
cronometrare le singole funzioni, con più giri e la mediana — su una misura
sola il rumore vale quanto il segnale.

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

    ./bin/prova.sh              204 prove funzionali, sandbox con HOME dirottata
    ./bin/prova-js.sh           106 prove sulle funzioni pure dei moduli JS
    claude plugin test mods/watchdog  le funzioni pure del mod (gira dentro
                                      verifica-estensione.sh)
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
