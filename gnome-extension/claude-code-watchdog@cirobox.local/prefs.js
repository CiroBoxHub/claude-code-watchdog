/* Impostazioni e guida di Fedora Watchdog.
 *
 * Gira nel processo di gnome-extensions-app, separato dalla shell: qui GTK e
 * Adwaita esistono, dentro la shell no.
 */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

/* Gli indicatori disponibili per la barra, nell'ordine in cui compaiono. */
const INDICATORI = [
    ['disco',           'Disco',           'Quanto è pieno /. Il valore che conta solo quando cresce.'],
    ['claude',          'Conversazioni',   'Spazio delle tue conversazioni, senza contare gli ambienti che i plugin si installano.'],
    ['sessioni',        'Conversazioni',   'Quante ce ne sono archiviate in tutto.'],
    ['messaggi',        'Messaggi',        'Totale su tutte le conversazioni. Misura di lavoro, non di spazio.'],
    ['recuperabile',    'Recuperabile',    'Spazio liberabile subito, senza password di amministratore.'],
    ['quota-sessione',  'Sessione corrente', 'Finestra mobile di circa cinque ore, non la giornata: riparte dal primo uso.'],
    ['quota-settimana', 'Settimana',         'Limite settimanale. È il vincolo che di solito morde per primo.'],
];

/* Riga di sola lettura per la guida: titolo e spiegazione, niente comandi. */
function spiega(gruppo, titolo, testo) {
    const r = new Adw.ActionRow({title: titolo, subtitle: testo});
    r.set_subtitle_lines(0);        // 0 = nessun troncamento
    gruppo.add(r);
    return r;
}

export default class WatchdogPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const s = this.getSettings();
        window.set_default_size(680, 720);

        window.add(this._paginaGuida());
        window.add(this._paginaBarra(s));
        window.add(this._paginaPopup(s));
        window.add(this._paginaQuota(s));
        window.add(this._paginaTerminale(s));
        window.add(this._paginaSicurezza(s));
    }

    /* ---------------------------------------------------------- guida --- */
    _paginaGuida() {
        const pagina = new Adw.PreferencesPage({
            title: 'Guida',
            icon_name: 'help-about-symbolic',
        });

        const cosa = new Adw.PreferencesGroup({
            title: 'A cosa serve',
            description: 'Tiene d’occhio lo spazio del PC e i dati che Claude ' +
                         'Code lascia sul disco, e permette di intervenire senza ' +
                         'aprire un terminale. Non misura niente da sé: legge i ' +
                         'dati raccolti dagli script del progetto claude-code-watchdog.',
        });
        pagina.add(cosa);
        spiega(cosa, 'In una riga',
               'Se la barra in alto è del suo colore normale e nel popup non ' +
               'ci sono triangoli gialli, non c\u2019è niente da fare.');

        const barra = new Adw.PreferencesGroup({
            title: 'Nella barra in alto',
            description: 'Scegli tu quali valori mostrare, nella pagina «Barra». ' +
                         'Restano sempre leggibili: diventano ambra e poi rossi ' +
                         'alle stesse soglie delle misure nel popup.',
        });
        pagina.add(barra);
        spiega(barra, 'Poco spazio?',
               'Le «etichette compatte» tolgono unità e sigle. In alternativa ' +
               'accendi «un\u2019icona per ogni indicatore»: occupa un filo di ' +
               'più ma si distinguono senza leggere, e le sigle «S» e «W» ' +
               'spariscono perché l\u2019icona già le dice.');

        const misure = new Adw.PreferencesGroup({
            title: 'Le misure del popup',
            description: 'La forma dice che tipo di misura è.',
        });
        pagina.add(misure);
        spiega(misure, 'Barra con tacche',
               'Grandezze che hanno un massimo: disco e quota. Le due tacche ' +
               'segnano le soglie di allarme, quindi il colore cambia esattamente ' +
               'dove cade la tacca: fino alla prima è il colore proprio della ' +
               'misura, poi ambra, poi rosso. Le soglie si regolano in ' +
               'config/watchdog.conf con ALERT_WARN_PCT e ALERT_CRIT_PCT, e sono ' +
               'le stesse a cui gli scan suonano l\u2019allarme: una sola ' +
               'definizione per tutto.');
        spiega(misure, 'Linea di tendenza',
               'Grandezze senza un massimo: lo spazio delle conversazioni. Una barra ' +
               'qui sarebbe una bugia, perché non esiste un "pieno". La linea ' +
               'mostra le ultime 60 rilevazioni e il punto segna dove siamo ora; ' +
               'sotto è scritto di quanto è cambiato nel periodo.');
        spiega(misure, 'Cifra e pulsante',
               'Lo spazio recuperabile: non è uno stato da sorvegliare ma una ' +
               'cosa su cui si agisce, quindi ha un’azione accanto invece ' +
               'di un indicatore.');
        spiega(misure, 'Verde acqua, viola, ambra, rosso',
               'Il verde acqua è la macchina, il viola è la quota Claude: sono ' +
               'due cose diverse e si distinguono a colpo d’occhio. Ambra e ' +
               'rosso valgono per qualunque misura, alle stesse soglie.');

        const quota = new Adw.PreferencesGroup({
            title: 'La quota',
            description: 'Sostituisce l’estensione claude-status.',
        });
        pagina.add(quota);
        spiega(quota, 'Non consuma token',
               '/usage è un comando locale che legge i contatori: non fa ' +
               'lavorare il modello e non incide sulla quota che misura.');
        spiega(quota, 'Non lascia sessioni vuote',
               'Ogni interrogazione lascerebbe una trascrizione a vuoto in ' +
               '~/.claude/projects/. Lo script la rimuove subito, ma solo se ' +
               'non contiene nessuna risposta dell’assistente: una vera ' +
               'conversazione non viene mai toccata.');
        spiega(quota, 'Sessione non vuol dire giornata',
               'La «sessione corrente» è una finestra mobile di circa cinque ' +
               'ore che riparte dal primo uso, non un contatore che si azzera ' +
               'a mezzanotte. Per questo sotto la percentuale è scritta l\u2019' +
               'ora esatta in cui si azzera, non solo fra quanto.');
        spiega(quota, 'La settimana è il vincolo vero',
               'Si azzera a giorno e ora fissi. È quella da tenere d\u2019occhio: ' +
               'la finestra di cinque ore si ricarica da sé più volte al ' +
               'giorno, il monte settimanale no.');
        spiega(quota, 'L’età del dato è scritta',
               'Sotto la percentuale c’è quando è stata letta. Una quota di ' +
               'mezz’ora fa non viene spacciata per attuale.');

        const prog = new Adw.PreferencesGroup({
            title: 'I progetti',
            description: 'Ogni riga si apre su tre azioni.',
        });
        pagina.add(prog);
        spiega(prog, 'Il pulsante «+»',
               'Accanto al titolo «Progetti». Chiede il nome di una cartella, ' +
               'la crea e ci apre subito una sessione nuova di Claude Code. ' +
               'Sopra il campo è scritto dove verrà creata; la cartella si ' +
               'sceglie nella pagina «Progetti» delle impostazioni, dove è ' +
               'sempre mostrata anche quando è quella rilevata in automatico. ' +
               'Invio conferma, Esc annulla.');
        spiega(prog, 'Il nome è un nome, non un percorso',
               'Niente «/», niente nomi che iniziano per punto, e non si può ' +
               'riusare il nome di una cartella già esistente: il campo lo dice ' +
               'invece di creare qualcosa nel posto sbagliato.');
        spiega(prog, 'Il README di partenza',
               'Se attivo nelle impostazioni, il progetto nuovo nasce con un ' +
               'README.md che contiene nome, data, percorso e il comando per ' +
               'riprendere, più due righe da riempire su cos\u2019è il ' +
               'progetto. Sono quelle due righe che servono fra sei mesi, ' +
               'quando il nome della cartella non basterà più.');
        spiega(prog, 'Cartella',
               'Apre la cartella di lavoro nel gestore file.');
        spiega(prog, 'Riprendi',
               'Apre una scheda nel terminale — una scheda, non una finestra ' +
               'nuova ogni volta — dentro la cartella del progetto, ed esegue ' +
               'claude --resume per scegliere quale conversazione riprendere. ' +
               'Usa la shell che il tuo terminale ha configurata e la avvia in ' +
               'modo interattivo, così ritrovi il tuo prompt e i tuoi alias. ' +
               'Quando Claude esce la shell resta, e la scheda non si chiude.');
        spiega(prog, 'Elimina dati',
               'Rimuove solo ciò che Claude Code tiene per proprio conto: ' +
               'trascrizioni, memorie, job, scratchpad temporanei. ' +
               'La cartella di lavoro non viene mai toccata — lì ci sono i file ' +
               'veri, non dati di Claude. Prima di cancellare mostra l’elenco ' +
               'puntuale e aspetta un secondo clic.');
        spiega(prog, 'Progetti e «fuori dai progetti»',
               'Nell\u2019elenco «Progetti» stanno solo le cartelle figlie ' +
               'dirette della radice: quelle che hai creato per lavorarci. ' +
               'Tutto il resto — la home, /tmp, percorsi sparsi da cui ti è ' +
               'capitato di lanciare Claude — finisce nella sezione sotto, ' +
               'dove l\u2019unica azione è togliere le sessioni: non sono ' +
               'progetti e non ha senso trattarli come tali.');
        spiega(prog, 'Correggi',
               'Compare solo sulle righe la cui cartella è sparita. Chiede dove ' +
               'è finita e **verifica prima di agire**: le conversazioni citano ' +
               'i file su cui hai lavorato, e si controlla quanti di quelli ' +
               'esistono davvero nella cartella che indichi. Se non ne trova ' +
               'nessuno e il nome è diverso, si rifiuta. Poi riaggancia le ' +
               'sessioni alla nuova posizione, lasciando gli originali nel ' +
               'cestino: così «Riprendi» torna a funzionare.');
        spiega(prog, 'Il triangolo giallo',
               'Segna un progetto con qualcosa che vale la pena sapere. ' +
               'Fermando il mouse sulla riga compare la descrizione per esteso. ' +
               'I casi sono tre: la cartella di lavoro non esiste più (le ' +
               'conversazioni restano leggibili, è la directory a essere ' +
               'sparita); il progetto lavora sotto /tmp, che il sistema svuota ' +
               'al riavvio; le sue trascrizioni stanno in una cartella di ' +
               '~/.claude/projects/ condivisa con altri progetti, cosa che ' +
               'succede quando un progetto viene spostato.');

        const agg = new Adw.PreferencesGroup({
            title: 'Quanto sono freschi i numeri',
        });
        pagina.add(agg);
        spiega(agg, 'Due ritmi diversi',
               'Disco, spazio e progetti si rileggono da soli a intervalli ' +
               '(dieci minuti di serie). La quota va più piano, perché costa un ' +
               'giro di rete: mezz\u2019ora. Entrambi si regolano nelle pagine ' +
               '«Popup» e «Quota».');
        spiega(agg, 'Aggiornare subito',
               'Il pulsante circolare in cima al popup rilegge tutto all\u2019' +
               'istante, quota compresa. Accanto c\u2019è scritto da quanto ' +
               'tempo risalgono i dati, e il conto scorre finché il popup ' +
               'resta aperto.');
        spiega(agg, 'Attenzione a scendere troppo',
               'La linea di tendenza mostra le ultime 60 rilevazioni: con un ' +
               'minuto di intervallo copre un\u2019ora, con dieci minuti copre ' +
               'dieci ore. Se il grafico ti sembra piatto e poco utile, ' +
               'probabilmente l\u2019intervallo è troppo corto per quello che ' +
               'vuoi vedere.');

        const dove = new Adw.PreferencesGroup({
            title: 'Dove stanno le cose',
            description: 'Utile se qualcosa va storto.',
        });
        pagina.add(dove);
        spiega(dove, 'I dati che il popup mostra',
               '~/.local/share/claude-code-watchdog/metrics.json è la fotografia ' +
               'corrente; history.jsonl è la serie storica che disegna la linea ' +
               'di tendenza, tenuta alle ultime 2000 rilevazioni.');
        spiega(dove, 'Le soglie di allarme',
               'ALERT_WARN_PCT e ALERT_CRIT_PCT in config/watchdog.conf, nella ' +
               'cartella del progetto claude-code-watchdog. Valgono per tutto: ' +
               'colore delle barre, colore delle etichette nella barra in alto, ' +
               'allarmi. Le tacche sui misuratori si spostano di conseguenza.');

        const diag = new Adw.PreferencesGroup({title: 'Quando qualcosa non torna'});
        pagina.add(diag);
        spiega(diag, '«nessun dato» accanto al titolo',
               'Il raccoglitore non ha ancora scritto niente. Premi il pulsante ' +
               'di aggiornamento; se resta così, lancia a mano ' +
               'bin/collect-metrics.py dalla cartella del progetto e guarda che ' +
               'errore dà.');
        spiega(diag, 'Le barre della quota restano vuote',
               'O il monitoraggio è spento nella pagina «Quota», oppure il ' +
               'comando claude non è raggiungibile: serve nel PATH.');
        spiega(diag, '«Cartella» e «Riprendi» sono spenti',
               'La cartella di lavoro di quel progetto non esiste più — il ' +
               'triangolo giallo lo conferma. Le conversazioni restano, ma non ' +
               'c\u2019è una directory in cui aprirle.');
        spiega(diag, '«Libera spazio» è spento',
               'Non c\u2019è niente da liberare: nessun file ha superato le ' +
               'scadenze impostate in config/watchdog.conf.');

        const sic = new Adw.PreferencesGroup({title: 'La regola di fondo'});
        pagina.add(sic);
        spiega(sic, 'Prima si guarda, poi si cancella',
               'Nessun pulsante di questa estensione cancella al primo clic. ' +
               'Il primo clic mostra sempre cosa sparirebbe, voce per voce, con ' +
               'il peso. Solo il secondo agisce. Le operazioni che richiedono i ' +
               'permessi di amministratore — cache dei pacchetti, journal, ' +
               'kernel — non sono qui: si fanno con /watchdog-clean, perché un ' +
               'menu del pannello non è il posto da cui chiedere una password ' +
               'di root.');

        return pagina;
    }

    /* ---------------------------------------------------------- barra --- */
    _paginaBarra(s) {
        const pagina = new Adw.PreferencesPage({
            title: 'Barra',
            icon_name: 'view-continuous-symbolic',
        });

        const gruppo = new Adw.PreferencesGroup({
            title: 'Cosa mostrare nel pannello',
            description: 'Più indicatori accendi, più spazio occupa la barra. ' +
                         'Senza nessuno resta la sola icona.',
        });
        pagina.add(gruppo);

        const attivi = () => s.get_strv('panel-indicators');
        for (const [chiave, titolo, sottotitolo] of INDICATORI) {
            const riga = new Adw.SwitchRow({title: titolo, subtitle: sottotitolo});
            riga.set_subtitle_lines(0);
            riga.set_active(attivi().includes(chiave));
            riga.connect('notify::active', () => {
                // Si riscrive l'array intero nell'ordine canonico, così la
                // barra non dipende dall'ordine in cui si è cliccato.
                const scelti = INDICATORI
                    .map(([k]) => k)
                    .filter(k => k === chiave ? riga.get_active() : attivi().includes(k));
                s.set_strv('panel-indicators', scelti);
            });
            gruppo.add(riga);
        }

        const aspetto = new Adw.PreferencesGroup({title: 'Aspetto'});
        pagina.add(aspetto);
        const icona = new Adw.SwitchRow({
            title: 'Mostra l’icona',
            subtitle: 'Il disco stilizzato a sinistra dei valori',
        });
        s.bind('panel-show-icon', icona, 'active', Gio.SettingsBindFlags.DEFAULT);
        aspetto.add(icona);

        const icone = new Adw.SwitchRow({
            title: 'Un\u2019icona per ogni indicatore',
            subtitle: 'Con più valori accesi si distinguono a colpo d\u2019occhio ' +
                      'senza leggere. Occupa un po\u2019 più di barra, e toglie ' +
                      'le sigle «S» e «W» che l\u2019icona già dice.',
        });
        icone.set_subtitle_lines(0);
        s.bind('panel-icons', icone, 'active', Gio.SettingsBindFlags.DEFAULT);
        aspetto.add(icone);

        const compatto = new Adw.SwitchRow({
            title: 'Etichette compatte',
            subtitle: 'Toglie le unità e le sigle: «94» invece di «94 MB», ' +
                      '«12%» invece di «S 12%». Utile con più indicatori accesi.',
        });
        compatto.set_subtitle_lines(0);
        s.bind('panel-compact', compatto, 'active', Gio.SettingsBindFlags.DEFAULT);
        aspetto.add(compatto);

        return pagina;
    }

    /* ---------------------------------------------------------- popup --- */
    _paginaPopup(s) {
        const pagina = new Adw.PreferencesPage({
            title: 'Popup',
            icon_name: 'view-list-symbolic',
        });

        const sezioni = new Adw.PreferencesGroup({
            title: 'Sezioni visibili',
            description: 'Disco, dati Claude e spazio recuperabile ci sono sempre.',
        });
        pagina.add(sezioni);

        for (const [chiave, titolo, sottotitolo] of [
            ['show-usage', 'Quota Claude',
             'Le due barre di sessione e settimana, con quando si azzerano'],
            ['show-projects', 'Progetti',
             'Le cartelle dentro la radice dei progetti: apri, riprendi, elimina i dati'],
            ['show-other-folders', 'Fuori dai progetti',
             'Home, /tmp e altri percorsi da cui hai lanciato Claude. Si possono solo ripulire.'],
            ['show-alerts', 'Allarmi',
             'Avvisi quando una soglia di config/watchdog.conf viene superata'],
        ]) {
            const riga = new Adw.SwitchRow({title: titolo, subtitle: sottotitolo});
            riga.set_subtitle_lines(0);
            s.bind(chiave, riga, 'active', Gio.SettingsBindFlags.DEFAULT);
            sezioni.add(riga);
        }

        const quante = new Adw.SpinRow({
            title: 'Quanti progetti elencare',
            subtitle: 'I più pesanti per primi',
            adjustment: new Gtk.Adjustment({
                lower: 3, upper: 25, step_increment: 1, page_increment: 5,
            }),
        });
        s.bind('max-projects', quante, 'value', Gio.SettingsBindFlags.DEFAULT);
        sezioni.add(quante);

        const agg = new Adw.PreferencesGroup({
            title: 'Aggiornamento automatico',
            description: 'Ogni giro rilegge disco, spazio e progetti. Costa circa ' +
                         'mezzo secondo e aggiunge un punto alla linea di tendenza: ' +
                         'più è frequente, più fitto è il grafico.',
        });
        pagina.add(agg);

        const intervallo = new Adw.SpinRow({
            title: 'Ogni quanti secondi',
            subtitle: 'Da 30 secondi a 2 ore. Dieci minuti è un buon compromesso.',
            adjustment: new Gtk.Adjustment({
                lower: 30, upper: 7200, step_increment: 30, page_increment: 300,
            }),
        });
        intervallo.set_subtitle_lines(0);
        s.bind('refresh-seconds', intervallo, 'value', Gio.SettingsBindFlags.DEFAULT);
        agg.add(intervallo);
        agg.add(this._scorciatoie(s, 'refresh-seconds',
                                  [['1 min', 60], ['5 min', 300], ['10 min', 600],
                                   ['30 min', 1800], ['1 ora', 3600]]));

        return pagina;
    }

    /* ---------------------------------------------------------- quota --- */
    _paginaQuota(s) {
        const pagina = new Adw.PreferencesPage({
            title: 'Quota',
            icon_name: 'speedometer-symbolic',
        });

        const gruppo = new Adw.PreferencesGroup({
            title: 'Monitoraggio della quota Claude',
            description: 'Interroga «claude -p /usage» e rimuove subito la ' +
                         'trascrizione vuota che ogni invocazione lascia. ' +
                         'Non consuma token.',
        });
        pagina.add(gruppo);

        const attivo = new Adw.SwitchRow({
            title: 'Attiva',
            subtitle: 'Se lo spegni, le due barre della quota restano vuote',
        });
        s.bind('usage-enabled', attivo, 'active', Gio.SettingsBindFlags.DEFAULT);
        gruppo.add(attivo);

        const intervallo = new Adw.SpinRow({
            title: 'Ogni quanti secondi rileggerla',
            subtitle: 'Costa circa 2 secondi e un giro di rete, quindi va più ' +
                      'piano dell’aggiornamento normale. Minimo 5 minuti.',
            adjustment: new Gtk.Adjustment({
                lower: 300, upper: 86400, step_increment: 60, page_increment: 600,
            }),
        });
        intervallo.set_subtitle_lines(0);
        s.bind('usage-interval-seconds', intervallo, 'value', Gio.SettingsBindFlags.DEFAULT);
        gruppo.add(intervallo);
        gruppo.add(this._scorciatoie(s, 'usage-interval-seconds',
                                     [['5 min', 300], ['15 min', 900],
                                      ['30 min', 1800], ['1 ora', 3600],
                                      ['3 ore', 10800]]));

        return pagina;
    }

    /* ------------------------------------------------------ terminale --- */
    _paginaTerminale(s) {
        const pagina = new Adw.PreferencesPage({
            title: 'Progetti',
            icon_name: 'folder-symbolic',
        });

        const radice = new Adw.PreferencesGroup({
            title: 'Dove nascono i nuovi progetti',
            description: 'Il pulsante «+» accanto a «Progetti» nel popup chiede ' +
                         'un nome, crea la cartella qui dentro e ci apre subito ' +
                         'una sessione di Claude Code.',
        });
        pagina.add(radice);

        const campo = new Adw.EntryRow({title: 'Cartella', show_apply_button: true});
        campo.set_tooltip_text('Vuoto = automatico. Percorso assoluto o con la tilde.');
        s.bind('projects-root', campo, 'text', Gio.SettingsBindFlags.DEFAULT);
        radice.add(campo);

        // Il percorso si mostra, non si scrive nei testi: cambia da macchina a
        // macchina, e una guida che ne cita uno fisso è sbagliata altrove.
        const inUso = new Adw.ActionRow({title: 'In uso adesso'});
        inUso.set_subtitle_lines(0);
        const aggiornaInUso = () => {
            const scelta = s.get_string('projects-root').trim();
            inUso.set_subtitle(scelta
                ? this._abbrevia(this._espandi(scelta))
                : `${this._abbrevia(this._radiceRilevata())} — rilevata in automatico`);
        };
        aggiornaInUso();
        s.connect('changed::projects-root', aggiornaInUso);
        radice.add(inUso);

        spiega(radice, 'Vuoto = automatico',
               'Si usa la cartella che contiene il progetto claude-code-watchdog. ' +
               'Per sceglierne un\u2019altra scrivi un percorso assoluto, o uno ' +
               'che inizia con la tilde.');

        const conReadme = new Adw.SwitchRow({
            title: 'Crea un README.md',
            subtitle: 'Nome, data, percorso e il comando per riprendere, più ' +
                      'due righe da riempire su cos\u2019è il progetto.',
        });
        conReadme.set_subtitle_lines(0);
        s.bind('new-project-readme', conReadme, 'active', Gio.SettingsBindFlags.DEFAULT);
        radice.add(conReadme);

        const gruppo = new Adw.PreferencesGroup({
            title: 'Il pulsante «Riprendi»',
            description: 'Apre una scheda nel terminale, dentro la cartella del ' +
                         'progetto, ed esegue claude --resume. Quando Claude esce ' +
                         'resta una shell aperta, così la scheda non si chiude.',
        });
        pagina.add(gruppo);

        const shell = new Adw.EntryRow({title: 'Shell', show_apply_button: true});
        const rilevata = this._shellRilevata();
        shell.set_tooltip_text(`Rilevata ora: ${rilevata}`);
        s.bind('shell', shell, 'text', Gio.SettingsBindFlags.DEFAULT);
        gruppo.add(shell);

        spiega(gruppo, 'Vuoto = automatico',
               `Con il campo vuoto si usa la shell che il terminale ha già ` +
               `configurata — sul profilo di Ptyxis, se c’è un comando ` +
               `personalizzato — e solo in mancanza di quella la variabile ` +
               `SHELL. Adesso verrebbe usata: ${rilevata}. Viene avviata con ` +
               `-i, così legge i tuoi file di configurazione e ritrovi il tuo ` +
               `prompt e i tuoi alias.`);

        const avanzato = new Adw.PreferencesGroup({
            title: 'Comando personalizzato',
            description: 'Da riempire solo se il rilevamento automatico non va ' +
                         'bene: sostituisce del tutto il comando di apertura. ' +
                         '%d viene rimpiazzato con la cartella del progetto.',
        });
        pagina.add(avanzato);

        const comando = new Adw.EntryRow({title: 'Comando', show_apply_button: true});
        s.bind('terminal-command', comando, 'text', Gio.SettingsBindFlags.DEFAULT);
        avanzato.add(comando);
        spiega(avanzato, 'Esempio',
               'kitty --directory %d -- zsh -i -c ’claude --resume; exec zsh -i’');

        return pagina;
    }

    /* ----------------------------------------------------- sicurezza --- */
    _paginaSicurezza(s) {
        const pagina = new Adw.PreferencesPage({
            title: 'Sicurezza',
            icon_name: 'security-high-symbolic',
        });

        const gruppo = new Adw.PreferencesGroup({
            title: 'Conferme',
            description: 'In nessun caso viene toccata la cartella di lavoro di ' +
                         'un progetto: lì ci sono i file veri, non dati di Claude ' +
                         'Code. Lo script che cancella ha una rete di sicurezza ' +
                         'che salta qualunque percorso caschi lì dentro, anche se ' +
                         'ci finisse per errore.',
        });
        pagina.add(gruppo);

        const conferma = new Adw.SwitchRow({
            title: 'Mostra l’elenco prima di eliminare',
            subtitle: 'Spegnendolo, «Elimina dati» cancella al primo clic senza ' +
                      'mostrare cosa. Sconsigliato.',
        });
        conferma.set_subtitle_lines(0);
        s.bind('confirm-delete', conferma, 'active', Gio.SettingsBindFlags.DEFAULT);
        gruppo.add(conferma);

        return pagina;
    }

    /* -------------------------------------------------------- utilità --- */

    _scorciatoie(s, chiave, valori) {
        const riga = new Adw.ActionRow({title: 'Valori rapidi'});
        const box = new Gtk.Box({spacing: 6, valign: Gtk.Align.CENTER});
        for (const [etichetta, secondi] of valori) {
            const b = new Gtk.Button({label: etichetta});
            b.connect('clicked', () => s.set_int(chiave, secondi));
            box.append(b);
        }
        riga.add_suffix(box);
        return riga;
    }

    _espandi(percorso) {
        // Stessa normalizzazione dell'estensione, o «In uso adesso» mostrerebbe
        // un percorso che non è quello usato per il confronto.
        return percorso.replace(/^~/, GLib.get_home_dir()).replace(/\/+$/, '') || '/';
    }

    _abbrevia(percorso) {
        return percorso.replace(GLib.get_home_dir(), '~');
    }

    /* La cartella che l'estensione userebbe adesso. Si legge da metrics.json,
       che è la stessa fonte che usa il popup: mostrare un valore calcolato
       diversamente qui vorrebbe dire mentire all'utente. */
    _radiceRilevata() {
        try {
            const f = Gio.File.new_for_path(GLib.build_filenamev(
                [GLib.get_user_data_dir(), 'claude-code-watchdog', 'metrics.json']));
            const [ok, bytes] = f.load_contents(null);
            if (ok) {
                const d = JSON.parse(new TextDecoder().decode(bytes));
                if (d.progetto)
                    return GLib.path_get_dirname(d.progetto);
            }
        } catch {
            // Nessun dato ancora raccolto: si ripiega sulla home.
        }
        return GLib.get_home_dir();
    }

    /* Stessa logica di extension.js, ripetuta qui perché i due processi non
       condividono codice: serve a mostrare all'utente cosa verrà usato. */
    _shellRilevata() {
        try {
            const p = new Gio.Settings({schema_id: 'org.gnome.Ptyxis'});
            const uuid = p.get_string('default-profile-uuid');
            if (uuid) {
                const prof = new Gio.Settings({
                    schema_id: 'org.gnome.Ptyxis.Profile',
                    path: `/org/gnome/Ptyxis/Profiles/${uuid}/`,
                });
                if (prof.get_boolean('use-custom-command')) {
                    const cmd = prof.get_string('custom-command').trim();
                    if (cmd)
                        return `${cmd.split(/\s+/)[0]} (dal profilo di Ptyxis)`;
                }
            }
        } catch {
            // Ptyxis assente: si passa oltre.
        }
        return `${GLib.getenv('SHELL') || 'bash'} (da $SHELL)`;
    }
}
