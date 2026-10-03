// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CiroBoxHub

/* Impostazioni e guida di Claude Code Watchdog.
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

/* Una voce della guida: titolo in grassetto e testo a grandezza piena, del
   colore del testo. */
function voce(gruppo, titolo, testo) {
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4,
                             margin_top: 12, margin_bottom: 12,
                             margin_start: 14, margin_end: 14});
    box.append(new Gtk.Label({label: titolo, xalign: 0, wrap: true,
                              css_classes: ['heading']}));
    box.append(new Gtk.Label({label: testo, xalign: 0, wrap: true,
                              natural_wrap_mode: Gtk.NaturalWrapMode.WORD,
                              css_classes: ['body']}));
    const riga = new Adw.PreferencesRow({activatable: false, focusable: false, child: box});
    gruppo.add(riga);
    return riga;
}

/* Riga di sola lettura per le altre pagine: titolo e spiegazione breve. */
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
        window.add(this._paginaWatchface(s, window));
        window.add(this._paginaTerminale(s));
        window.add(this._paginaSicurezza(s));
    }

    /* ---------------------------------------------------------- guida --- */

    /* La guida si legge come un documento: ogni voce ha un titolo e un testo a
       grandezza piena. Prima stava nei sottotitoli delle righe, piccoli e
       grigi, pensati per mezza riga e non per un paragrafo. */
    _paginaGuida() {
        const pagina = new Adw.PreferencesPage({
            title: 'Guida',
            icon_name: 'help-about-symbolic',
        });
        const sezione = (titolo, descrizione = null) => {
            const g = new Adw.PreferencesGroup({title: titolo});
            if (descrizione)
                g.set_description(descrizione);
            pagina.add(g);
            return g;
        };

        const breve = sezione('In breve');
        voce(breve, 'Cosa fa',
             'Tiene d’occhio lo spazio del PC, i dati che Claude Code lascia sul ' +
             'disco e la quota di utilizzo, e mostra cosa sta facendo Claude in ' +
             'questo momento. Da qui puoi anche fare pulizia, senza aprire un ' +
             'terminale.');
        voce(breve, 'Quando preoccuparsi',
             'Se i numeri nella barra hanno il loro colore normale e nel popup ' +
             'non ci sono triangoli gialli, va tutto bene. L’ambra vuol dire ' +
             '«tienilo d’occhio», il rosso «intervieni».');
        voce(breve, 'La regola di fondo',
             'Prima si guarda, poi si cancella, e si cancella nel cestino. ' +
             'Nessun pulsante elimina al primo clic: il primo mostra cosa ' +
             'sparirebbe, voce per voce, e solo il secondo agisce.');

        const barra = sezione('La barra in alto',
                              'Scegli tu cosa mostrare, nella pagina «Barra».');
        voce(barra, 'I valori',
             'Disco, conversazioni, quota della sessione e della settimana, e ' +
             'altro ancora. Diventano ambra e poi rossi alle stesse soglie delle ' +
             'barre nel popup.');
        voce(barra, 'La faccina',
             'All’inizio della barra c’è la mascotte di Watchface, che cambia ' +
             'espressione con quello che fa Claude (vedi la sezione successiva). ' +
             'Se preferisci l’icona classica, spegnila nella pagina «Watchface».');
        voce(barra, 'Poco spazio?',
             'Le «etichette compatte» tolgono unità e sigle. Oppure accendi ' +
             '«un’icona per ogni indicatore»: occupa un po’ di più, ma i valori ' +
             'si riconoscono senza leggere.');

        const wf = sezione('Watchface: cosa fa Claude adesso',
                           'Funziona dopo aver installato gli hook, nella pagina ' +
                           '«Watchface».');
        voce(wf, 'Le quattro espressioni',
             'Dorme quando non ci sono sessioni. Ha gli occhi aperti quando Claude ' +
             'lavora. Apre la bocca, con un punto ambra, quando aspetta te: un ' +
             'permesso o una risposta. Sorride quando ha finito.');
        voce(wf, 'Il limone e il robottino',
             'Il limone prende il posto della faccina quando qualcosa si inceppa: ' +
             'la sessione si è fermata per un errore, oppure tre strumenti di fila ' +
             'sono falliti. Il robottino compare nel popup quando Claude ha ' +
             'mandato degli aiutanti, con il loro numero.');
        voce(wf, 'Più sessioni insieme',
             'La faccina mostra la più urgente: prima chi aspetta te, poi gli ' +
             'errori, poi chi lavora. In cima al popup, sotto «Claude adesso», ' +
             'c’è una riga per ogni sessione aperta.');
        voce(wf, 'Le notifiche',
             'Arrivano quando Claude aspetta te, quando si inceppa e quando ' +
             'finisce un lavoro di almeno mezzo minuto. Non arrivano se stai già ' +
             'guardando il terminale. Si spengono nella pagina «Watchface».');
        voce(wf, 'Come lo sa, e quanto costa',
             'A ogni passo Claude Code avvisa un piccolo script (un hook). Lo ' +
             'script scrive una riga in memoria e il pannello la legge solo quando ' +
             'cambia: pochi millesimi di secondo per evento, nessun controllo a ' +
             'intervalli. Non approva e non rifiuta niente: i permessi si danno ' +
             'sempre nel terminale.');

        const popup = sezione('Il popup', 'La forma di ogni misura dice che tipo di misura è.');
        voce(popup, 'Barra con tacche',
             'Per le grandezze che hanno un massimo: disco e quota. Le due tacche ' +
             'sono le soglie di attenzione e di allarme, e il colore cambia ' +
             'esattamente lì: prima il colore della misura, poi ambra, poi rosso.');
        voce(popup, 'Linea di tendenza',
             'Per lo spazio delle conversazioni, che non ha un «pieno». La linea ' +
             'mostra le ultime 60 rilevazioni, il punto segna il valore attuale e ' +
             'sotto è scritto di quanto è cambiato.');
        voce(popup, 'Cifra e pulsante',
             'Per lo spazio recuperabile: non è uno stato da sorvegliare ma una ' +
             'cosa su cui agire, quindi accanto c’è il pulsante «Libera spazio».');
        voce(popup, 'I colori',
             'Verde acqua per la macchina, viola per la quota. Ambra e rosso ' +
             'valgono per qualunque misura, alle stesse soglie.');

        const quota = sezione('La quota');
        voce(quota, 'Sessione e settimana',
             'La «sessione corrente» è una finestra di circa cinque ore che ' +
             'riparte dal primo uso, non la giornata: per questo è scritta l’ora ' +
             'esatta in cui si azzera. La settimana si azzera a giorno e ora ' +
             'fissi, ed è il limite da tenere d’occhio.');
        voce(quota, 'Non costa niente',
             'La quota si legge con il comando /usage di Claude Code: non usa ' +
             'token e non lascia conversazioni vuote in giro.');
        voce(quota, 'I consigli, con l’icona «i»',
             'Sotto le due barre può comparire una riga con l’icona «i». Passaci ' +
             'sopra o cliccala: dice quale progetto sta consumando di più e cosa ' +
             'fare, per esempio aprire una sessione nuova quando il contesto è ' +
             'diventato enorme. Se va tutto bene, la riga non c’è.');

        const prog = sezione('I progetti', 'Cliccando un progetto si aprono le sue azioni.');
        voce(prog, 'Nuovo progetto, con il «+»',
             'Accanto al titolo «Progetti». Scrivi un nome: la cartella nasce nella ' +
             'radice dei progetti (si sceglie nella pagina «Progetti») e ci si apre ' +
             'subito una sessione di Claude Code. Se vuoi, con un README di ' +
             'partenza. Invio conferma, Esc annulla.');
        voce(prog, 'Cartella e Riprendi',
             '«Cartella» apre la cartella nel gestore file. «Riprendi» apre una ' +
             'scheda del terminale nella cartella del progetto ed esegue ' +
             'claude --resume, con la tua shell di sempre.');
        voce(prog, 'Elimina dati',
             'Toglie solo i dati di Claude Code per quel progetto: conversazioni, ' +
             'memorie, scratchpad. La cartella di lavoro, con i tuoi file, non ' +
             'viene mai toccata. Tutto va nel cestino.');
        voce(prog, 'Correggi',
             'Compare quando la cartella di un progetto è stata spostata. Chiede ' +
             'dov’è finita, controlla che i file citati nelle conversazioni ci ' +
             'siano davvero, e poi ricollega le sessioni: così «Riprendi» torna a ' +
             'funzionare.');
        voce(prog, 'Il triangolo giallo',
             'Segnala qualcosa da sapere; fermando il mouse sulla riga si legge il ' +
             'dettaglio. Per esempio: la cartella di lavoro non esiste più, il ' +
             'progetto lavora sotto /tmp (che si svuota al riavvio), oppure le sue ' +
             'conversazioni sono mescolate con quelle di altri progetti.');
        voce(prog, 'Fuori dai progetti',
             'Le cartelle da cui hai lanciato Claude ma che non sono progetti: la ' +
             'home, /tmp, percorsi sparsi. Qui l’unica azione è togliere le ' +
             'sessioni.');

        const pulizia = sezione('Liberare spazio');
        voce(pulizia, 'Come funziona',
             '«Libera spazio» elenca cosa si può togliere: cestino scaduto, cache ' +
             'vecchie, scarti di Claude Code, versioni vecchie di Claude. Spunti ' +
             'quello che vuoi e confermi.');
        voce(pulizia, 'Sessioni automatiche orfane',
             'Alcuni programmi lanciano Claude da soli in una cartella temporanea. ' +
             'Quando quella cartella sparisce, le loro sessioni compaiono qui tutte ' +
             'insieme. Le tue conversazioni non ci finiscono mai, nemmeno se la ' +
             'loro cartella non c’è più.');
        voce(pulizia, 'Quello che qui non c’è',
             'Cache dei pacchetti, journal di sistema e kernel vecchi chiedono la ' +
             'password di amministratore: si puliscono con /watchdog-clean, non da ' +
             'un menu del pannello.');

        const agg = sezione('Quanto sono freschi i numeri');
        voce(agg, 'Due ritmi',
             'Disco, spazio e progetti si aggiornano da soli (ogni dieci minuti, di ' +
             'serie). La quota va più piano, ogni mezz’ora, perché richiede un ' +
             'accesso alla rete. Entrambi si regolano nelle pagine «Popup» e «Quota».');
        voce(agg, 'Aggiornare subito',
             'Il pulsante circolare in cima al popup rilegge tutto, quota compresa. ' +
             'Accanto è scritto quanto sono vecchi i dati.');
        voce(agg, 'Un intervallo troppo corto',
             'La linea di tendenza disegna le ultime 60 rilevazioni: con un minuto ' +
             'di intervallo copre un’ora, con dieci minuti dieci ore. Se il grafico ' +
             'ti sembra piatto, allunga l’intervallo.');

        const diag = sezione('Se qualcosa non torna');
        voce(diag, '«nessun dato» in cima al popup',
             'I dati non sono ancora stati raccolti. Premi il pulsante di ' +
             'aggiornamento; se non cambia, lancia bin/collect-metrics.py dalla ' +
             'cartella del progetto e leggi l’errore.');
        voce(diag, 'La faccina dorme sempre',
             'Gli hook non sono installati (pagina «Watchface»), oppure la sessione ' +
             'di Claude era già aperta quando li hai installati: Claude Code li ' +
             'legge all’avvio, quindi apri una sessione nuova.');
        voce(diag, 'Le barre della quota sono vuote',
             'Il monitoraggio è spento nella pagina «Quota», oppure il comando ' +
             'claude non si trova nel PATH.');
        voce(diag, '«Cartella» e «Riprendi» sono spenti',
             'La cartella di lavoro di quel progetto non esiste più: il triangolo ' +
             'giallo lo conferma. Se l’hai spostata, usa «Correggi».');
        voce(diag, '«Libera spazio» è spento',
             'Non c’è niente da liberare: nessun file ha superato le scadenze.');

        const dove = sezione('Dove stanno le cose');
        voce(dove, 'I dati del pannello',
             'In ~/.local/share/claude-code-watchdog/: metrics.json è la fotografia ' +
             'attuale, history.jsonl la serie storica (le ultime 2000 rilevazioni), ' +
             'usage.json l’ultima lettura della quota.');
        voce(dove, 'Soglie e scadenze',
             'In config/watchdog.conf, nella cartella del progetto ' +
             'claude-code-watchdog: soglie di colore, scadenze della pulizia e ' +
             'soglie dei consigli sulla quota. Si modificano lì, senza riavviare ' +
             'niente.');
        voce(dove, 'Hook e backup',
             'Gli hook di Watchface stanno in ~/.claude/settings.json. Prima di ' +
             'ogni modifica se ne fa un backup in ' +
             '~/.local/share/claude-code-watchdog/backup-settings/; i più recenti ' +
             'si ripristinano dalla pagina «Watchface».');

        const info = sezione('Informazioni');
        const autore = new Adw.ActionRow({
            title: 'Claude Code Watchdog',
            subtitle: `Versione ${this.metadata.version} · di CiroBoxHub · licenza GPL-2.0 o successiva`,
        });
        const link = new Gtk.LinkButton({
            label: 'Il progetto su GitHub',
            uri: this.metadata.url ?? 'https://github.com/CiroBoxHub/claude-code-watchdog',
            valign: Gtk.Align.CENTER,
        });
        autore.add_suffix(link);
        info.add(autore);

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
            icon_name: 'battery-level-50-symbolic',   // speedometer c'e' solo in Breeze (KDE)
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

    /* ------------------------------------------------------ watchface --- */
    _paginaWatchface(s, window) {
        const pagina = new Adw.PreferencesPage({
            title: 'Watchface',
            icon_name: 'face-smile-symbolic',
        });

        const aspetto = new Adw.PreferencesGroup({
            title: 'La mascotte',
            description: 'Cosa sta facendo Claude Code, nella barra e in cima al ' +
                         'popup: dorme, lavora, aspetta te, ha finito. Il limone ' +
                         'arriva quando qualcosa si inceppa, il robottino quando ' +
                         'Claude manda degli aiutanti.',
        });
        pagina.add(aspetto);
        const mascotte = new Adw.SwitchRow({
            title: 'Mostra la mascotte',
            subtitle: 'Spenta, resta l\u2019icona di sempre: lo stato urgente la ' +
                      'colora d\u2019ambra (aspetta te) o di rosso (errore).',
        });
        mascotte.set_subtitle_lines(0);
        s.bind('watchface-mascot', mascotte, 'active', Gio.SettingsBindFlags.DEFAULT);
        aspetto.add(mascotte);
        const notifiche = new Adw.SwitchRow({
            title: 'Notifiche',
            subtitle: 'Quando Claude aspetta una risposta, quando si inceppa, e ' +
                      'quando finisce un lavoro di almeno mezzo minuto. Mai se ' +
                      'stai già guardando il terminale.',
        });
        notifiche.set_subtitle_lines(0);
        s.bind('watchface-notifications', notifiche, 'active', Gio.SettingsBindFlags.DEFAULT);
        aspetto.add(notifiche);

        // Gli hook: senza, Watchface non sa niente. Li gestisce
        // watchface-hooks.py, che fa un backup di settings.json prima di ogni
        // modifica; qui ci sono solo i pulsanti.
        this._gruppoHook = new Adw.PreferencesGroup({
            title: 'Hook di Claude Code',
            description: 'Watchface sa cosa fa Claude perché Claude Code glielo ' +
                         'dice con un hook, in ~/.claude/settings.json. Prima di ' +
                         'ogni modifica si fa un backup del file.',
        });
        pagina.add(this._gruppoHook);
        this._gruppoAltri = new Adw.PreferencesGroup({
            title: 'Altri programmi negli hook',
            description: 'Hook di altri strumenti. Se uno fa lo stesso lavoro di ' +
                         'Watchface si può togliere da qui, con backup.',
        });
        pagina.add(this._gruppoAltri);
        this._gruppoBackup = new Adw.PreferencesGroup({
            title: 'Backup di settings.json',
            description: 'Gli ultimi dieci, uno per modifica. Ripristinarne uno ' +
                         'fa prima un backup di quello attuale.',
        });
        pagina.add(this._gruppoBackup);
        this._righeHook = [];
        this._finestra = window;
        this._aggiornaHook();
        return pagina;
    }

    /* Lancia watchface-hooks.py della copia installata — quella accanto
       all'hook che scrive nei settings — e passa l'esito a `fatto`. */
    _hooks(argomenti, fatto) {
        const script = GLib.build_filenamev([this.path, 'watchface-hooks.py']);
        try {
            const p = Gio.Subprocess.new(['python3', script, ...argomenti],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
            p.communicate_utf8_async(null, null, (src, res) => {
                let out = '', err = '';
                try {
                    [, out, err] = src.communicate_utf8_finish(res);
                } catch (e) {
                    err = e.message;
                }
                fatto(src.get_successful(), (out ?? '').trim(), (err ?? '').trim());
            });
        } catch (e) {
            fatto(false, '', e.message);
        }
    }

    _avviso(testo) {
        this._finestra?.add_toast(new Adw.Toast({title: testo, timeout: 4}));
    }

    _azioneHook(argomenti) {
        this._hooks(argomenti, (ok, out, err) => {
            this._avviso(ok ? out : `Non riuscito: ${err || out}`);
            this._aggiornaHook();
        });
    }

    /* Prima di toccare la configurazione di Claude Code si chiede: è un file
       dell'utente, e anche con il backup un clic distratto non va premiato. */
    _conferma(titolo, testo, etichetta, azione) {
        const d = new Adw.AlertDialog({heading: titolo, body: testo});
        d.add_response('annulla', 'Annulla');
        d.add_response('ok', etichetta);
        d.set_response_appearance('ok', Adw.ResponseAppearance.DESTRUCTIVE);
        d.set_default_response('annulla');
        d.set_close_response('annulla');
        d.connect('response', (_d, r) => {
            if (r === 'ok')
                azione();
        });
        d.present(this._finestra);
    }

    _aggiornaHook() {
        this._hooks(['stato', '--json'], (ok, out, err) => {
            for (const [gruppo, riga] of this._righeHook)
                gruppo.remove(riga);
            this._righeHook = [];
            const aggiungi = (gruppo, riga) => {
                gruppo.add(riga);
                this._righeHook.push([gruppo, riga]);
            };
            let st = null;
            try {
                st = ok ? JSON.parse(out) : null;
            } catch (e) {
                st = null;
            }
            if (!st) {
                aggiungi(this._gruppoHook, new Adw.ActionRow({
                    title: 'Stato non leggibile',
                    subtitle: err || 'settings.json non è JSON valido: non lo tocco.'}));
                return;
            }

            const n = st.installati.length, tot = n + st.mancanti.length;
            const riga = new Adw.ActionRow({
                title: n === tot ? 'Installati' : n === 0 ? 'Non installati' : 'Installati in parte',
                subtitle: n === tot
                    ? `Tutti i ${tot} eventi arrivano a Watchface.`
                    : n === 0
                        ? 'Senza hook la mascotte dorme sempre e non arriva nessuna notifica.'
                        : `${n} eventi su ${tot}: reinstallali per completarli.`,
            });
            riga.set_subtitle_lines(0);
            const bottone = (etichetta, classe, azione) => {
                const b = new Gtk.Button({label: etichetta, valign: Gtk.Align.CENTER});
                if (classe)
                    b.add_css_class(classe);
                b.connect('clicked', azione);
                return b;
            };
            if (n < tot) {
                riga.add_suffix(bottone(n ? 'Reinstalla' : 'Installa', 'suggested-action',
                                        () => this._azioneHook(['installa'])));
            }
            if (n > 0) {
                riga.add_suffix(bottone('Rimuovi', null, () => this._conferma(
                    'Togliere gli hook di Watchface?',
                    'La mascotte smetterà di seguire Claude. Si possono rimettere ' +
                    'quando vuoi, e prima si fa un backup di settings.json.',
                    'Rimuovi', () => this._azioneHook(['rimuovi']))));
            }
            aggiungi(this._gruppoHook, riga);

            this._gruppoAltri.visible = st.altri.length > 0;
            for (const a of st.altri) {
                const r = new Adw.ActionRow({
                    title: a.programma,
                    subtitle: `${a.eventi.length} eventi · ${a.percorso}`,
                });
                r.set_subtitle_lines(2);
                r.add_suffix(bottone('Rimuovi', 'destructive-action', () => this._conferma(
                    `Togliere gli hook di ${a.programma}?`,
                    `Si tolgono i suoi ${a.eventi.length} hook da settings.json, dopo ` +
                    'un backup. Il programma resta installato: si toglie solo il ' +
                    'collegamento con Claude Code.',
                    'Rimuovi', () => this._azioneHook(['rimuovi-altro', a.percorso]))));
                aggiungi(this._gruppoAltri, r);
            }

            this._gruppoBackup.visible = st.backup.length > 0;
            for (const f of st.backup.slice().reverse().slice(0, 5)) {
                const nome = GLib.path_get_basename(f);
                const m = /settings-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(nome);
                const r = new Adw.ActionRow({
                    title: m ? `${m[3]}/${m[2]}/${m[1]} alle ${m[4]}:${m[5]}:${m[6]}` : nome,
                    subtitle: nome,
                });
                r.add_suffix(bottone('Ripristina', null, () => this._conferma(
                    'Ripristinare questo backup?',
                    'settings.json torna com\u2019era in quel momento, hook e ' +
                    'impostazioni compresi. Prima si fa un backup di quello attuale.',
                    'Ripristina', () => this._azioneHook(['ripristina', f]))));
                aggiungi(this._gruppoBackup, r);
            }
        });
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
               'Si deduce dai progetti che hanno gi\u00e0 delle conversazioni: ' +
               'fra tutte le cartelle che ne contengono, vince quella che ne ha ' +
               'di pi\u00f9. Ne servono almeno due, e la home e /tmp non si ' +
               'considerano mai. Per sceglierne un\u2019altra scrivi un percorso ' +
               'assoluto, o uno che inizia con la tilde.');

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
                // Dedotta dai progetti gia' noti. Prima si ricavava da
                // «progetto», nullo quando lo script gira dentro
                // l'estensione: qui si leggeva «rilevata in automatico» e
                // sotto compariva la home.
                if (d.radiceProgetti)
                    return d.radiceProgetti;
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
