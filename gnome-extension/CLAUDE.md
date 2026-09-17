# Estensione GNOME — Claude Code Watchdog

Si carica quando si lavora in questa cartella.

**Il nome è cambiato il 2026-09-18**: da «Fedora Watchdog»
(`claude-watchdog@fedora-watchdog.local`) a «Claude Code Watchdog»
(`claude-code-watchdog@cirobox.local`). Il vecchio prometteva una cosa —
sorvegliare Fedora — e ne faceva un'altra: l'80% di quello che mostra sono dati
di Claude Code, e niente lì dentro è specifico di Fedora.
**L'UUID determina il percorso GSettings**, quindi rinominare costa la
migrazione delle impostazioni (fatta con `dconf dump` e `dconf load`): se
servisse rifarlo, quello è il passaggio da non dimenticare. Le regole generali del progetto
e le cose da sapere su questa macchina stanno in `../CLAUDE.md`.

## Regola per l'estensione GNOME

**Non mettere valori configurabili in `extension.js`.** GNOME Shell tiene in
cache il modulo ES già importato: una costante lì si cambia solo con logout e
login, come si è visto con `claude-status` il 2026-09-16. Le impostazioni dell'estensione stanno in **GSettings**
(`schemas/org.gnome.shell.extensions.claude-code-watchdog.gschema.xml`), lette a
runtime e modificabili dalla finestra delle preferenze. Le soglie degli script
restano in `config/watchdog.conf`. Nessuno dei due richiede un logout.

Il pulsante di pulizia nel popup rispetta la regola del progetto: primo clic
mostra l'elenco puntuale, secondo clic elimina. Non scorciatoie, e solo target
non-root — un'estensione di pannello non è il posto da cui chiedere una
password di amministratore.

Stesso motivo: l'estensione non calcola metriche, le legge. La logica di misura
sta in `bin/collect-metrics.py`, dove si corregge senza riavviare niente.

Dopo ogni modifica al sorgente: `./bin/install-extension.sh` (serve una copia,
GNOME non segue i symlink quando enumera le estensioni), poi logout e login.

## Estetica dell'estensione

Il popup è un **quadro strumenti**, non un cruscotto a schede: righe, non
riquadri; filetti sottili per raggruppare, non bordi per isolare.

La regola che tiene insieme il disegno: **la forma della misura dice che tipo
di misura è.**
- grandezza con un massimo (disco, quota) → barra riempita
- grandezza senza massimo (`~/.claude`) → linea di tendenza
- grandezza su cui si interviene (recuperabile) → cifra più azione

Una barra su una grandezza senza massimo sarebbe una bugia grafica: la versione
precedente rapportava i MB di `~/.claude` a 1 GB arbitrario.

**I misuratori e le barre si disegnano in Cairo, non con widget CSS.** Con
`St.Widget` dentro un `Clutter.BinLayout` il riempimento finiva centrato invece
che allineato a sinistra, e la classe della tinta non veniva applicata: tutte le
barre uscivano dello stesso colore. In Cairo il controllo è esatto e si possono
mettere le tacche di riferimento a un quarto, metà e tre quarti.

### Tema chiaro e tema scuro

**Deve funzionare su entrambi.** St non ha media query né modo di sapere quale
tema è attivo, quindi non si possono definire due palette: i colori devono
reggere su tutti e quattro i fondi — popup chiaro, popup scuro, barra chiara,
barra scura.

Misurando il contrasto emerge un fatto che decide il disegno: **nessuna tinta
supera 4,5:1 su chiaro e su scuro insieme.** Scurirla per il fondo chiaro la
affossa su quello scuro. Da qui la regola:

- **il colore si usa per i grafici** (barre, linee, punti), dove la soglia è
  3:1 e le quattro tinte la superano su tutti e quattro i fondi;
- **il testo prende sempre il colore del tema**, che è leggibile per
  definizione; il significato passa da uno sfondo tenue o da un simbolo.
  Un allarme ambra su fondo chiaro sta a 2,9:1 ed è illeggibile: perciò ha un
  fondo ambra tenue e testo normale, non testo ambra.
- **unica eccezione**: le etichette del pannello, in grassetto, dove la soglia
  è 3:1 ed è rispettata.

Palette, ripetuta per esteso nel CSS perché St non conosce `var()`, e nella
mappa `TINTE` di `extension.js` per la parte disegnata — vanno tenute
allineate: `#2F9284` sano · `#8676B8` quota · `#B77B1A` attenzione da 75% ·
`#CE5A50` critico da 90%.

### Soglie di colore

**Una sola definizione, in `config/watchdog.conf`:** `ALERT_WARN_PCT=75` e
`ALERT_CRIT_PCT=90`. `collect-metrics.py` le usa per gli allarmi e le pubblica
in `metrics.json` sotto `soglie`; l'estensione le legge da lì per colorare barre
ed etichette, con un ripiego a 75/90 se il JSON manca.

Prima erano tre valori scollegati — barre a 75/90 costanti in `extension.js`,
allarme quota a 80 fisso nel codice, allarme disco a 85 in `watchdog.conf` — e
si arrivava all'assurdo di una barra ancora verde mentre l'allarme era già
scattato.

Le tacche sul misuratore cadono **sulle soglie**, non a quarti fissi: il colore
cambia esattamente dove cade la tacca, quindi il riferimento dice qualcosa
invece di decorare.

Questo è anche il confine fra i due sistemi di configurazione:
**GSettings** per le preferenze di visualizzazione (quali indicatori, ogni
quanto, icone sì o no), **watchdog.conf** per le soglie, perché le usano anche
gli script.

### L'età del dato

`fmtAge` **non deve avere zone morte**: una soglia di 90 secondi sotto la quale
si legge «adesso» rende l'etichetta muta appena l'intervallo di aggiornamento
scende sotto quel valore. Verificato il 2026-09-17 con `refresh-seconds` a 60:
diceva sempre «adesso», ed era vero, ma inutile. Ora sotto il minuto conta i
secondi.

L'etichetta **scorre da sola mentre il popup è aperto** (un timer da un secondo
avviato su `open-state-changed`): ricalcolarla solo alla lettura la
congelerebbe finché il menu resta aperto.

Nota sull'intervallo: la linea di tendenza disegna le ultime 60 rilevazioni,
quindi l'intervallo decide anche **quanto tempo copre il grafico** — un minuto
copre un'ora, dieci minuti coprono dieci ore.

### Progetti e «fuori dai progetti»

**È un progetto solo la cartella figlia diretta della radice** (`projects-root`,
vuoto = la cartella che contiene `fedora_watchdog`). Tutto il resto — la home,
`/tmp`, percorsi sparsi — sono posti da cui Claude è stato lanciato, e finiscono
in una sezione separata dove l'unica azione è togliere le sessioni.

La divisione la fa **l'estensione**, non `collect-metrics.py`: la radice sta in
GSettings e solo l'estensione la conosce. Per questo il raccoglitore emette fino
a 40 cartelle invece di 8 — con due sezioni, un taglio a monte le farebbe
competere per gli stessi posti.

Le cartelle senza sessioni non compaiono affatto: l'elenco mostra i `cwd` da cui
Claude è stato eseguito, non il contenuto della radice progetti.

### Segnalazione dei problemi sui progetti

`collect-metrics.py` calcola per ogni progetto un elenco `problemi`, e
l'estensione mostra un triangolo ambra con il riassunto nel sottotitolo e la
descrizione per esteso in un suggerimento al passaggio del mouse. I casi:

- `cartella-sparita` — il `cwd` non esiste più;
- `in-tmp` — il progetto lavora sotto `/tmp`, che si svuota al riavvio. È già
  costato dei file di lavoro il 2026-09-02, per questo è segnalato;
- `cartella-condivisa` — le sue trascrizioni stanno in una cartella di
  `projects/` con sessioni di altri `cwd`;
- `cwd-ignota` — non si risale al percorso di lavoro.

**Il giallo sta sull'icona e su un fondo tenue, mai sul nome del progetto**: un
testo ambra su fondo chiaro sta a 2,9:1 e non si legge. Così la riga è
visibilmente gialla su entrambi i temi e il nome resta leggibile.

**GNOME Shell non ha suggerimenti pronti**: la classe `Suggerimento` in
`extension.js` ne costruisce uno, appeso alla chrome della shell con
`Main.layoutManager.addTopChrome()`. Ce n'è **uno solo** per tutta l'estensione,
riposizionato di volta in volta, e va distrutto esplicitamente in `destroy()` —
vivendo fuori dal menu, altrimenti resterebbe a video dopo la disattivazione.
Il passaggio del mouse si ascolta sull'intera testa della riga, non sull'icona:
centrare il puntatore su 14 pixel è scomodo.

**`Main.layoutManager.addTopChrome()` su GNOME 50 non accetta parametri.**
Passargli `{affectsInputRegion: false}` solleva «Unrecognized parameter» e manda
l'intera estensione in **ERROR** all'avvio: nessun indicatore, niente. Successo
il 2026-09-17 proprio mentre si correggeva lo z-order del suggerimento. Non
serve comunque: `St.Label` non è reattiva e non intercetta i clic.

Da lì la rete di sicurezza in `enable()` e attorno alla costruzione del
suggerimento: un accessorio che non parte deve mancare da solo, non portarsi
dietro tutto il resto.

**Non si può collaudare l'estensione senza logout su questa macchina:**
`gnome-shell --wayland` annidato fallisce con «Failed to take control of the
session: EBUSY» perché il seat è già preso, e gli oggetti St non si costruiscono
fuori dalla shell (Clutter non ha un contesto). Restano il parsing con `gjs -m`,
le prove sulle funzioni pure e le simulazioni: tutto il resto si vede solo
dopo il login.

Due dettagli scoperti a video:

- **Va rialzato a ogni comparsa.** Il menu del pannello viene portato in cima
  alla chrome quando si apre, quindi un suggerimento aggiunto una volta sola
  alla costruzione finisce dietro alla colonna e il testo resta coperto. Serve
  `genitore.set_child_above_sibling(this, null)` dentro `_mostra()`.
- **Va messo di fianco alla colonna, non sotto la riga.** Anche stando davanti,
  comparire dentro la colonna copre le voci sottostanti. Si calcola lo spazio a
  destra e a sinistra del menu e si sceglie il lato che ci sta, allineandolo
  verticalmente alla riga che l'ha chiesto. Verificato con una simulazione su
  3840×2400 e su 1366×768, con il popup al centro, ai due bordi e attaccato ai
  bordi: non si sovrappone mai e non esce dallo schermo.

### Icone

Insieme proprio in `icons/`, otto simboliche 16×16 sulla stessa griglia e con
lo stesso spessore (1,35). Il ripiego di colore è `#8a8a8a`, leggibile su
entrambi i fondi se per qualche motivo la shell non le ricolorasse.
**`gnome-extensions pack` non include `icons/` da sé**: va elencata con
`--extra-source`, come i file `.py` e `prefs.js`.

### Costo e reattività

Misurato il 2026-09-17: `collect-metrics.py` costa **0,5 s** a giro (di cui
0,04 s di `du` su `~/.cache` con 26.000 file e 0,20 s per la scansione per età),
`project-purge.py --json` 0,03 s, il parsing di `history.jsonl` 0,16 ms.
Con un intervallo di 60 s siamo sotto l'1% di un core: **il peso
dell'estensione non è nei suoi script**.

Un test A/B su `gnome-shell` (attiva 15,5% · disattivata 12,2%) dice che la
nostra quota è di circa 3 punti su un fondo che resta alto comunque, con 14
estensioni caricate. Ripetendo la prova su altre estensioni i numeri ballano di
±5 punti: **con questo metodo non si attribuisce niente a nessuno**, serve un
profiler vero.

Quello che invece rallentava davvero l'interazione, ora corretto:

- **La lettura della quota rigenerava tutte le metriche.** `collect-usage.py`
  scrive `usage.json`; l'estensione ora legge direttamente quello, invece di
  lanciare `collect-metrics.py` solo per farsi reimpacchettare lo stesso dato.
  Un sottoprocesso e una ricostruzione in meno per ogni giro.
- **Le righe dei progetti si ricostruivano a ogni aggiornamento**, anche quando
  non era cambiato nulla: col menu aperto una riga espansa si richiudeva e il
  clic si perdeva. Ora si confronta una firma (percorso, peso, sessioni,
  messaggi, problemi) e si rifà solo se è cambiata.

### Cartella spostata: «Correggi»

`bin/project-relocate.py` riaggancia le sessioni di un progetto a una cartella
che è stata spostata. `claude --resume` cerca in una cartella di
`~/.claude/projects/` il cui nome deriva dalla cwd, quindi spostare la cartella
di lavoro scollega le conversazioni.

**La codifica cwd → nome cartella è, in avanti, deterministica:** ogni carattere
non alfanumerico diventa `-`. Verificato il 2026-09-17 su tutte le cartelle non
ambigue di questa macchina (9 su 9). All'indietro resta non invertibile.

**La verifica non si fida del nome.** Le trascrizioni citano i percorsi dei file
su cui si è lavorato: si estraggono quelli sotto la vecchia cwd e si controlla
quanti esistono nella cartella candidata. Tre verdetti — `sicuro` (file
ritrovati), `incerto` (nessun file citato, o solo il nome che coincide), `no`
(niente prove e nome diverso: rifiuta, salvo `--forza`). Collaudato sul caso
reale `/tmp/migrazione_posta` → `~/Documenti/Claude/migrazione_posta`: trova
`migrazione_qboxmail.csv` e dà `sicuro`; puntato su `modulo_gamma` dà `no`.

L'operazione riscrive il campo `cwd` dentro le trascrizioni e le scrive nella
cartella nuova; **gli originali vanno nel cestino**, e si allinea anche la `cwd`
dentro `state.json` dei job.

### Revisione del 2026-09-17: undici rilievi

`/code-review` su tutto il progetto ha trovato undici difetti, tutti corretti.
I quattro che contavano:

- **La copia di `collect-metrics.py` dentro l'estensione calcolava male la
  radice.** `parent.parent` vale solo nel layout `<progetto>/bin/`; nella copia
  puntava alla cartella delle estensioni GNOME. Effetto su un'installazione da
  zero: zero conversazioni, zero progetti, e `projects-root` dedotta lì dentro,
  quindi il «+» avrebbe creato progetti nella cartella delle estensioni. In più
  `claude-sessions.py` — dipendenza di `collect-metrics.py` — non era in nessuna
  delle due liste di copia. Ora la radice si riconosce dalla presenza di
  `config/watchdog.conf`, e senza progetto `metrics.json` scrive `progetto: null`
  invece di un percorso inventato.
- **Il cestino si potava per mtime.** Un documento modificato due anni fa e
  buttato ieri veniva distrutto al primo `clean.sh --apply trash`. Si legge
  `DeletionDate` dai `.trashinfo` (`bin/trash-scaduti.py`), e si tolgono payload
  e `.trashinfo` insieme per non lasciare voci spaiate.
- **`collect-usage.py` cancellava trascrizioni non sue.** La "spazzata dei
  ritardatari" passava su tutta la cartella con `unlink()`: una sessione
  interattiva vera, aperta da `$HOME`, che ha scritto la domanda ma non ha
  ancora ricevuto risposta è indistinguibile da uno scarto. Rimossa: si tocca
  solo ciò che l'invocazione ha creato, e nel cestino.
- **`claude-stubs` cancellava definitivamente** con `rm -f`, contro la regola
  del progetto, e il criterio «nessuna risposta» può pescare una conversazione
  vera interrotta. Ora `gio trash`, con `xargs -0` perché un percorso con uno
  spazio veniva spezzato.

Gli altri: `_eseguiSpostamento` non rivalidava il percorso (un campo svuotato
dopo la verifica finiva a `realpath('')`, cioè la cwd del chiamante); una barra
finale in `projects-root` mandava ogni progetto in «fuori dai progetti»;
`fmtAzzeramento` diceva «domani» per azzeramenti a 26 ore; una percentuale nulla
diventava la scritta «null%»; `project-relocate` annunciava le sessioni trovate
invece di quelle spostate.

### Allineamento della cwd

`bin/fix-cwd.py` corregge il campo `cwd` quando una trascrizione è archiviata in
una cartella che significa un percorso diverso da quello che dichiara. Non
sposta niente: il file è già al posto giusto.

La cartella non si decodifica — non è invertibile. Si fa il contrario: si
**codificano le cartelle che esistono** sul disco e si cerca quella che produce
quel nome.

**La prova più forte sono i README dei progetti**, che elencano gli ID sessione:
sulle sette trascrizioni corrette il 2026-09-17 il confronto sui file citati
dava zero — quei file erano andati persi con `/tmp` — mentre il README di ogni
progetto nominava la sessione. Risultato: da 4 progetti a **10**.

**La copia di sicurezza non può stare in `/tmp`**: è un filesystem in memoria e
`gio trash` rifiuta con «spostamento nel cestino sui montaggi interni di sistema
non supportato». Va sul filesystem della home (`~/.cache/fedora-watchdog/`).

### Controlli prima di installare

`bin/verifica-estensione.sh` gira **dentro** `install-extension.sh` e
`pack-extension.sh`, che si fermano se fallisce. Controlla: sintassi di
`extension.js` e `prefs.js`, schema compilabile, SVG validi, **metodi chiamati
ma non definiti**, **chiavi GSettings inesistenti**, **classi CSS usate ma non
definite**, script citati **presenti in `bin/` e in entrambe le liste di copia**.

Il controllo sugli SVG usava `exit 1` dentro un `if for ... done`: non essendo
una sotto-shell, il primo SVG malformato **uccideva l'intero script** e i quattro
controlli sotto — quelli per cui il file esiste — non giravano. Ora è in una
sotto-shell, con `nullglob` perché senza icone il glob resterebbe letterale.

Esiste per un motivo: il 2026-09-17 una riscrittura di `_comandoTerminale` ha
inghiottito il metodo `_apriTerminale` che stava nel mezzo, e «Riprendi» ha
smesso di funzionare con un `TypeError` visibile solo nel journal — trovato
dall'utente, non da noi. Il controllo sui metodi mancanti lo avrebbe pescato.

### Il popup deve scorrere

Il contenuto cresce quando si aprono le righe dei progetti, e oltre l'altezza
dello schermo il menu viene **tagliato senza modo di raggiungerlo**. Tutto sta
dentro uno `St.ScrollView` con `overlay_scrollbars`, e il tetto d'altezza si
calcola sul monitor (62% dell'altezza) invece di fissarlo nel CSS: un valore
fisso taglierebbe comunque su schermi bassi.

Tre dettagli che non si vedono dal codice:
- `St.ScrollView` vuole `set_child()` sulle versioni recenti e `add_actor()`
  sulle vecchie: si prova la prima e si ricade sulla seconda.
- La `PopupBaseMenuItem` che lo contiene è `reactive: false`, quindi lo
  `ScrollView` va reso **esplicitamente reattivo** o la rotella non ci arriva.
- **`overlay_scrollbars` va tenuto a `false`.** In sovrapposizione la barra
  copre i numeri, che sono allineati a destra. Occupando il proprio spazio il
  contenuto si stringe e resta leggibile.

### Lucchetti dei sottoprocessi

`_raccogli()` e `_leggiQuota()` usano una bandiera per non sovrapporsi. Se un
sottoprocesso non tornasse mai — `wait_async` senza risposta — quella bandiera
resterebbe alzata **per sempre**, e da lì in poi nessun aggiornamento
automatico: esattamente il sintomo «i consumi non si aggiornano se non premo
io». Si registra anche *quando* è stata alzata e oltre `LUCCHETTO_MS` (2 minuti)
si considera persa e si riapre.

### Tipografia

Le note sotto le misure erano a `opacity: 0.45-0.5`, cioè metà contrasto rispetto
al testo normale: leggibili su uno schermo grande e fermo, faticose in uso.
Portate a **0.68-0.78**, con un filo di corpo in più (0.8 → 0.85em). Le
intestazioni di sezione passano da `600` a `700` di peso. Il popup è stato
stretto da 336 a 300 px.

### Colori dei pulsanti d'azione

Fondo pieno e testo bianco: così si portano dietro i propri due colori e non
dipendono dal tema. Verificati tutti sopra 4,5:1 col bianco —
`#3A6FB0` Cartella (5,2) · `#1F6E62` Riprendi (6,1) · `#96640F` Correggi (5,1) ·
`#B23A31` Elimina (5,9). L'ambra chiara `#B77B1A` della palette sta a 3,6 e per
il testo piccolo non basta: per i pulsanti si usa la versione scura.

**Quando l'azione non è disponibile il pulsante perde il colore** (`fw-btn-spento`,
grigio e smorzato): «colorato» deve voler dire «si può premere».

### Nuovo progetto

Il «+» accanto al titolo «Progetti» chiede un nome di cartella, la crea sotto
`projects-root` (vuoto = la cartella che contiene `fedora_watchdog`, cioè
`~/Documenti/Claude`) e ci apre una sessione **nuova** — `claude`, non
`claude --resume`: la cartella è appena nata.

Il campo accetta **un nome, non un percorso**: niente `/`, niente nomi che
iniziano per punto, massimo 80 caratteri, e rifiuta i nomi già presi. Chi digita
lì sta creando una cartella, non navigando. Validazione collaudata su 12 casi.

Dentro un menu di GNOME Shell un `St.Entry` **non riceve i tasti da solo**:
serve `global.stage.set_key_focus(campo.clutter_text)` dopo averlo mostrato,
altrimenti si digita nel vuoto.

Con `new-project-readme` attivo (predefinito) la cartella nasce con un
`README.md`: nome, data assoluta, percorso, comando per riprendere, e due righe
da riempire su cos'è il progetto. È volutamente quasi vuoto — un file pieno di
sezioni vuote invita a ignorarlo, non a compilarlo.

**Nessun testo dell'interfaccia deve contenere un percorso di questa macchina.**
La cartella in uso si *mostra*, calcolandola a runtime: `prefs.js` la legge da
`metrics.json` (la stessa fonte del popup, per non mostrare un valore diverso da
quello che verrebbe usato) e la espone nella riga «In uso adesso», anche quando
è quella rilevata in automatico. Guide e suggerimenti restano generici.

## Il terminale di «Riprendi»

Ptyxis può avere un **comando personalizzato** nel profilo: su questa macchina
`custom-command = 'zsh'` con `login-shell = true`, mentre `$SHELL` è
`/bin/bash` e il `.bashrc` è spoglio. Tutta la configurazione (prompt a due
righe) sta in `.zshrc`.

Chi apre un terminale deve quindi leggere il profilo di Ptyxis
(`org.gnome.Ptyxis.Profile` sotto `/org/gnome/Ptyxis/Profiles/<uuid>/`) prima di
ripiegare su `$SHELL`, e avviare la shell con `-i` perché legga i suoi file di
configurazione. Una prima versione lanciava `bash -lc` e l'utente si ritrovava
un prompt spoglio.

**`ptyxis -- comando` apre già una finestra nuova.** È scritto nel suo stesso
`--help`: «Eseguire un comando in una nuova finestra: `ptyxis -- bash -c ...`».
Aggiungerci `--new-window` ne fa aprire **due**. Quindi: con finestre già aperte
si usa `--tab`, senza finestre si usa la forma nuda `ptyxis -d DIR -- cmd`,
mai `--new-window`.

**`--tab` va usato solo se il terminale ha già una finestra.** Se non ce l'ha,
`ptyxis --tab` fa partire l'applicazione — che apre la sua finestra con il tab
predefinito — e *poi* aggiunge il tab richiesto: due schede, una vuota.
Verificato il 2026-09-17. Si controlla con
`Shell.AppSystem.get_default().lookup_app('org.gnome.Ptyxis.desktop').get_n_windows()`
e si sceglie `--tab` o `--new-window` di conseguenza. La mappa terminale →
file `.desktop` sta in `TERMINALI` in cima a `extension.js`.
