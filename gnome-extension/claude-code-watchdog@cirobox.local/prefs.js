// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CiroBoxHub

/* Impostazioni e guida di Claude Code Watchdog.
 *
 * Gira nel processo di gnome-extensions-app, separato dalla shell: qui GTK e
 * Adwaita esistono, dentro la shell no.
 *
 * Il disegno, rifatto il 2026-10-03 su richiesta dell'utente («iniziano a
 * diventare tante»): cinque pagine invece di sette, la ricerca accesa, ogni
 * riga con una tessera colorata dell'area a cui appartiene, sottotitoli di una
 * riga, e un «?» su ogni gruppo che porta alla sezione della guida. Le scelte
 * esclusive si vedono tutte insieme — un menu a tendina nascondeva il valore
 * scelto quando la finestra era stretta.
 */

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

/* Un colore per area, dalla palette dell'estensione: chi guarda la finestra
   capisce dove si trova prima di leggere. Le icone sono bianche: su queste
   tinte reggono il 3:1 che basta alla grafica. */
const STILE = `
.wd-tessera { border-radius: 8px; min-width: 30px; min-height: 30px; color: #ffffff; }
.wd-tessera-piccola { border-radius: 6px; min-width: 22px; min-height: 22px; }
.wd-verde { background-color: #2F9284; }
.wd-viola { background-color: #8676B8; }
.wd-ambra { background-color: #B77B1A; }
.wd-blu { background-color: #3A6FB0; }
.wd-rosso { background-color: #B23A31; }
.wd-grigio { background-color: #6E6E73; }
.wd-indice button { padding: 6px 10px; border-radius: 8px; }
`;

/* Gli indicatori per la barra, nell'ordine in cui compaiono, con l'icona
   che hanno nel pannello. */
const INDICATORI = [
    ['disco', 'Disco', 'Quanto è pieno /', 'fw-disk', 'verde'],
    ['claude', 'Peso delle conversazioni', 'Lo spazio che occupano, plugin esclusi', 'fw-data', 'verde'],
    ['sessioni', 'Numero di conversazioni', 'Quante ce ne sono in archivio', 'fw-chat', 'verde'],
    ['messaggi', 'Messaggi', 'Il totale: misura di lavoro, non di spazio', 'fw-pulse', 'verde'],
    ['recuperabile', 'Spazio recuperabile', 'Liberabile subito, senza password', 'fw-reclaim', 'verde'],
    ['quota-sessione', 'Quota della sessione', 'La finestra di circa cinque ore', 'fw-session', 'viola'],
    ['quota-settimana', 'Quota della settimana', 'Il limite che morde per primo', 'fw-week', 'viola'],
];

export default class WatchdogPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const s = this.getSettings();
        this._finestra = window;
        this._sezioniGuida = new Map();
        window.set_default_size(720, 760);
        // GNOME apre la finestra con la ricerca spenta; con cinque pagine
        // di voci serve: la lente trova un'impostazione ovunque stia.
        window.search_enabled = true;

        const stile = new Gtk.CssProvider();
        stile.load_from_string(STILE);
        Gtk.StyleContext.add_provider_for_display(Gdk.Display.get_default(), stile,
                                                  Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);

        // I segnali sulle impostazioni vanno staccati alla chiusura: la
        // finestra muore prima del processo, e un cambio successivo
        // toccherebbe righe già distrutte.
        this._segnali = [];
        window.connect('close-request', () => {
            for (const id of this._segnali)
                s.disconnect(id);
            this._segnali = [];
            return false;
        });

        this._guida = this._paginaGuida();
        window.add(this._guida);
        window.add(this._paginaPannello(s));
        window.add(this._paginaWatchface(s));
        window.add(this._paginaQuota(s));
        window.add(this._paginaProgetti(s));
    }

    /* ------------------------------------------------------- mattoncini --- */

    _tessera(icona, colore, piccola = false) {
        const img = icona.startsWith('fw-')
            ? Gtk.Image.new_from_gicon(Gio.icon_new_for_string(
                GLib.build_filenamev([this.path, 'icons', `${icona}-symbolic.svg`])))
            : Gtk.Image.new_from_icon_name(icona);
        img.pixel_size = piccola ? 14 : 16;
        // L'immagine si allarga dentro la tessera per stare al centro; la
        // tessera no, esplicitamente: altrimenti l'espansione risale alla
        // riga e sposta titoli e interruttori (visto nelle foto).
        const box = new Gtk.Box({halign: Gtk.Align.CENTER, valign: Gtk.Align.CENTER,
                                 hexpand: false, vexpand: false,
                                 css_classes: ['wd-tessera', `wd-${colore}`,
                                               ...(piccola ? ['wd-tessera-piccola'] : [])]});
        img.hexpand = img.vexpand = true;
        img.halign = img.valign = Gtk.Align.CENTER;
        box.append(img);
        return box;
    }

    /* Un gruppo con titolo, una riga di descrizione e il «?» che porta alla
       sezione della guida che lo spiega per esteso. */
    _gruppo(pagina, titolo, descrizione, sezioneGuida) {
        const g = new Adw.PreferencesGroup({title: titolo});
        if (descrizione)
            g.set_description(descrizione);
        if (sezioneGuida) {
            const b = new Gtk.Button({icon_name: 'help-about-symbolic', valign: Gtk.Align.CENTER,
                                      tooltip_text: 'Spiegato nella guida',
                                      css_classes: ['flat', 'circular']});
            b.connect('clicked', () => this._vaiAllaGuida(sezioneGuida));
            g.set_header_suffix(b);
        }
        pagina.add(g);
        return g;
    }

    _interruttore(gruppo, s, chiave, titolo, sottotitolo, icona, colore) {
        const r = new Adw.SwitchRow({title: titolo, subtitle: sottotitolo ?? ''});
        if (icona)
            r.add_prefix(this._tessera(icona, colore));
        s.bind(chiave, r, 'active', Gio.SettingsBindFlags.DEFAULT);
        gruppo.add(r);
        return r;
    }

    _numero(gruppo, s, chiave, titolo, sottotitolo, [min, max, passo, pagina], icona, colore) {
        const r = new Adw.SpinRow({
            title: titolo, subtitle: sottotitolo ?? '',
            adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: passo,
                                            page_increment: pagina}),
        });
        if (icona)
            r.add_prefix(this._tessera(icona, colore));
        s.bind(chiave, r, 'value', Gio.SettingsBindFlags.DEFAULT);
        gruppo.add(r);
        return r;
    }

    /* Una scelta fra pochi valori, tutti visibili: bottoni affiancati, quello
       scelto premuto. */
    _bottoniScelta(gruppo, s, chiave, titolo, valori, icona, colore) {
        const r = new Adw.ActionRow({title: titolo});
        if (icona)
            r.add_prefix(this._tessera(icona, colore));
        const box = new Gtk.Box({valign: Gtk.Align.CENTER, css_classes: ['linked']});
        const bottoni = valori.map(([valore, etichetta]) => {
            const b = new Gtk.ToggleButton({label: etichetta});
            b.connect('toggled', () => {
                if (b.active && s.get_string(chiave) !== valore)
                    s.set_string(chiave, valore);
            });
            box.append(b);
            return [valore, b];
        });
        for (const [, b] of bottoni.slice(1))
            b.set_group(bottoni[0][1]);
        const leggi = () => {
            const ora = s.get_string(chiave);
            for (const [valore, b] of bottoni)
                b.active = valore === ora;
        };
        leggi();
        this._segnali.push(s.connect(`changed::${chiave}`, leggi));
        r.add_suffix(box);
        gruppo.add(r);
        return r;
    }

    /* Una scelta fra alternative che hanno bisogno di una spiegazione: una
       riga per alternativa, con il pallino. */
    _pallini(gruppo, s, chiave, voci) {
        const righe = [];
        let primo = null;
        for (const [valore, titolo, sottotitolo, icona, colore] of voci) {
            const pallino = new Gtk.CheckButton({valign: Gtk.Align.CENTER});
            if (primo)
                pallino.set_group(primo);
            primo ??= pallino;
            const r = new Adw.ActionRow({title: titolo, subtitle: sottotitolo,
                                         activatable_widget: pallino});
            r.add_prefix(pallino);
            r.add_suffix(this._tessera(icona, colore));
            pallino.connect('toggled', () => {
                if (pallino.active && s.get_string(chiave) !== valore)
                    s.set_string(chiave, valore);
            });
            gruppo.add(r);
            righe.push([valore, pallino]);
        }
        const leggi = () => {
            const ora = s.get_string(chiave);
            for (const [valore, p] of righe)
                p.active = valore === ora;
        };
        leggi();
        this._segnali.push(s.connect(`changed::${chiave}`, leggi));
    }

    _scorciatoie(gruppo, s, chiave, valori) {
        const riga = new Adw.ActionRow({title: 'Rapidi'});
        const box = new Gtk.Box({valign: Gtk.Align.CENTER, css_classes: ['linked']});
        for (const [etichetta, secondi] of valori) {
            const b = new Gtk.Button({label: etichetta});
            b.connect('clicked', () => s.set_int(chiave, secondi));
            box.append(b);
        }
        riga.add_suffix(box);
        gruppo.add(riga);
        return riga;
    }

    _bottone(etichetta, classe, azione) {
        const b = new Gtk.Button({label: etichetta, valign: Gtk.Align.CENTER});
        if (classe)
            b.add_css_class(classe);
        b.connect('clicked', azione);
        return b;
    }

    /* La guida, scorsa fino alla sezione chiesta. Il gruppo si misura dopo
       che la pagina è stata disposta, quindi al giro successivo. */
    _vaiAllaGuida(chiave) {
        this._finestra.visible_page = this._guida;
        const gruppo = this._sezioniGuida.get(chiave);
        if (!gruppo)
            return;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            let w = this._guida.get_first_child();
            while (w && !(w instanceof Gtk.ScrolledWindow))
                w = w.get_next_sibling();
            if (w) {
                const [ok, p] = gruppo.compute_point(w.get_child(), new Graphene.Point({x: 0, y: 0}));
                if (ok)
                    w.vadjustment.value = Math.max(0, p.y - 12);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    /* ---------------------------------------------------------- guida --- */

    /* La guida si legge come un documento: ogni voce ha un titolo e un testo a
       grandezza piena. In cima l'indice, che porta a ogni sezione. */
    _paginaGuida() {
        const pagina = new Adw.PreferencesPage({title: 'Guida', icon_name: 'help-about-symbolic'});
        const indice = new Adw.PreferencesGroup({title: 'Indice'});
        const pulsanti = new Gtk.FlowBox({selection_mode: Gtk.SelectionMode.NONE,
                                          column_spacing: 4, row_spacing: 2,
                                          min_children_per_line: 2, max_children_per_line: 3,
                                          homogeneous: true,
                                          css_classes: ['wd-indice']});
        indice.add(pulsanti);
        pagina.add(indice);

        const sezione = (chiave, titolo, colore, icona, descrizione = null) => {
            const g = new Adw.PreferencesGroup({title: titolo});
            if (descrizione)
                g.set_description(descrizione);
            g.set_header_suffix(this._tessera(icona, colore, true));
            pagina.add(g);
            this._sezioniGuida.set(chiave, g);
            const b = new Gtk.Button({css_classes: ['flat'], halign: Gtk.Align.START});
            const dentro = new Gtk.Box({spacing: 8});
            dentro.append(this._tessera(icona, colore, true));
            dentro.append(new Gtk.Label({label: titolo}));
            b.set_child(dentro);
            b.connect('clicked', () => this._vaiAllaGuida(chiave));
            pulsanti.append(b);
            return g;
        };
        /* Titolo in grassetto e testo a grandezza piena. Il titolo va anche
           nella riga, nascosto: è quello che trova la ricerca. */
        const voce = (gruppo, titolo, testo) => {
            const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 4,
                                     margin_top: 12, margin_bottom: 12,
                                     margin_start: 14, margin_end: 14});
            box.append(new Gtk.Label({label: titolo, xalign: 0, wrap: true,
                                      css_classes: ['heading']}));
            box.append(new Gtk.Label({label: testo, xalign: 0, wrap: true,
                                      natural_wrap_mode: Gtk.NaturalWrapMode.WORD,
                                      css_classes: ['body']}));
            gruppo.add(new Adw.PreferencesRow({title: titolo, activatable: false,
                                               focusable: false, child: box}));
        };

        const breve = sezione('breve', 'In breve', 'grigio', 'fw-gauge');
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
        voce(breve, 'Cercare un’impostazione',
             'La lente in alto cerca in tutte le pagine, guida compresa. Il «?» ' +
             'accanto a ogni gruppo di impostazioni porta qui, alla sezione che lo ' +
             'spiega.');

        const barra = sezione('barra', 'La barra in alto', 'verde', 'fw-disk',
                              'Scegli cosa mostrare nella pagina «Pannello».');
        voce(barra, 'I valori',
             'Disco, conversazioni, quota della sessione e della settimana, e ' +
             'altro ancora. Diventano ambra e poi rossi alle stesse soglie delle ' +
             'barre nel popup.');
        voce(barra, 'La faccina',
             'All’inizio della barra c’è la mascotte di Watchface, che cambia ' +
             'espressione con quello che fa Claude (vedi la sezione successiva). ' +
             'Nella pagina «Watchface» se ne sceglie la grandezza, e la si spegne ' +
             'nella barra, nel popup o in tutti e due.');
        voce(barra, 'Poco spazio?',
             'Le «etichette compatte» tolgono unità e sigle. Oppure accendi ' +
             '«un’icona per ogni indicatore»: occupa un po’ di più, ma i valori ' +
             'si riconoscono senza leggere.');

        const wf = sezione('watchface', 'Watchface: cosa fa Claude adesso', 'ambra',
                           'face-smile-symbolic',
                           'Funziona dopo aver installato gli hook, nella pagina «Watchface».');
        voce(wf, 'Le quattro espressioni',
             'Dorme quando non ci sono sessioni. Ha gli occhi aperti quando Claude ' +
             'lavora. Apre la bocca, con un punto ambra, quando aspetta te: un ' +
             'permesso o una risposta. Sorride quando ha finito.');
        voce(wf, 'Il limone e il robottino',
             'Il limone prende il posto della faccina quando qualcosa si inceppa: ' +
             'la sessione si è fermata per un errore, oppure tre strumenti di fila ' +
             'sono falliti. Il robottino compare quando Claude ha mandato degli ' +
             'aiutanti, con il loro numero; se Claude ha finito ma loro lavorano ' +
             'ancora, prende il posto della faccina.');
        voce(wf, 'Il limone con gli occhi all’insù',
             'Compare durante un /compact, quando Claude riassume la conversazione ' +
             'per liberare spazio: lo chiedi tu, oppure lo fa da solo quando il ' +
             'contesto è pieno. È lavoro, ma non una risposta: niente avvisi, e ' +
             'il bordo della mascotte e il limone nella barra diventano blu. Finito il /compact chiesto da ' +
             'te, la faccina sorride, perché tocca di nuovo a te; dopo quello ' +
             'automatico Claude riprende il lavoro. Se dopo un aggiornamento non lo ' +
             'vedi mai, reinstalla gli hook dalla pagina «Watchface».');
        voce(wf, 'Più sessioni insieme',
             'La faccina mostra la più urgente: prima chi aspetta te, poi gli ' +
             'errori, poi chi lavora, poi chi fa un /compact. In cima al popup, sotto «Claude adesso», ' +
             'c’è una riga per ogni sessione aperta; quelle che Claude avvia in ' +
             'background stanno rientrate sotto la sessione che le ha avviate.');
        voce(wf, 'Dalla riga al terminale',
             'Un clic su una sessione, nel popup, nella notifica o nella mascotte ' +
             'fluttuante, porta davanti la finestra del terminale in cui gira. Se ' +
             'il terminale tiene più sessioni in schede della stessa finestra, ' +
             'arrivi alla finestra e la scheda la scegli tu.');
        voce(wf, 'Gli avvisi',
             'Quando Claude aspetta te, si inceppa o finisce un lavoro di almeno ' +
             'mezzo minuto, Watchface te lo dice in uno di due modi: una notifica, ' +
             'oppure la mascotte fluttuante. Oppure per niente: restano la faccina ' +
             'e il popup. Mai se stai già guardando il terminale.');
        voce(wf, 'La mascotte fluttuante',
             'Compare in basso a destra solo quando Claude ha qualcosa da dirti. ' +
             'La nuvoletta elenca gli avvisi di tutte le sessioni, col numero sul ' +
             'disco della faccina; quello evidenziato dà il colore a tutto, e un ' +
             'clic su un’altra riga lo cambia. Un clic sulla faccina porta al ' +
             'terminale di quella evidenziata.');
        voce(wf, 'I segni che lampeggiano',
             'Niente lampeggia per abitudine: una cosa che si muove sempre ' +
             'diventa fondale. Compare un segno solo quando serve, ed è lui a ' +
             'lampeggiare: due punti interrogativi sul disco quando Claude ' +
             'aspetta te, due esclamativi sul limone quando si è inceppato, una ' +
             'lampadina sopra la testa quando c’è lavoro in corso, suo o dei suoi ' +
             'aiutanti. Con le animazioni di GNOME spente, niente lampeggia.');
        voce(wf, 'Il mod',
             'Il pulsante «Installa» attiva anche un mod: un pezzo di programma ' +
             'che gira dentro Claude Code e gli chiede le due cose che da fuori si ' +
             'possono solo dedurre. La quota, che Claude Code conosce già: senza ' +
             'il mod va chiesta accendendo una copia della sua riga di comando ' +
             'ogni mezz’ora. E quali aiutanti stanno ancora lavorando: senza il ' +
             'mod chi finisce in background resta contato fino a un’ora, perché il ' +
             'suo segnale di fine arriva a un altro processo. E quando il turno ' +
             'finisce senza una risposta — lo interrompi con Esc, il modello ' +
             'rifiuta, la chiamata va in errore — Claude Code non manda nessun ' +
             'segnale e la faccina restava su «sta lavorando»: il mod quel ' +
             'momento lo vede. Scrive gli stessi ' +
             'file del resto di Watchface, quindi si può spegnere da solo e tutto ' +
             'torna come prima. Vale per le sessioni di Claude aperte da lì in poi.');
        voce(wf, 'Quando se ne va',
             'Ogni riga si toglie da sola quando la sua sessione riparte. «Ha ' +
             'finito» dopo i secondi che scegli (0: resta finché non la chiudi); ' +
             'la × toglie una riga sola. Senza righe la mascotte si ritira. ' +
             'Trascinala dove vuoi: si ricorda il posto. Sopra un video o un gioco ' +
             'a schermo intero non compare.');
        voce(wf, 'Sempre visibile',
             'Accesa nella pagina «Watchface», la mascotte fluttuante resta sullo ' +
             'schermo, sopra le finestre, anche quando non ha niente da dire: la ' +
             'sua faccia segue Claude come quella della barra, e la nuvoletta ' +
             'compare solo con gli avvisi. Un clic porta al terminale della ' +
             'sessione più urgente.');
        voce(wf, 'Le sessioni dei programmi non compaiono',
             'Solo le sessioni aperte da una persona. Quelle avviate da un ' +
             'programma (claude -p, l’SDK, la lettura della quota) nessuno le ' +
             'guarda, e non entrano nella faccina.');
        voce(wf, 'Come lo sa, e quanto costa',
             'A ogni passo Claude Code avvisa un piccolo script (un hook). Lo ' +
             'script scrive una riga in memoria e il pannello la legge solo quando ' +
             'cambia: pochi millesimi di secondo per evento, nessun controllo a ' +
             'intervalli. Non approva e non rifiuta niente: i permessi si danno ' +
             'sempre nel terminale.');
        voce(wf, 'Hook e backup',
             'Gli hook stanno in ~/.claude/settings.json. Prima di ogni modifica ' +
             'se ne fa un backup, e se ne tengono i tre più recenti: dalla pagina ' +
             '«Watchface» si ripristinano o si buttano nel cestino, e si possono anche togliere gli hook di altri ' +
             'programmi che fanno lo stesso lavoro.');

        const popup = sezione('popup', 'Il popup', 'verde', 'view-list-symbolic',
                              'La forma di ogni misura dice che tipo di misura è.');
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

        const quota = sezione('quota', 'La quota', 'viola', 'fw-week');
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
             'diventato enorme. Guarda solo le sessioni in uso e il loro contesto ' +
             'di adesso: dopo un /compact sparisce al giro successivo, e se apri ' +
             'una sessione nuova quella vecchia esce dai consigli dopo 12 ore ' +
             'ferma. Se va tutto bene, la riga non c’è.');

        const agg = sezione('aggiornamento', 'Quanto sono freschi i numeri', 'viola',
                            'view-refresh-symbolic');
        voce(agg, 'Due ritmi',
             'Disco, spazio e progetti si aggiornano da soli (ogni dieci minuti, di ' +
             'serie). La quota va più piano, ogni mezz’ora, perché richiede un ' +
             'accesso alla rete. Si regolano tutti e due nella pagina «Quota».');
        voce(agg, 'Aggiornare subito',
             'Il pulsante circolare in cima al popup rilegge tutto, quota compresa. ' +
             'Accanto è scritto quanto sono vecchi i dati.');
        voce(agg, 'Un intervallo troppo corto',
             'La linea di tendenza disegna le ultime 60 rilevazioni: con un minuto ' +
             'di intervallo copre un’ora, con dieci minuti dieci ore. Se il grafico ' +
             'ti sembra piatto, allunga l’intervallo.');

        const prog = sezione('progetti', 'I progetti', 'blu', 'folder-symbolic',
                             'Cliccando un progetto nel popup si aprono le sue azioni.');
        voce(prog, 'Nuovo progetto, con il «+»',
             'Accanto al titolo «Progetti». Scrivi un nome: la cartella nasce nella ' +
             'radice dei progetti (si sceglie nella pagina «Progetti») e ci si apre ' +
             'subito una sessione di Claude Code. Se vuoi, con un README di ' +
             'partenza. Invio conferma, Esc annulla.');
        voce(prog, 'La radice dei progetti',
             'Lasciata vuota si deduce da sola: fra le cartelle che contengono ' +
             'progetti con delle conversazioni vince quella che ne ha di più. Ne ' +
             'servono almeno due, e la home e /tmp non si considerano mai. Per ' +
             'sceglierne un’altra scrivi un percorso assoluto o che inizia con la ' +
             'tilde.');
        voce(prog, 'Cartella e Riprendi',
             '«Cartella» apre la cartella nel gestore file. «Riprendi» apre una ' +
             'scheda del terminale nella cartella del progetto ed esegue ' +
             'claude --resume, con la tua shell di sempre. Con la shell vuota si ' +
             'usa quella del terminale (sul profilo di Ptyxis, se c’è) o quella ' +
             'della variabile SHELL, avviata con -i perché legga la tua ' +
             'configurazione. Il comando personalizzato sostituisce tutto: %d ' +
             'diventa la cartella del progetto.');
        voce(prog, 'Elimina dati',
             'Toglie solo i dati di Claude Code per quel progetto: conversazioni, ' +
             'memorie, scratchpad. La cartella di lavoro, con i tuoi file, non ' +
             'viene mai toccata, nemmeno per errore: lo script che cancella salta ' +
             'qualunque percorso caschi lì dentro. Tutto va nel cestino.');
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

        const pulizia = sezione('pulizia', 'Liberare spazio', 'verde', 'fw-reclaim');
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

        const diag = sezione('problemi', 'Se qualcosa non torna', 'rosso', 'dialog-warning-symbolic');
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

        const dove = sezione('dove', 'Dove stanno le cose', 'grigio', 'folder-symbolic');
        voce(dove, 'I dati del pannello',
             'In ~/.local/share/claude-code-watchdog/: metrics.json è la fotografia ' +
             'attuale, history.jsonl la serie storica (le ultime 2000 rilevazioni), ' +
             'usage.json l’ultima lettura della quota.');
        voce(dove, 'Soglie e scadenze',
             'In watchdog.conf: soglie di colore, scadenze della pulizia e soglie ' +
             'dei consigli sulla quota. Si modificano lì, senza riavviare niente.');

        const info = sezione('info', 'Informazioni', 'grigio', 'fw-gauge');
        const autore = new Adw.ActionRow({
            title: 'Claude Code Watchdog',
            subtitle: `Versione ${this.metadata.version} · di CiroBoxHub · licenza GPL-2.0 o successiva`,
        });
        autore.add_suffix(new Gtk.LinkButton({
            label: 'Il progetto su GitHub',
            uri: this.metadata.url ?? 'https://github.com/CiroBoxHub/claude-code-watchdog',
            valign: Gtk.Align.CENTER,
        }));
        info.add(autore);

        return pagina;
    }

    /* -------------------------------------------------------- pannello --- */

    _paginaPannello(s) {
        const pagina = new Adw.PreferencesPage({title: 'Pannello',
                                                icon_name: 'view-continuous-symbolic'});

        const valori = this._gruppo(pagina, 'Valori nella barra',
                                    'Più ne accendi, più spazio occupa la barra.', 'barra');
        const attivi = () => s.get_strv('panel-indicators');
        for (const [chiave, titolo, sottotitolo, icona, colore] of INDICATORI) {
            const r = new Adw.SwitchRow({title: titolo, subtitle: sottotitolo});
            r.add_prefix(this._tessera(icona, colore));
            r.active = attivi().includes(chiave);
            r.connect('notify::active', () => {
                // Si riscrive l'elenco intero nell'ordine canonico, così la
                // barra non dipende dall'ordine in cui si è cliccato.
                const scelti = INDICATORI.map(([k]) => k)
                    .filter(k => (k === chiave ? r.active : attivi().includes(k)));
                s.set_strv('panel-indicators', scelti);
            });
            valori.add(r);
        }

        const aspetto = this._gruppo(pagina, 'Aspetto della barra', null, 'barra');
        this._interruttore(aspetto, s, 'panel-show-icon', 'Icona principale',
                           'Il misuratore a sinistra dei valori', 'fw-gauge', 'grigio');
        this._interruttore(aspetto, s, 'panel-icons', 'Un’icona per ogni valore',
                           'Si riconoscono senza leggere', 'fw-info', 'grigio');
        this._interruttore(aspetto, s, 'panel-compact', 'Etichette compatte',
                           '«94» invece di «94 MB»', 'view-continuous-symbolic', 'grigio');

        const sezioni = this._gruppo(pagina, 'Sezioni del popup',
                                     'Disco e dati di Claude ci sono sempre.', 'popup');
        this._interruttore(sezioni, s, 'show-usage', 'Quota Claude',
                           'Sessione e settimana, con l’azzeramento', 'fw-session', 'viola');
        this._interruttore(sezioni, s, 'show-projects', 'Progetti',
                           'Apri, riprendi, elimina i dati', 'folder-symbolic', 'blu');
        this._interruttore(sezioni, s, 'show-other-folders', 'Fuori dai progetti',
                           'Home, /tmp e altri percorsi', 'folder-symbolic', 'grigio');
        this._interruttore(sezioni, s, 'show-alerts', 'Allarmi',
                           'Quando una soglia viene superata', 'dialog-warning-symbolic', 'ambra');
        this._numero(sezioni, s, 'max-projects', 'Quanti progetti elencare',
                     'I più pesanti per primi', [3, 25, 1, 5], 'view-list-symbolic', 'blu');

        return pagina;
    }

    /* ------------------------------------------------------- watchface --- */

    _paginaWatchface(s) {
        const pagina = new Adw.PreferencesPage({title: 'Watchface',
                                                icon_name: 'face-smile-symbolic'});

        const mascotte = this._gruppo(pagina, 'La mascotte',
                                      'Cambia espressione con quello che fa Claude.', 'watchface');
        const inBarra = this._interruttore(mascotte, s, 'watchface-mascot', 'Faccina nella barra',
                                           'Spenta, resta l’icona classica', 'face-smile-symbolic',
                                           'ambra');
        const inPopup = this._interruttore(mascotte, s, 'watchface-mascot-popup',
                                           'Faccine nel popup',
                                           'Una per sessione, col robottino', 'view-list-symbolic',
                                           'ambra');
        const taglia = this._bottoniScelta(mascotte, s, 'watchface-size', 'Grandezza',
                                           [['piccola', 'Piccola'], ['media', 'Media'],
                                            ['grande', 'Grande']],
                                           'zoom-in-symbolic', 'ambra');
        const sensibile = () => {
            taglia.sensitive = inBarra.active || inPopup.active ||
                               s.get_string('watchface-alerts') === 'mascotte' ||
                               s.get_boolean('watchface-floating-always');
        };
        inBarra.connect('notify::active', sensibile);
        inPopup.connect('notify::active', sensibile);

        const avvisi = this._gruppo(pagina, 'Come avvisarti',
                                    'Quando Claude ti aspetta, si inceppa o ha finito.',
                                    'watchface');
        this._pallini(avvisi, s, 'watchface-alerts', [
            ['notifiche', 'Notifiche', 'Come le altre app; restano finché non le chiudi',
             'preferences-system-notifications-symbolic', 'blu'],
            ['mascotte', 'Mascotte fluttuante', 'Una nuvoletta sullo schermo, con tutti gli avvisi',
             'face-smile-symbolic', 'ambra'],
            ['nessuno', 'Nessun avviso', 'Restano la faccina e il popup',
             'notifications-disabled-symbolic', 'grigio'],
        ]);
        const fluttuante = this._gruppo(pagina, 'Mascotte fluttuante',
                                        'Sopra le finestre; si trascina dove vuoi.', 'watchface');
        const sempre = this._interruttore(fluttuante, s, 'watchface-floating-always',
                                          'Sempre visibile',
                                          'Segue Claude anche senza avvisi', 'face-smile-symbolic',
                                          'ambra');
        const durata = this._numero(fluttuante, s, 'watchface-floating-seconds',
                                    'Quanto resta «ha finito»',
                                    'Secondi; 0 finché non la chiudi', [0, 120, 1, 10],
                                    'view-refresh-symbolic', 'ambra');
        const posto = new Adw.ActionRow({title: 'Rimettila nell’angolo',
                                         subtitle: 'In basso a destra del monitor principale'});
        posto.add_prefix(this._tessera('view-continuous-symbolic', 'ambra'));
        posto.add_suffix(this._bottone('Rimetti', null, () => {
            s.reset('watchface-floating-y');
            s.reset('watchface-floating-x');
        }));
        fluttuante.add(posto);
        // La durata vale per gli avvisi della mascotte; il posto anche per
        // quella sempre visibile.
        const modo = () => {
            const avvisa = s.get_string('watchface-alerts') === 'mascotte';
            durata.sensitive = avvisa;
            posto.sensitive = avvisa || sempre.active;
            sensibile();
        };
        modo();
        sempre.connect('notify::active', modo);
        this._segnali.push(s.connect('changed::watchface-alerts', modo));

        // Gli hook: senza, Watchface non sa niente. Li gestisce
        // watchface-hooks.py, che fa un backup di settings.json prima di ogni
        // modifica; qui ci sono solo i pulsanti.
        this._gruppoHook = this._gruppo(pagina, 'Hook di Claude Code',
                                        'Come Claude Code avvisa Watchface.', 'watchface');
        this._gruppoAltri = this._gruppo(pagina, 'Altri programmi negli hook',
                                         'Se uno fa lo stesso lavoro, si può togliere.',
                                         'watchface');
        this._gruppoBackup = this._gruppo(pagina, 'Backup di settings.json',
                                          'Uno per modifica; si tengono gli ultimi tre.',
                                          'watchface');
        this._righeHook = [];
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
                const r = new Adw.ActionRow({
                    title: 'Stato non leggibile',
                    subtitle: err || 'settings.json non è JSON valido: non lo tocco.'});
                r.add_prefix(this._tessera('dialog-warning-symbolic', 'rosso'));
                aggiungi(this._gruppoHook, r);
                this._gruppoAltri.visible = this._gruppoBackup.visible = false;
                return;
            }

            const n = st.installati.length, tot = n + st.mancanti.length;
            const riga = new Adw.ActionRow({
                title: n === tot ? 'Installati' : n === 0 ? 'Non installati' : 'Installati in parte',
                subtitle: n === tot
                    ? `Tutti i ${tot} eventi arrivano a Watchface`
                    : n === 0
                        ? 'Senza hook la mascotte dorme sempre'
                        : `${n} eventi su ${tot}: reinstallali`,
            });
            riga.add_prefix(n === tot
                ? this._tessera('object-select-symbolic', 'verde')
                : this._tessera('dialog-warning-symbolic', n === 0 ? 'rosso' : 'ambra'));
            if (n < tot) {
                riga.add_suffix(this._bottone(n ? 'Reinstalla' : 'Installa', 'suggested-action',
                                              () => this._azioneHook(['installa'])));
            }
            if (n > 0) {
                riga.add_suffix(this._bottone('Rimuovi', null, () => this._conferma(
                    'Togliere gli hook di Watchface?',
                    'La mascotte smetterà di seguire Claude. Si possono rimettere ' +
                    'quando vuoi, e prima si fa un backup di settings.json.',
                    'Rimuovi', () => this._azioneHook(['rimuovi']))));
            }
            aggiungi(this._gruppoHook, riga);

            /* Il mod: gli hook dicono cosa sta facendo Claude, il mod aggiunge
               le due cose che da fuori si indovinano — la quota (che il motore
               ha in casa, senza accendere una CLI ogni mezz'ora) e quali
               aiutanti sono ancora al lavoro. Sta in questo gruppo e non in
               uno suo perché per chi installa è una cosa sola; il pulsante
               esiste anche a hook già installati, se no chi aggiorna non
               avrebbe modo di attivarlo. */
            const rigaMod = new Adw.ActionRow({
                title: !st.modPresente ? 'Mod non disponibile'
                    : st.modInstallato ? 'Mod attivo' : 'Mod non attivo',
                subtitle: !st.modPresente
                    ? 'Non è nel pacchetto di questa estensione'
                    : st.modInstallato
                        ? 'Quota e aiutanti letti da dentro Claude Code · vale ' +
                          'per le sessioni aperte da qui in poi'
                        : 'Senza, la quota costa una CLI ogni mezz\'ora e gli ' +
                          'aiutanti si contano a scadenza',
            });
            rigaMod.set_subtitle_lines(2);
            rigaMod.add_prefix(!st.modPresente
                ? this._tessera('system-run-symbolic', 'grigio')
                : st.modInstallato
                    ? this._tessera('object-select-symbolic', 'verde')
                    : this._tessera('dialog-information-symbolic', 'ambra'));
            if (st.modPresente && !st.modInstallato) {
                rigaMod.add_suffix(this._bottone('Attiva', 'suggested-action',
                    () => this._azioneHook(['mod-attiva'])));
            }
            if (st.modPresente && st.modInstallato) {
                rigaMod.add_suffix(this._bottone('Disattiva', null, () => this._conferma(
                    'Disattivare il mod?',
                    'Gli hook restano: Watchface continua a funzionare come ' +
                    'prima del mod. Torna a leggere la quota con una CLI ogni ' +
                    'mezz\'ora e a far scadere gli aiutanti dopo un\'ora.',
                    'Disattiva', () => this._azioneHook(['mod-disattiva']))));
            }
            aggiungi(this._gruppoHook, rigaMod);

            this._gruppoAltri.visible = st.altri.length > 0;
            for (const a of st.altri) {
                const r = new Adw.ActionRow({
                    title: a.programma,
                    subtitle: `${a.eventi.length} eventi · ${a.percorso}`,
                });
                r.set_subtitle_lines(2);
                r.add_prefix(this._tessera('system-run-symbolic', 'grigio'));
                r.add_suffix(this._bottone('Rimuovi', 'destructive-action', () => this._conferma(
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
                r.add_prefix(this._tessera('document-save-symbolic', 'grigio'));
                r.add_suffix(this._bottone('Ripristina', null, () => this._conferma(
                    'Ripristinare questo backup?',
                    'settings.json torna com’era in quel momento, hook e ' +
                    'impostazioni compresi. Prima si fa un backup di quello attuale.',
                    'Ripristina', () => this._azioneHook(['ripristina', f]))));
                // Va nel cestino, non cancellato: è la regola della casa, e
                // vale anche per un file che abbiamo scritto noi.
                r.add_suffix(this._bottone('Elimina', 'destructive-action',
                    () => this._conferma(
                        'Eliminare questo backup?',
                        'Finisce nel cestino, da dove si può ancora recuperare. ' +
                        'Gli altri backup restano.',
                        'Elimina', () => this._azioneHook(['elimina', f]))));
                aggiungi(this._gruppoBackup, r);
            }
            if (st.backup.length > 1) {
                const tutti = new Adw.ActionRow({
                    title: 'Elimina tutti i backup',
                    subtitle: `${st.backup.length} file · vanno nel cestino`,
                });
                tutti.add_prefix(this._tessera('user-trash-symbolic', 'rosso'));
                tutti.add_suffix(this._bottone('Elimina tutti', 'destructive-action',
                    () => this._conferma(
                        'Eliminare tutti i backup?',
                        'Vanno nel cestino, da dove si possono ancora recuperare. ' +
                        'Senza backup, un ripristino non è più possibile finché ' +
                        'non se ne fa un altro — e se ne fa uno a ogni modifica.',
                        'Elimina tutti', () => this._azioneHook(['elimina', '--tutti']))));
                aggiungi(this._gruppoBackup, tutti);
            }
        });
    }

    /* ----------------------------------------------- quota e aggiornamento --- */

    _paginaQuota(s) {
        // speedometer c'è solo in Breeze (KDE): questa c'è dappertutto.
        const pagina = new Adw.PreferencesPage({title: 'Quota',
                                                icon_name: 'battery-level-50-symbolic'});

        const quota = this._gruppo(pagina, 'Quota di Claude',
                                   'Letta con /usage: non consuma token.', 'quota');
        this._interruttore(quota, s, 'usage-enabled', 'Leggi la quota',
                           'Spenta, le barre della quota restano vuote', 'fw-week', 'viola');
        this._numero(quota, s, 'usage-interval-seconds', 'Ogni quanti secondi',
                     'Minimo 5 minuti: costa un giro di rete', [300, 86400, 60, 600],
                     'view-refresh-symbolic', 'viola');
        this._scorciatoie(quota, s, 'usage-interval-seconds',
                          [['5 min', 300], ['15 min', 900], ['30 min', 1800],
                           ['1 ora', 3600], ['3 ore', 10800]]);

        const dati = this._gruppo(pagina, 'Disco, spazio e progetti',
                                  'Ogni giro aggiunge un punto alla linea di tendenza.',
                                  'aggiornamento');
        this._numero(dati, s, 'refresh-seconds', 'Ogni quanti secondi',
                     'Dieci minuti è un buon compromesso', [30, 7200, 30, 300],
                     'view-refresh-symbolic', 'verde');
        this._scorciatoie(dati, s, 'refresh-seconds',
                          [['1 min', 60], ['5 min', 300], ['10 min', 600],
                           ['30 min', 1800], ['1 ora', 3600]]);

        return pagina;
    }

    /* -------------------------------------------------------- progetti --- */

    _paginaProgetti(s) {
        const pagina = new Adw.PreferencesPage({title: 'Progetti', icon_name: 'folder-symbolic'});

        const radice = this._gruppo(pagina, 'Dove nascono i nuovi progetti',
                                    'Il «+» del popup crea la cartella qui.', 'progetti');
        const campo = new Adw.EntryRow({title: 'Cartella (vuota: automatica)',
                                        show_apply_button: true});
        campo.add_prefix(this._tessera('folder-symbolic', 'blu'));
        s.bind('projects-root', campo, 'text', Gio.SettingsBindFlags.DEFAULT);
        radice.add(campo);

        // Il percorso si mostra, non si scrive nei testi: cambia da macchina a
        // macchina, e una guida che ne cita uno fisso è sbagliata altrove.
        const inUso = new Adw.ActionRow({title: 'In uso adesso'});
        inUso.add_prefix(this._tessera('object-select-symbolic', 'blu'));
        const aggiornaInUso = () => {
            const scelta = s.get_string('projects-root').trim();
            inUso.subtitle = scelta
                ? this._abbrevia(this._espandi(scelta))
                : `${this._abbrevia(this._radiceRilevata())} — rilevata in automatico`;
        };
        aggiornaInUso();
        this._segnali.push(s.connect('changed::projects-root', aggiornaInUso));
        radice.add(inUso);
        this._interruttore(radice, s, 'new-project-readme', 'Crea un README.md',
                           'Nome, data, percorso e come riprendere', 'document-new-symbolic',
                           'blu');

        const riprendi = this._gruppo(pagina, 'Il pulsante «Riprendi»',
                                      'Apre il terminale ed esegue claude --resume.', 'progetti');
        const shell = new Adw.EntryRow({title: 'Shell (vuota: automatica)',
                                        show_apply_button: true});
        shell.add_prefix(this._tessera('utilities-terminal-symbolic', 'blu'));
        s.bind('shell', shell, 'text', Gio.SettingsBindFlags.DEFAULT);
        riprendi.add(shell);
        const rilevata = new Adw.ActionRow({title: 'Rilevata adesso',
                                            subtitle: this._shellRilevata()});
        rilevata.add_prefix(this._tessera('object-select-symbolic', 'blu'));
        riprendi.add(rilevata);
        const comando = new Adw.EntryRow({title: 'Comando personalizzato (%d = cartella)',
                                          show_apply_button: true});
        comando.add_prefix(this._tessera('system-run-symbolic', 'grigio'));
        s.bind('terminal-command', comando, 'text', Gio.SettingsBindFlags.DEFAULT);
        riprendi.add(comando);

        const sicurezza = this._gruppo(pagina, 'Sicurezza',
                                       'La cartella di lavoro non viene mai toccata.', 'progetti');
        this._interruttore(sicurezza, s, 'confirm-delete', 'Mostra l’elenco prima di eliminare',
                           'Spento, «Elimina dati» agisce al primo clic', 'security-high-symbolic',
                           'rosso');

        return pagina;
    }

    /* -------------------------------------------------------- utilità --- */

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
