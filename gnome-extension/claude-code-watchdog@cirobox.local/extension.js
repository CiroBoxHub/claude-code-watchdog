/* claude-code-watchdog — indicatore di pannello per GNOME Shell.
 *
 * Non calcola niente: legge il JSON prodotto da
 * claude-code-watchdog/bin/collect-metrics.py e lo disegna. Tutta la logica di
 * misura sta negli script del progetto, così si corregge senza toccare la shell.
 *
 * NIENTE COSTANTI CONFIGURABILI IN QUESTO FILE. GNOME Shell tiene in cache il
 * modulo ES già importato: `gnome-extensions disable/enable` NON rilegge il
 * sorgente, quindi una costante qui si cambierebbe solo con logout e login.
 * Ciò che si regola sta in GSettings (schemas/) e viene riletto a runtime.
 */

import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';

import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const DATA_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'claude-code-watchdog']);
const METRICS = GLib.build_filenamev([DATA_DIR, 'metrics.json']);
const HISTORY = GLib.build_filenamev([DATA_DIR, 'history.jsonl']);
const USAGE = GLib.build_filenamev([DATA_DIR, 'usage.json']);

/* Palette. Cairo vuole componenti 0-1; gli stessi valori sono nel CSS per le
   parti non disegnate a mano (St non conosce var(), vanno tenuti allineati). */
/* Tinte verificate sopra 3:1 di contrasto su tutti e quattro i fondi che
   contano: popup chiaro e scuro, barra chiara e scura. Si usano solo per i
   grafici; per il testo si veda la regola in cima a stylesheet.css. */
const TINTE = {
    sano:       [0.18, 0.57, 0.52],   // #2F9284
    quota:      [0.53, 0.46, 0.72],   // #8676B8
    attenzione: [0.72, 0.48, 0.10],   // #B77B1A
    critico:    [0.81, 0.35, 0.31],   // #CE5A50
};
/* Ripieghi, usati solo finché metrics.json non è stato letto. Le soglie vere
   arrivano da config/watchdog.conf attraverso il JSON: sono le stesse a cui gli
   scan suonano l'allarme, e stanno in un posto solo. */
const SOGLIA_ATTENZIONE = 0.75;
const SOGLIA_CRITICO = 0.90;

/* Icone proprie invece di quelle generiche del tema: stessa griglia 16x16,
   stesso spessore, così in barra leggono come una famiglia sola. */
const ICONE = {
    principale:         'fw-gauge',
    disco:              'fw-disk',
    claude:             'fw-data',
    sessioni:           'fw-chat',
    messaggi:           'fw-pulse',
    recuperabile:       'fw-reclaim',
    'quota-sessione':   'fw-session',
    'quota-settimana':  'fw-week',
};

/* Per ogni terminale il suo file .desktop: serve a sapere se ha già una
   finestra aperta. Senza questo controllo `--tab` fa partire l'applicazione,
   che apre la sua finestra con il tab predefinito, e poi aggiunge il tab
   richiesto: due schede, una vuota. */
const TERMINALI = [
    {cmd: 'ptyxis',         desktop: 'org.gnome.Ptyxis.desktop'},
    {cmd: 'kgx',            desktop: 'org.gnome.Console.desktop'},
    {cmd: 'gnome-terminal', desktop: 'org.gnome.Terminal.desktop'},
];

/* Se un sottoprocesso non tornasse mai, il lucchetto che evita le
   sovrapposizioni resterebbe chiuso e non si aggiornerebbe più niente fino al
   riavvio della shell. Oltre questo tempo si considera perso e si riapre. */
const LUCCHETTO_MS = 120000;

const TOOLTIP_MS = 450;       // attesa prima che il suggerimento compaia
const MAX_CAMPIONI = 60;      // quanti punti disegna il grafico
const ESITO_MS = 6000;        // per quanto resta a video l'esito di un'azione

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(bytes) : null;
    } catch {
        return null;
    }
}

function fmtMb(mb, compatto = false) {
    if (mb === null || mb === undefined)
        return '—';
    if (mb >= 1024)
        return compatto ? `${(mb / 1024).toFixed(1)}G` : `${(mb / 1024).toFixed(1)} GB`;
    return compatto ? `${Math.round(mb)}M` : `${Math.round(mb)} MB`;
}

function fmtNum(n) {
    if (n === null || n === undefined)
        return '—';
    if (n >= 10000)
        return `${(n / 1000).toFixed(1)}k`;
    return `${n}`;
}

/* Da quanto tempo risale un dato.
   Niente zona morta: con un aggiornamento ogni minuto, una soglia di 90
   secondi farebbe leggere sempre «adesso» e l'etichetta non direbbe nulla. */
function fmtAge(iso) {
    if (!iso)
        return 'mai';
    const secs = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
    if (secs < 5)
        return 'adesso';
    if (secs < 60)
        return `${Math.round(secs)} s fa`;
    if (secs < 3600) {
        const min = Math.floor(secs / 60);
        return `${min} min fa`;
    }
    if (secs < 86400)
        return `${Math.floor(secs / 3600)} h fa`;
    const g = Math.floor(secs / 86400);
    return `${g} ${g === 1 ? 'giorno' : 'giorni'} fa`;
}

/* Quando si azzera un limite, con l'ora esatta e non solo il relativo.
   «fra 5 ore» lascia il dubbio che sia una quota giornaliera; «alle 13:59»
   toglie l'ambiguità. Si usa GLib.DateTime per rispettare il fuso e la lingua
   di sistema senza dipendere da Intl. */
function fmtAzzeramento(iso) {
    if (!iso)
        return '';
    const quando = GLib.DateTime.new_from_iso8601(iso, null)?.to_local();
    if (!quando)
        return '';
    const adesso = GLib.DateTime.new_now_local();
    const secondi = quando.difference(adesso) / 1000000;   // µs → s
    if (secondi <= 0)
        return 'azzerata';

    const ore = secondi / 3600;
    if (ore < 1)
        return `azzera alle ${quando.format('%H:%M')}, fra ${Math.max(1, Math.round(secondi / 60))} min`;
    if (quando.get_day_of_year() === adesso.get_day_of_year() &&
        quando.get_year() === adesso.get_year())
        return `azzera oggi alle ${quando.format('%H:%M')}, fra ${Math.round(ore)} h`;
    // Il confronto è sui giorni di calendario: a 26 ore di distanza può essere
    // dopodomani, e scrivere «domani» sarebbe falso.
    const domani = adesso.add_days(1);
    if (quando.get_day_of_year() === domani.get_day_of_year() &&
        quando.get_year() === domani.get_year())
        return `azzera domani alle ${quando.format('%H:%M')}`;
    const giorni = Math.round(ore / 24);
    return `azzera ${quando.format('%A alle %H:%M')}, fra ${giorni} giorni`;
}

function taglia(testo, n) {
    if (!testo)
        return '';
    return testo.length > n ? `${testo.slice(0, n - 1)}…` : testo;
}

/* ------------------------------------------------------------- grafico --- */

const Sparkline = GObject.registerClass(
class Sparkline extends St.DrawingArea {
    _init({height = 64, style_class = 'fw-trend'} = {}) {
        super._init({style_class, height, x_expand: true});
        this._punti = [];
        this.connect('repaint', () => this._disegna());
    }

    setPunti(punti) {
        this._punti = punti ?? [];
        this.queue_repaint();
    }

    _disegna() {
        const ctx = this.get_context();
        const [w, h] = this.get_surface_size();
        const pad = 3;

        if (this._punti.length < 2) {
            ctx.$dispose();
            return;
        }

        const max = Math.max(...this._punti);
        const min = Math.min(...this._punti);
        // Serie piatta: il range sarebbe 0 e la divisione esploderebbe.
        const range = Math.max(1e-6, max - min);
        const n = this._punti.length;
        const x = i => pad + (i * (w - 2 * pad)) / (n - 1);
        const y = v => h - pad - ((v - min) / range) * (h - 2 * pad);

        ctx.moveTo(x(0), h);
        for (let i = 0; i < n; i++)
            ctx.lineTo(x(i), y(this._punti[i]));
        ctx.lineTo(x(n - 1), h);
        ctx.closePath();
        ctx.setSourceRGBA(TINTE.sano[0], TINTE.sano[1], TINTE.sano[2], 0.22);
        ctx.fill();

        ctx.setLineWidth(1.5);
        ctx.setSourceRGBA(TINTE.sano[0], TINTE.sano[1], TINTE.sano[2], 0.95);
        ctx.moveTo(x(0), y(this._punti[0]));
        for (let i = 1; i < n; i++)
            ctx.lineTo(x(i), y(this._punti[i]));
        ctx.stroke();

        // Un punto sull'ultimo campione: dice dove siamo adesso.
        ctx.setSourceRGBA(TINTE.sano[0], TINTE.sano[1], TINTE.sano[2], 1);
        ctx.arc(x(n - 1), y(this._punti[n - 1]), 2, 0, 2 * Math.PI);
        ctx.fill();

        ctx.$dispose();
    }
});

/* ----------------------------------------------------------- misuratore --- */

/* Disegnato in Cairo e non con widget CSS: con St.Widget dentro un BinLayout
   il riempimento finiva centrato e la tinta non si applicava. Qui il controllo
   è esatto, e si possono mettere i riferimenti di scala. */
const Misuratore = GObject.registerClass(
class Misuratore extends St.DrawingArea {
    _init(tintaBase) {
        super._init({style_class: 'fw-meter', height: 14, x_expand: true});
        this._tintaBase = tintaBase ?? TINTE.sano;
        this._frazione = 0;
        this._attenzione = SOGLIA_ATTENZIONE;
        this._critico = SOGLIA_CRITICO;
        this.connect('repaint', () => this._disegna());
    }

    setFrazione(f) {
        this._frazione = Math.max(0, Math.min(1, f ?? 0));
        this.queue_repaint();
    }

    setSoglie(attenzione, critico) {
        this._attenzione = attenzione;
        this._critico = critico;
        this.queue_repaint();
    }

    /* La tinta segue il valore: oltre le soglie il colore proprio della misura
       cede il passo ad ambra e mattone, uguali in tutto il popup. */
    _tinta() {
        if (this._frazione >= this._critico)
            return TINTE.critico;
        if (this._frazione >= this._attenzione)
            return TINTE.attenzione;
        return this._tintaBase;
    }

    _disegna() {
        const ctx = this.get_context();
        const [w, h] = this.get_surface_size();
        const y = Math.round(h / 2) - 2;
        const alt = 4;
        const r = 2;

        // binario
        ctx.setSourceRGBA(0.5, 0.5, 0.5, 0.22);
        ctx.rectangle(0, y, w, alt);
        ctx.fill();

        // Le tacche stanno sulle due soglie, non a quarti fissi: così dicono
        // "da qui diventa ambra" e "da qui rosso", invece di decorare.
        ctx.setSourceRGBA(0.5, 0.5, 0.5, 0.5);
        for (const q of [this._attenzione, this._critico]) {
            ctx.rectangle(Math.round(w * q), y - 3, 1, alt + 6);
        }
        ctx.fill();

        // riempimento, da sinistra
        const larghezza = Math.round(w * this._frazione);
        if (larghezza > 0) {
            const [cr, cg, cb] = this._tinta();
            ctx.setSourceRGBA(cr, cg, cb, 1);
            ctx.rectangle(0, y, Math.max(larghezza, r * 2), alt);
            ctx.fill();
        }

        ctx.$dispose();
    }
});

/* --------------------------------------------------------- riga misura --- */

/* Una misura è una riga, non una scheda: etichetta a sinistra, cifra grande a
   destra, e sotto la forma che dice CHE TIPO di misura è.
     limitata (percentuale) → barra riempita
     illimitata (megabyte)  → linea di tendenza
   Una barra su una grandezza senza massimo sarebbe una bugia grafica. */
const Misura = GObject.registerClass(
class Misura extends St.BoxLayout {
    _init(titolo, {forma = 'barra', tinta = null} = {}) {
        super._init({orientation: Clutter.Orientation.VERTICAL,
                     style_class: 'fw-metric', x_expand: true});

        const riga = new St.BoxLayout({x_expand: true});
        riga.add_child(new St.Label({text: titolo, style_class: 'fw-metric-label',
                                     x_expand: true,
                                     y_align: Clutter.ActorAlign.CENTER}));
        this._valore = new St.Label({text: '—', style_class: 'fw-metric-value'});
        riga.add_child(this._valore);
        this.add_child(riga);

        if (forma === 'barra') {
            this._misuratore = new Misuratore(tinta);
            this.add_child(this._misuratore);
        } else if (forma === 'tendenza') {
            this._tendenza = new Sparkline({height: 26});
            this.add_child(this._tendenza);
        }

        this._nota = new St.Label({text: '', style_class: 'fw-metric-note'});
        this._nota.clutter_text.line_wrap = true;
        this.add_child(this._nota);
    }

    aggiorna(valore, frazione, nota) {
        this._valore.set_text(valore);
        this._nota.set_text(nota ?? '');
        this._misuratore?.setFrazione(frazione);
    }

    setPunti(punti) {
        this._tendenza?.setPunti(punti);
    }

    setSoglie(attenzione, critico) {
        this._misuratore?.setSoglie(attenzione, critico);
    }
});

/* -------------------------------------------------- riga di selezione --- */

const RigaScelta = GObject.registerClass(
class RigaScelta extends St.Button {
    _init(voce) {
        super._init({style_class: 'fw-pick', x_expand: true, can_focus: true});
        this.voce = voce;
        this.scelto = true;

        const riga = new St.BoxLayout({x_expand: true});
        this._segno = new St.Icon({icon_name: 'object-select-symbolic', icon_size: 14,
                                   style_class: 'fw-pick-check'});
        riga.add_child(this._segno);
        riga.add_child(new St.Label({text: voce.nome, style_class: 'fw-pick-name',
                                     x_expand: true}));
        riga.add_child(new St.Label({text: voce.dettaglio ?? '',
                                     style_class: 'fw-pick-detail'}));
        this.set_child(riga);

        this.connect('clicked', () => {
            this.scelto = !this.scelto;
            this._segno.opacity = this.scelto ? 255 : 55;
            this.opacity = this.scelto ? 255 : 150;
        });
    }
});

/* --------------------------------------------------------- suggerimento --- */

/* GNOME Shell non ha tooltip pronti: va costruito. Uno solo per tutta
   l'estensione, riposizionato di volta in volta — crearne uno per riga
   lascerebbe in giro attori da liberare. */
const Suggerimento = GObject.registerClass(
class Suggerimento extends St.Label {
    _init() {
        super._init({style_class: 'fw-tooltip', visible: false});
        this.clutter_text.line_wrap = true;
        this.clutter_text.ellipsize = 0;     // niente troncamento: si legge tutto
        // addTopChrome su GNOME 50 NON accetta parametri: passargli
        // {affectsInputRegion:false} solleva «Unrecognized parameter» e
        // l'estensione va in ERROR all'avvio. Verificato il 2026-09-17.
        // Non serve comunque: St.Label non è reattiva, quindi non intercetta
        // i clic della riga che ci sta sotto.
        this.reactive = false;
        Main.layoutManager.addTopChrome(this);
        this._timeout = 0;
    }

    programma(attore, testo, colonna) {
        this.annulla();
        this._timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TOOLTIP_MS, () => {
            this._timeout = 0;
            this._mostra(attore, testo, colonna);
            return GLib.SOURCE_REMOVE;
        });
    }

    annulla() {
        if (this._timeout) {
            GLib.source_remove(this._timeout);
            this._timeout = 0;
        }
        this.hide();
    }

    _mostra(attore, testo, colonna) {
        if (!attore.get_stage())
            return;                          // riga già distrutta nel frattempo
        this.set_text(testo);
        this.show();

        // Il menu del pannello viene alzato in cima alla chrome quando si
        // apre, e finirebbe sopra al suggerimento coprendolo. Va rialzato a
        // ogni comparsa, non una volta sola alla costruzione.
        const genitore = this.get_parent();
        if (genitore)
            genitore.set_child_above_sibling(this, null);

        const monitor = Main.layoutManager.primaryMonitor;
        const [ax, ay] = attore.get_transformed_position();
        const [, ah] = attore.get_transformed_size();

        // Di fianco alla colonna del menu, non sotto la riga: comparire dentro
        // la colonna coprirebbe le voci sottostanti anche stando davanti.
        let cx = ax, cw = 0;
        if (colonna && colonna.get_stage()) {
            [cx] = colonna.get_transformed_position();
            [cw] = colonna.get_transformed_size();
        }

        const margine = 8;
        const spazioDestra = monitor.x + monitor.width - (cx + cw) - margine * 2;
        const spazioSinistra = cx - monitor.x - margine * 2;
        const massimo = Math.max(240, Math.min(420, Math.max(spazioDestra, spazioSinistra)));
        this.set_style(`max-width: ${Math.round(massimo)}px;`);

        const [, larghezza] = this.get_preferred_width(-1);
        const [, altezza] = this.get_preferred_height(larghezza);

        let x;
        if (larghezza + margine <= spazioDestra + margine)
            x = cx + cw + margine;                       // a destra della colonna
        else if (larghezza + margine <= spazioSinistra + margine)
            x = cx - larghezza - margine;                // a sinistra
        else
            x = Math.round(cx + cw / 2 - larghezza / 2); // non ci sta: si centra

        // Allineato alla riga che l'ha chiesto, non al menu: così si capisce
        // a cosa si riferisce.
        let y = Math.round(ay + ah / 2 - altezza / 2);
        x = Math.max(monitor.x + margine,
                     Math.min(x, monitor.x + monitor.width - larghezza - margine));
        y = Math.max(monitor.y + margine,
                     Math.min(y, monitor.y + monitor.height - altezza - margine));
        this.set_position(x, y);
    }

    destroy() {
        this.annulla();
        super.destroy();
    }
});

/* ------------------------------------------------------ riga progetto --- */

/* Barra sottile proporzionale al progetto più pesante: si vede chi occupa
   senza leggere i numeri. Disegnata, per lo stesso motivo del misuratore. */
const BarraProgetto = GObject.registerClass(
class BarraProgetto extends St.DrawingArea {
    _init(frazione) {
        super._init({style_class: 'fw-proj-bar', height: 3, x_expand: true});
        this._frazione = Math.max(0, Math.min(1, frazione ?? 0));
        this.connect('repaint', () => {
            const ctx = this.get_context();
            const [w, h] = this.get_surface_size();
            ctx.setSourceRGBA(0.5, 0.5, 0.5, 0.16);
            ctx.rectangle(0, 0, w, 2);
            ctx.fill();
            ctx.setSourceRGBA(TINTE.sano[0], TINTE.sano[1], TINTE.sano[2], 0.65);
            ctx.rectangle(0, 0, Math.round(w * this._frazione), 2);
            ctx.fill();
            ctx.$dispose();
        });
    }
});

/* Un progetto si apre su tre azioni. La barra sotto il nome è proporzionale al
   peso del più grosso: si vede chi occupa senza leggere i numeri. */
const RigaProgetto = GObject.registerClass(
class RigaProgetto extends St.BoxLayout {
    _init(progetto, mbMassimo, delegato, {vero = true} = {}) {
        super._init({orientation: Clutter.Orientation.VERTICAL,
                     style_class: 'fw-proj', x_expand: true});
        this.progetto = progetto;
        this.vero = vero;

        const testa = new St.Button({style_class: 'fw-proj-head', x_expand: true,
                                     can_focus: true});
        const riga = new St.BoxLayout({x_expand: true});
        this._freccia = new St.Icon({icon_name: 'pan-end-symbolic', icon_size: 12,
                                     style_class: 'fw-proj-arrow'});
        riga.add_child(this._freccia);

        const testi = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
                                        x_expand: true});
        const problemi = progetto.problemi ?? [];
        if (problemi.length) {
            // Il colore sta sull'icona, che è un grafico: un nome scritto in
            // ambra su fondo chiaro starebbe a 2,9:1 e non si leggerebbe.
            this._allarme = new St.Icon({
                gicon: Gio.icon_new_for_string(
                    GLib.build_filenamev([delegato.percorsoEstensione,
                                          'icons', 'fw-warn-symbolic.svg'])),
                style_class: 'fw-proj-warn',
            });
            riga.add_child(this._allarme);
            testa.add_style_class_name('fw-proj-problema');
        }

        const nome = new St.Label({text: taglia(progetto.nome, problemi.length ? 27 : 30),
                                   style_class: 'fw-proj-name'});
        testi.add_child(nome);
        const plurale = progetto.sessioni === 1 ? 'sessione' : 'sessioni';
        const riassunti = {
            'cartella-sparita': 'cartella di lavoro sparita',
            'in-tmp': 'lavora sotto /tmp, che si svuota al riavvio',
            'cartella-condivisa': 'trascrizioni in una cartella condivisa',
            'cwd-ignota': 'cartella di lavoro non identificata',
        };
        const primo = problemi.length ? riassunti[problemi[0].codice] : null;
        const conteggio = `${progetto.sessioni} ${plurale} · ${progetto.messaggi} messaggi`;
        testi.add_child(new St.Label({
            text: primo ?? (vero ? conteggio : `${progetto.percorso} · ${conteggio}`),
            style_class: 'fw-proj-meta'}));
        riga.add_child(testi);

        if (problemi.length) {
            // Sull'intera testa della riga, non solo sull'icona: centrare il
            // mouse su 14 pixel è una piccola tortura.
            const testo = problemi.map(x => `• ${x.testo}`).join('\n\n');
            testa.connect('notify::hover', () => {
                if (testa.hover)
                    delegato.suggerimento?.programma(this._allarme ?? testa, testo,
                                                     delegato.attoreMenu);
                else
                    delegato.suggerimento?.annulla();
            });
            testa.connect('destroy', () => delegato.suggerimento?.annulla());
        }

        riga.add_child(new St.Label({text: fmtMb(progetto.mb),
                                     style_class: 'fw-proj-size',
                                     y_align: Clutter.ActorAlign.CENTER}));
        testa.set_child(riga);
        testa.connect('clicked', () => this.alterna());
        this.add_child(testa);

        this._barra = new BarraProgetto(mbMassimo > 0 ? progetto.mb / mbMassimo : 0);
        this.add_child(this._barra);

        this._azioni = new St.BoxLayout({style_class: 'fw-proj-actions',
                                         x_expand: true, visible: false});
        // Colorati solo quando si possono premere: se la cartella non c'è più
        // restano grigi, così «colorato» vuol dire «funziona».
        const attivo = progetto.esiste;

        const cartella = new St.Button({
            label: 'Cartella', x_expand: true, can_focus: true,
            style_class: attivo ? 'fw-btn-mini fw-btn-cartella' : 'fw-btn-mini fw-btn-spento'});
        cartella.connect('clicked', () => delegato.apriCartella(progetto));
        cartella.reactive = attivo;
        this._azioni.add_child(cartella);

        const riprendi = new St.Button({
            label: 'Riprendi', x_expand: true, can_focus: true,
            style_class: attivo ? 'fw-btn-mini fw-btn-riprendi' : 'fw-btn-mini fw-btn-spento'});
        riprendi.connect('clicked', () => delegato.riprendi(progetto));
        riprendi.reactive = attivo;
        this._azioni.add_child(riprendi);

        // Su una cartella che non è un progetto «dati del progetto» sarebbe
        // fuorviante: lì c'è solo qualche sessione capitata per caso.
        // Se la cartella è stata spostata si può riagganciare invece di
        // buttare via le conversazioni: il pulsante viene prima di «Elimina».
        if (problemi.some(x => x.codice === 'cartella-sparita')) {
            const correggi = new St.Button({label: 'Correggi',
                                            style_class: 'fw-btn-mini fw-btn-correggi',
                                            x_expand: true, can_focus: true});
            correggi.connect('clicked', () => delegato.chiediCorreggi(progetto, this));
            this._azioni.add_child(correggi);
        }

        const elimina = new St.Button({label: vero ? 'Elimina dati' : 'Elimina sessioni',
                                       style_class: 'fw-btn-mini fw-btn-danger',
                                       x_expand: true, can_focus: true});
        elimina.connect('clicked', () => delegato.chiediElimina(progetto, this));
        this._azioni.add_child(elimina);
        this.add_child(this._azioni);

        this._conferma = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
                                           style_class: 'fw-confirm fw-confirm-nested',
                                           x_expand: true, visible: false});
        this.add_child(this._conferma);
    }

    alterna(forza) {
        const aperto = forza ?? !this._azioni.visible;
        this._azioni.visible = aperto;
        this._freccia.icon_name = aperto ? 'pan-down-symbolic' : 'pan-end-symbolic';
        if (!aperto)
            this.chiudiConferma();
    }

    chiudiConferma() {
        this._conferma.hide();
        this._conferma.destroy_all_children();
        // La stessa area serve sia alla conferma di rimozione sia alla
        // correzione, che hanno bordi di colore diverso: si rimette quello
        // predefinito.
        this._conferma.remove_style_class_name('fw-fix');
        this._conferma.add_style_class_name('fw-confirm');
    }

    get areaConferma() {
        return this._conferma;
    }
});

/* ------------------------------------------------------------ pannello --- */

const Indicatore = GObject.registerClass(
class Indicatore extends PanelMenu.Button {
    _init(estensione) {
        super._init(0.5, 'Fedora Watchdog');
        this._ext = estensione;
        this._settings = estensione.getSettings();
        this._timeout = 0;
        this._timeoutEsito = 0;
        this._timeoutQuota = 0;
        this._orologio = 0;
        this._righeProgetto = [];
        this._righeAltre = [];
        this._morto = false;
        // Il suggerimento è un accessorio: se la sua costruzione fallisce —
        // per esempio perché un'API della shell è cambiata — deve mancare solo
        // lui, non far cadere l'intera estensione in ERROR come è successo il
        // 2026-09-17 con un parametro di addTopChrome non più accettato.
        try {
            this.suggerimento = new Suggerimento();
        } catch (e) {
            this.suggerimento = null;
            logError(e, 'claude-code-watchdog: suggerimento non disponibile');
        }

        this._box = new St.BoxLayout({style_class: 'fw-panel-box'});
        this.add_child(this._box);

        this._costruisciMenu();
        this._costruisciPannello();
        this._leggi();
        this._riprogramma();
        this._riprogrammaQuota();

        this._idSettings = this._settings.connect('changed', (_s, chiave) => {
            if (chiave === 'refresh-seconds')
                this._riprogramma();
            if (chiave === 'usage-interval-seconds' || chiave === 'usage-enabled')
                this._riprogrammaQuota();
            this._costruisciPannello();
            this._leggi();
        });

        this.menu.connect('open-state-changed', (_m, aperto) => {
            if (aperto) {
                this._adattaAltezza();
                this._leggi();
                this._avviaOrologio();
                // Le barre ora sono disegnate: St le ridisegna da sé quando
                // ottengono un'allocazione, senza misurazioni a mano.
            } else {
                this._fermaOrologio();
                this._chiudiNuovo();
                this._chiudiPulizia();
                this.suggerimento?.annulla();
                for (const r of [...this._righeProgetto, ...(this._righeAltre ?? [])])
                    r.alterna(false);
            }
        });
    }

    /* Le righe progetto ne hanno bisogno per caricarsi l'icona di allarme. */
    get percorsoEstensione() {
        return this._ext.path;
    }

    /* Serve al suggerimento per sapere dove finisce la colonna del menu e
       mettersi di fianco invece che sopra. */
    get attoreMenu() {
        return this.menu?.actor ?? null;
    }

    /* --------------------------------------------------------- pannello --- */

    /* Il suffisso -symbolic nel nome file fa sì che la shell le ricolori con
       il colore del testo; il grigio nel file è solo un ripiego leggibile. */
    _icona(nome, classe = 'system-status-icon') {
        const percorso = GLib.build_filenamev([this._ext.path, 'icons', `${nome}-symbolic.svg`]);
        return new St.Icon({
            gicon: Gio.icon_new_for_string(percorso),
            style_class: classe,
        });
    }

    _costruisciPannello() {
        this._box.destroy_all_children();
        const perIndicatore = this._settings.get_boolean('panel-icons');
        if (this._settings.get_boolean('panel-show-icon'))
            this._box.add_child(this._icona(ICONE.principale));

        this._etichettePannello = new Map();
        for (const chiave of this._settings.get_strv('panel-indicators')) {
            if (perIndicatore && ICONE[chiave]) {
                const gruppo = new St.BoxLayout({style_class: 'fw-panel-group'});
                gruppo.add_child(this._icona(ICONE[chiave], 'fw-panel-icon'));
                const l = new St.Label({text: '—', y_align: Clutter.ActorAlign.CENTER,
                                        style_class: 'fw-panel-label'});
                this._etichettePannello.set(chiave, l);
                gruppo.add_child(l);
                this._box.add_child(gruppo);
            } else {
                const l = new St.Label({text: '—', y_align: Clutter.ActorAlign.CENTER,
                                        style_class: 'fw-panel-label'});
                this._etichettePannello.set(chiave, l);
                this._box.add_child(l);
            }
        }
        // Senza icona né indicatori il pulsante sarebbe invisibile e non
        // cliccabile: si tiene almeno l'icona.
        if (this._box.get_n_children() === 0)
            this._box.add_child(this._icona(ICONE.principale));
    }

    /* Un account può avere più limiti settimanali (weekly_all, weekly_opus):
       si prende il più alto, che è quello che vincola davvero. */
    _pctQuota(d, gruppo) {
        const pct = (d.quota?.limiti ?? [])
            .filter(x => x.gruppo === gruppo)
            .map(x => x.percento)
            .filter(v => v !== null && v !== undefined);
        return pct.length ? Math.max(...pct) : null;
    }

    _aggiornaPannello(d) {
        const compatto = this._settings.get_boolean('panel-compact');
        // Con l'icona accanto, la sigla «S»/«W» ripete un'informazione che
        // l'icona già dà: si toglie.
        const senzaSigle = compatto || this._settings.get_boolean('panel-icons');
        const disco = d.disco ?? {};
        const claude = d.claude ?? {};
        const rec = d.recuperabile ?? {};
        const qs = this._pctQuota(d, 'session');
        const qw = this._pctQuota(d, 'weekly');

        // Valore, e quanto vale in percentuale per decidere se tingerlo.
        const valori = {
            disco: [`${disco.pct ?? '?'}%`, disco.pct],
            claude: [fmtMb(claude.conversazioniMb ?? claude.totaleMb, compatto), null],
            sessioni: [senzaSigle ? `${claude.conversazioni ?? 0}`
                                  : `${claude.conversazioni ?? 0} sess`, null],
            messaggi: [fmtNum(claude.messaggi), null],
            recuperabile: [fmtMb(rec.totaleMb, compatto), null],
            'quota-sessione': [qs === null ? '—' : (senzaSigle ? `${qs}%` : `S ${qs}%`), qs],
            'quota-settimana': [qw === null ? '—' : (senzaSigle ? `${qw}%` : `W ${qw}%`), qw],
        };

        for (const [chiave, label] of this._etichettePannello ?? []) {
            const [testo, pct] = valori[chiave] ?? ['—', null];
            label.set_text(testo);
            let classe = 'fw-panel-label';
            if (pct !== null && pct !== undefined) {
                if (pct >= (this._critico ?? SOGLIA_CRITICO) * 100)
                    classe += ' fw-panel-crit';
                else if (pct >= (this._attenzione ?? SOGLIA_ATTENZIONE) * 100)
                    classe += ' fw-panel-warn';
            }
            label.style_class = classe;
        }
    }

    /* ------------------------------------------------------------ menu --- */

    _filetto(contenitore) {
        contenitore.add_child(new St.Widget({style_class: 'fw-rule', x_expand: true}));
    }

    _costruisciMenu() {
        const sez = new PopupMenu.PopupMenuSection();
        const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
        const c = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
                                    style_class: 'fw-content', x_expand: true});

        const testa = new St.BoxLayout({style_class: 'fw-header', x_expand: true});
        testa.add_child(new St.Label({text: 'Fedora Watchdog',
                                      style_class: 'fw-header-title', x_expand: true,
                                      y_align: Clutter.ActorAlign.CENTER}));
        this._etichettaAggiornato = new St.Label({text: '—', style_class: 'fw-header-age',
                                                  y_align: Clutter.ActorAlign.CENTER});
        testa.add_child(this._etichettaAggiornato);
        const btnAgg = new St.Button({style_class: 'fw-icon-btn', can_focus: true,
                                      child: new St.Icon({icon_name: 'view-refresh-symbolic',
                                                          icon_size: 14})});
        btnAgg.connect('clicked', () => {
            this._raccogli();
            this._leggiQuota();
        });
        testa.add_child(btnAgg);
        c.add_child(testa);

        this._esito = new St.Label({text: '', style_class: 'fw-esito', visible: false});
        c.add_child(this._esito);

        this._rigaGuasto = new St.Label({text: '', style_class: 'fw-guasto',
                                         visible: false});
        this._rigaGuasto.clutter_text.line_wrap = true;
        c.add_child(this._rigaGuasto);

        // --- macchina ---
        this._mDisco = new Misura('Disco', {forma: 'barra'});
        this._mClaude = new Misura('Conversazioni', {forma: 'tendenza'});
        // Fondoscala la soglia d'allarme, non il disco: 2,4 GB di cache su un
        // disco da 1 TB sarebbero una barra vuota, e l'unica cosa che conta
        // qui e' se ha superato il limite che ci si e' dati.
        this._mCache = new Misura('Cache', {forma: 'barra'});
        c.add_child(this._mDisco);
        c.add_child(this._mClaude);
        c.add_child(this._mCache);

        // --- quota ---
        this._ruleQuota = new St.Widget({style_class: 'fw-rule', x_expand: true});
        c.add_child(this._ruleQuota);
        this._mSessione = new Misura('Sessione corrente',
                                     {forma: 'barra', tinta: TINTE.quota});
        this._mSettimana = new Misura('Settimana',
                                      {forma: 'barra', tinta: TINTE.quota});
        c.add_child(this._mSessione);
        c.add_child(this._mSettimana);

        // --- recuperabile ---
        this._filetto(c);
        this._mRec = new Misura('Recuperabile', {forma: 'nessuna'});
        c.add_child(this._mRec);
        this._btnLibera = new St.Button({label: 'Libera spazio', style_class: 'fw-btn',
                                         x_expand: true, can_focus: true});
        this._btnLibera.connect('clicked', () => this._apriPulizia());
        c.add_child(this._btnLibera);
        this._boxPulizia = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
                                             style_class: 'fw-confirm', x_expand: true,
                                             visible: false});
        c.add_child(this._boxPulizia);

        // --- progetti ---
        this._ruleProg = new St.Widget({style_class: 'fw-rule', x_expand: true});
        c.add_child(this._ruleProg);
        this._testaProgetti = new St.BoxLayout({x_expand: true, style_class: 'fw-section-row'});
        this._testaProgetti.add_child(new St.Label({text: 'Progetti',
                                                    style_class: 'fw-section',
                                                    x_expand: true,
                                                    y_align: Clutter.ActorAlign.CENTER}));
        const btnNuovo = new St.Button({style_class: 'fw-icon-btn', can_focus: true,
                                        child: new St.Icon({icon_name: 'list-add-symbolic',
                                                            icon_size: 14})});
        btnNuovo.connect('clicked', () => this._apriNuovo());
        this._testaProgetti.add_child(btnNuovo);
        c.add_child(this._testaProgetti);

        this._boxNuovo = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
                                           style_class: 'fw-nuovo', x_expand: true,
                                           visible: false});
        c.add_child(this._boxNuovo);
        this._boxProgetti = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
                                              style_class: 'fw-projects', x_expand: true});
        c.add_child(this._boxProgetti);

        this._ruleAltre = new St.Widget({style_class: 'fw-rule', x_expand: true});
        c.add_child(this._ruleAltre);
        this._titoloAltre = new St.Label({text: 'Fuori dai progetti',
                                          style_class: 'fw-section'});
        c.add_child(this._titoloAltre);
        this._notaAltre = new St.Label({
            text: 'Cartelle da cui hai lanciato Claude che non stanno nella '
                  + 'radice dei progetti. Si possono solo ripulire.',
            style_class: 'fw-empty'});
        this._notaAltre.clutter_text.line_wrap = true;
        c.add_child(this._notaAltre);
        this._boxAltre = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
                                           style_class: 'fw-projects', x_expand: true});
        c.add_child(this._boxAltre);

        this._boxAllarmi = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
                                             style_class: 'fw-alerts', x_expand: true});
        c.add_child(this._boxAllarmi);

        // Il contenuto cresce quando si aprono le righe, e oltre l'altezza
        // dello schermo il menu viene tagliato senza modo di arrivarci.
        // Dentro uno St.ScrollView si scorre.
        this._scorrimento = new St.ScrollView({
            style_class: 'fw-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            // Non in sovrapposizione: coprirebbero i numeri allineati a destra.
            // Occupando il proprio spazio, il contenuto si stringe e resta
            // leggibile.
            overlay_scrollbars: false,
            x_expand: true, y_expand: true,
            // La voce di menu che lo contiene è non-reattiva: senza questo la
            // rotella del mouse non arriverebbe qui.
            reactive: true,
        });
        // L'API è cambiata fra le versioni di GNOME: set_child() sulle recenti,
        // add_actor() sulle vecchie. Si prende quella che c'è.
        if (typeof this._scorrimento.set_child === 'function')
            this._scorrimento.set_child(c);
        else
            this._scorrimento.add_actor(c);

        item.add_child(this._scorrimento);
        sez.addMenuItem(item);
        this.menu.addMenuItem(sez);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const impo = new PopupMenu.PopupMenuItem('Impostazioni e guida');
        impo.connect('activate', () => this._ext.openPreferences());
        this.menu.addMenuItem(impo);
    }

    /* Il tetto d'altezza si calcola sul monitor invece di fissarlo nel CSS:
       su uno schermo basso un valore fisso taglierebbe comunque. */
    _adattaAltezza() {
        if (!this._scorrimento)
            return;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        this._scorrimento.set_style(
            `max-height: ${Math.round(monitor.height * 0.62)}px;`);
    }

    /* --------------------------------------------------------- lettura --- */

    _leggi() {
        const testo = readText(METRICS);
        if (!testo) {
            this._etichettaAggiornato.set_text('nessun dato');
            return;
        }
        let d;
        try {
            d = JSON.parse(testo);
        } catch (e) {
            logError(e, 'claude-code-watchdog: metrics.json illeggibile');
            return;
        }
        // La quota si legge dal suo file invece di aspettare che
        // collect-metrics la reimpacchetti: risparmia un processo e una
        // ricostruzione intera a ogni giro.
        const testoQuota = readText(USAGE);
        if (testoQuota) {
            try {
                const q = JSON.parse(testoQuota);
                const eta = Math.max(0, (Date.now() - Date.parse(q.letteIl)) / 1000);
                if (!d.quota || Date.parse(q.letteIl) >= Date.parse(d.quota.letteIl))
                    d.quota = {limiti: q.limiti, extra: q.extra,
                               letteIl: q.letteIl, etaSecondi: Math.round(eta)};
            } catch (e) {
                logError(e, 'claude-code-watchdog: usage.json illeggibile');
            }
        }

        this._dati = d;
        this._mostra(d);
    }

    _mostra(d) {
        const s = this._settings;
        const disco = d.disco ?? {};
        const claude = d.claude ?? {};
        const rec = d.recuperabile ?? {};

        // Soglie dal JSON, con ripiego: valgono per le barre e per le tinte
        // delle etichette nel pannello.
        this._attenzione = (d.soglie?.attenzione ?? 75) / 100;
        this._critico = (d.soglie?.critico ?? 90) / 100;
        for (const m of [this._mDisco, this._mCache, this._mSessione, this._mSettimana])
            m.setSoglie(this._attenzione, this._critico);

        this._rigaGuasto.visible = !!this._guasto;
        if (this._guasto)
            this._rigaGuasto.set_text(`⚠  ${this._guasto}`);

        this._aggiornaPannello(d);
        this._etichettaAggiornato.set_text(fmtAge(d.generatoIl));

        this._mDisco.aggiorna(`${disco.pct ?? '?'}%`, (disco.pct ?? 0) / 100,
            `${disco.usatiGb ?? '?'} di ${disco.totaliGb ?? '?'} GB · ${disco.liberiGb ?? '?'} GB liberi`);

        const cacheMb = claude.cacheHomeMb ?? 0;
        const cacheSoglia = d.soglie?.cacheMb ?? 2048;
        this._mCache.aggiorna(fmtMb(cacheMb), cacheMb / cacheSoglia,
            claude.cacheTop
                ? `soglia ${fmtMb(cacheSoglia)} · più grossa: ${claude.cacheTop} (${fmtMb(claude.cacheTopMb ?? 0)})`
                : `soglia ${fmtMb(cacheSoglia)}`);

        // Si mostra lo spazio delle CONVERSAZIONI, non il totale di ~/.claude:
        // lì dentro finiscono anche gli ambienti che i plugin si installano, e
        // sommarli fa sembrare che sia cresciuto il lavoro dell'utente.
        const punti = this._serieStorica();
        this._mClaude.setPunti(punti);
        const conv = claude.conversazioniMb ?? claude.totaleMb;
        let andamento = `${claude.conversazioni ?? 0} conversazioni · ${claude.messaggi ?? 0} messaggi`;
        if (punti.length >= 2) {
            const delta = Math.round(punti[punti.length - 1] - punti[0]);
            andamento += ` · ${delta >= 0 ? '+' : ''}${delta} MB su ${punti.length} rilevazioni`;
        }
        const resto = (claude.totaleMb ?? 0) - conv;
        if (resto > 20)
            andamento += `\n~/.claude in tutto ${fmtMb(claude.totaleMb)}, di cui ${fmtMb(resto)} fra plugin e strumenti`;
        this._mClaude.aggiorna(fmtMb(conv), null, andamento);

        const mostraQuota = s.get_boolean('show-usage');
        this._ruleQuota.visible = mostraQuota;
        this._mSessione.visible = mostraQuota;
        this._mSettimana.visible = mostraQuota;
        if (mostraQuota) {
            const eta = d.quota ? ` · letta ${fmtAge(d.quota.letteIl)}` : '';
            const rendi = (m, gruppo) => {
                // Si scartano i limiti senza percentuale, come fa già il
                // pannello: altrimenti popup e barra direbbero cose diverse.
                const tutti = (d.quota?.limiti ?? []).filter(
                    x => x.gruppo === gruppo &&
                         x.percento !== null && x.percento !== undefined);
                const l = tutti.sort((a, b) => (b.percento ?? 0) - (a.percento ?? 0))[0];
                if (!l) {
                    m.aggiorna('—', 0, s.get_boolean('usage-enabled')
                        ? 'in attesa della prima lettura'
                        : 'monitoraggio disattivato');
                    return;
                }
                m.aggiorna(`${l.percento}%`, (l.percento ?? 0) / 100,
                           `${fmtAzzeramento(l.azzeramento)}${eta}`);
            };
            rendi(this._mSessione, 'session');
            rendi(this._mSettimana, 'weekly');
        }

        const recTot = rec.totaleMb ?? 0;
        const voci = (rec.voci ?? []).map(v => v.dettaglio ? `${v.nome} (${v.dettaglio})` : v.nome);
        this._mRec.aggiorna(fmtMb(recTot), null,
                            voci.length ? voci.join(' · ') : 'niente da liberare');
        // Non si chiede piu' `d.progetto`: era il residuo di quando il
        // pulsante cercava clean.sh dentro il checkout. Da installata quel
        // campo e' null, quindi il pulsante restava spento sempre.
        const puoPulire = (rec.voci ?? []).length > 0;
        this._btnLibera.reactive = puoPulire;
        this._btnLibera.style_class = puoPulire ? 'fw-btn fw-btn-libera' : 'fw-btn fw-btn-spento';

        // Un progetto è una cartella figlia diretta della radice: è il modo in
        // cui l'utente lavora davvero, e si verifica senza ambiguità. Tutto il
        // resto — la home, /tmp, percorsi sparsi — sono posti da cui Claude è
        // stato lanciato, non progetti.
        const radice = this._radiceProgetti();
        const tutte = claude.progetti ?? [];
        const quanti = s.get_int('max-projects');
        const veri = tutte.filter(p => GLib.path_get_dirname(p.percorso ?? '') === radice);
        const altre = tutte.filter(p => GLib.path_get_dirname(p.percorso ?? '') !== radice);

        const prog = s.get_boolean('show-projects');
        this._testaProgetti.visible = prog;
        this._boxProgetti.visible = prog;
        if (!prog)
            this._chiudiNuovo();
        this._righeProgetto = this._disegnaElenco(
            this._boxProgetti, prog ? veri.slice(0, quanti) : [],
            '_firmaProgetti', true, 'nessun progetto nella radice');

        const altreVisibili = s.get_boolean('show-other-folders') && altre.length > 0;
        this._ruleAltre.visible = altreVisibili;
        this._titoloAltre.visible = altreVisibili;
        this._notaAltre.visible = altreVisibili;
        this._boxAltre.visible = altreVisibili;
        this._righeAltre = this._disegnaElenco(
            this._boxAltre, altreVisibili ? altre.slice(0, quanti) : [],
            '_firmaAltre', false, '');

        const all = s.get_boolean('show-alerts');
        this._boxAllarmi.visible = all;
        this._boxAllarmi.destroy_all_children();
        if (all) {
            for (const a of d.allarmi ?? [])
                this._boxAllarmi.add_child(new St.Label({text: `⚠  ${a}`,
                                                         style_class: 'fw-alert'}));
        }
    }

    /* Disegna un elenco di righe, ricostruendolo solo se i dati sono cambiati:
       rifarlo a ogni aggiornamento chiuderebbe le righe aperte e farebbe
       perdere i clic sotto il mouse. */
    _disegnaElenco(contenitore, elenco, chiaveFirma, vero, vuoto) {
        const firma = JSON.stringify(elenco.map(p =>
            [p.percorso, p.mb, p.sessioni, p.messaggi, p.esiste,
             (p.problemi ?? []).map(x => x.codice)]));
        if (firma === this[chiaveFirma])
            return this[vero ? '_righeProgetto' : '_righeAltre'] ?? [];

        this[chiaveFirma] = firma;
        contenitore.destroy_all_children();
        const righe = [];
        const massimo = Math.max(...elenco.map(p => p.mb), 0);
        for (const p of elenco) {
            const r = new RigaProgetto(p, massimo, this, {vero});
            contenitore.add_child(r);
            righe.push(r);
        }
        if (!elenco.length && vuoto)
            contenitore.add_child(new St.Label({text: vuoto, style_class: 'fw-empty'}));
        return righe;
    }

    _serieStorica() {
        const testo = readText(HISTORY);
        if (!testo)
            return [];
        const righe = testo.trim().split('\n').slice(-MAX_CAMPIONI);
        const punti = [];
        for (const r of righe) {
            try {
                const j = JSON.parse(r);
                // conversazioniMb dove c'è; le righe vecchie hanno solo claudeMb
                const v = j.conversazioniMb ?? j.claudeMb;
                if (typeof v === 'number')
                    punti.push(v);
            } catch {
                // una riga rotta non deve far saltare il grafico
            }
        }
        return punti;
    }

    /* -------------------------------------------------------- raccolta --- */

    _percorsoScript(nome) {
        const candidati = [];
        if (this._dati?.progetto)
            candidati.push(GLib.build_filenamev([this._dati.progetto, 'bin', nome]));
        if (this._ext?.path)
            candidati.push(GLib.build_filenamev([this._ext.path, nome]));
        return candidati.find(c => GLib.file_test(c, GLib.FileTest.IS_EXECUTABLE)) ?? null;
    }

    /* Vero se il lucchetto è chiuso da così tanto da doverlo considerare perso. */
    _lucchettoScaduto(quando) {
        return !quando || (Date.now() - quando) > LUCCHETTO_MS;
    }

    _raccogli() {
        if (this._inCorso && !this._lucchettoScaduto(this._inCorsoDa))
            return;
        const script = this._percorsoScript('collect-metrics.py');
        if (!script) {
            this._leggi();
            return;
        }
        this._inCorso = true;
        this._inCorsoDa = Date.now();
        try {
            // STDERR_PIPE e non SILENCE: un raccoglitore che fallisce deve
            // poterlo dire all'utente. Prima finiva solo nel journal, e a
            // video restava un dato che invecchiava senza spiegazione.
            // La radice scelta a mano vince sulla deduzione che lo script fa
            // da solo, quindi gliela si passa. Non la rilegge lui da
            // gsettings: lo schema non e' installato a livello di sistema e
            // un secondo posto dove decidere la stessa cosa e' un posto dove
            // le due decisioni divergono.
            const argv = [script, '--quiet'];
            const sceltaRadice = this._settings.get_string('projects-root').trim();
            if (sceltaRadice)
                argv.push('--radice-progetti',
                          sceltaRadice.replace(/^~/, GLib.get_home_dir()));
            const proc = Gio.Subprocess.new(argv,
                                            Gio.SubprocessFlags.STDOUT_SILENCE |
                                            Gio.SubprocessFlags.STDERR_PIPE);
            proc.communicate_utf8_async(null, null, (src, res) => {
                this._inCorso = false;
                if (this._morto)
                    return;
                this._esaminaEsito(src, res, 'Raccolta delle metriche');
                this._leggi();
            });
        } catch (e) {
            this._inCorso = false;
            this._segnalaGuasto('Raccolta delle metriche', e.message);
        }
    }

    _riprogramma() {
        if (this._timeout) {
            GLib.source_remove(this._timeout);
            this._timeout = 0;
        }
        const secondi = this._settings.get_int('refresh-seconds');
        this._timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, secondi, () => {
            this._raccogli();
            return GLib.SOURCE_CONTINUE;
        });
    }

    /* La quota costa un giro di rete: va più piano delle misure locali. */
    _riprogrammaQuota() {
        if (this._timeoutQuota) {
            GLib.source_remove(this._timeoutQuota);
            this._timeoutQuota = 0;
        }
        if (!this._settings.get_boolean('usage-enabled'))
            return;
        const secondi = this._settings.get_int('usage-interval-seconds');
        this._timeoutQuota = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, secondi, () => {
            this._leggiQuota();
            return GLib.SOURCE_CONTINUE;
        });
        // Se il dato su disco è più vecchio dell'intervallo si parte subito,
        // invece di mostrare un valore stantio per un ciclo intero.
        const eta = this._dati?.quota?.etaSecondi;
        if (eta === undefined || eta === null || eta > secondi)
            this._leggiQuota();
    }

    _leggiQuota() {
        if (!this._settings.get_boolean('usage-enabled'))
            return;
        if (this._quotaInCorso && !this._lucchettoScaduto(this._quotaInCorsoDa))
            return;
        const script = this._percorsoScript('collect-usage.py');
        if (!script)
            return;
        this._quotaInCorso = true;
        this._quotaInCorsoDa = Date.now();
        try {
            const proc = Gio.Subprocess.new([script, '--quiet'],
                                            Gio.SubprocessFlags.STDOUT_SILENCE |
                                            Gio.SubprocessFlags.STDERR_PIPE);
            proc.communicate_utf8_async(null, null, (src, res) => {
                this._quotaInCorso = false;
                if (this._morto)
                    return;
                this._esaminaEsito(src, res, 'Lettura della quota');
                // Basta rileggere: la quota sta in usage.json, non serve
                // rigenerare tutte le metriche con un altro sottoprocesso.
                this._leggi();
            });
        } catch (e) {
            this._quotaInCorso = false;
            this._segnalaGuasto('Lettura della quota', e.message);
        }
    }

    /* A menu aperto l'età va avanti da sola: ricalcolarla solo alla lettura
       la congelerebbe finché il popup resta aperto. */
    _avviaOrologio() {
        this._fermaOrologio();
        this._orologio = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            if (this._morto || !this._dati)
                return GLib.SOURCE_CONTINUE;
            this._etichettaAggiornato.set_text(fmtAge(this._dati.generatoIl));
            return GLib.SOURCE_CONTINUE;
        });
    }

    _fermaOrologio() {
        if (this._orologio) {
            GLib.source_remove(this._orologio);
            this._orologio = 0;
        }
    }

    /* ------------------------------------------------------- guasti --- */

    /* Legge l'esito di un sottoprocesso e, se è andato male, lo dice a video.
       Un guasto silenzioso lascia il cruscotto con dati vecchi e nessun
       indizio: l'unico segnale era l'età che cresceva. */
    _esaminaEsito(src, res, cosa) {
        let errore = null;
        try {
            const [, , stderr] = src.communicate_utf8_finish(res);
            if (!src.get_successful())
                errore = (stderr || '').trim().split('\n').pop() || 'esito diverso da zero';
        } catch (e) {
            errore = e.message;
        }
        if (errore)
            this._segnalaGuasto(cosa, errore);
        else
            this._guasto = null;
    }

    _segnalaGuasto(cosa, dettaglio) {
        logError(new Error(`${cosa}: ${dettaglio}`), 'claude-code-watchdog');
        this._guasto = `${cosa} non riuscita: ${taglia(dettaglio, 90)}`;
        if (this._rigaGuasto) {
            this._rigaGuasto.set_text(`⚠  ${this._guasto}`);
            this._rigaGuasto.show();
        }
    }

    /* ----------------------------------------------------------- esito --- */

    _mostraEsito(testo) {
        this._esito.set_text(testo);
        this._esito.show();
        if (this._timeoutEsito)
            GLib.source_remove(this._timeoutEsito);
        this._timeoutEsito = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ESITO_MS, () => {
            this._esito.hide();
            this._timeoutEsito = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    /* ---------------------------------------------------- nuovo progetto --- */

    _chiudiNuovo() {
        this._boxNuovo?.hide();
        this._boxNuovo?.destroy_all_children();
        this._campoNuovo = null;
        this._erroreNuovo = null;
    }

    _apriNuovo() {
        if (this._boxNuovo.visible) {
            this._chiudiNuovo();
            return;
        }
        this._boxNuovo.destroy_all_children();
        const radice = this._radiceProgetti();

        this._boxNuovo.add_child(new St.Label({
            text: 'Nome della cartella da creare in:', style_class: 'fw-nuovo-titolo'}));
        this._boxNuovo.add_child(new St.Label({
            text: radice.replace(GLib.get_home_dir(), '~'),
            style_class: 'fw-nuovo-percorso'}));

        this._campoNuovo = new St.Entry({style_class: 'fw-entry', x_expand: true,
                                         can_focus: true,
                                         hint_text: 'nome-del-progetto'});
        this._boxNuovo.add_child(this._campoNuovo);

        this._erroreNuovo = new St.Label({text: '', style_class: 'fw-nuovo-errore',
                                          visible: false});
        this._boxNuovo.add_child(this._erroreNuovo);

        const azioni = new St.BoxLayout({style_class: 'fw-actions', x_expand: true});
        const annulla = new St.Button({label: 'Annulla', style_class: 'fw-btn-mini',
                                       x_expand: true, can_focus: true});
        annulla.connect('clicked', () => this._chiudiNuovo());
        const crea = new St.Button({label: 'Crea e apri', style_class: 'fw-btn-mini fw-btn-primario',
                                    x_expand: true, can_focus: true});
        crea.connect('clicked', () => this._creaProgetto(this._campoNuovo.get_text()));
        azioni.add_child(annulla);
        azioni.add_child(crea);
        this._boxNuovo.add_child(azioni);

        // Invio conferma, Esc chiude: dentro un campo di testo sono i due tasti
        // che uno prova per primi.
        this._campoNuovo.clutter_text.connect('activate', () =>
            this._creaProgetto(this._campoNuovo.get_text()));
        this._campoNuovo.clutter_text.connect('key-press-event', (_a, evento) => {
            if (evento.get_key_symbol() === Clutter.KEY_Escape) {
                this._chiudiNuovo();
                return Clutter.EVENT_STOP;
            }
            this._erroreNuovo?.hide();
            return Clutter.EVENT_PROPAGATE;
        });

        this._boxNuovo.show();
        // Senza questo il menu tiene il fuoco e si digita nel vuoto.
        global.stage.set_key_focus(this._campoNuovo.clutter_text);
    }

    /* --------------------------------------------------------- pulizia --- */

    _chiudiPulizia() {
        this._boxPulizia?.hide();
        this._boxPulizia?.destroy_all_children();
        this._righePulizia = [];
    }

    _apriPulizia() {
        const voci = this._dati?.recuperabile?.voci ?? [];
        const progetto = this._dati?.progetto;
        this._boxPulizia.destroy_all_children();

        if (!progetto || !voci.length) {
            this._boxPulizia.add_child(new St.Label({
                text: voci.length ? 'Progetto watchdog non trovato' : 'Niente da liberare',
                style_class: 'fw-confirm-note'}));
            this._boxPulizia.show();
            return;
        }

        this._boxPulizia.add_child(new St.Label({
            text: 'Da eliminare', style_class: 'fw-confirm-title'}));
        this._righePulizia = voci.map(v => {
            const r = new RigaScelta(v);
            this._boxPulizia.add_child(r);
            return r;
        });
        this._boxPulizia.add_child(new St.Label({
            text: 'Cache pacchetti, journal e kernel richiedono root: da /watchdog-clean.',
            style_class: 'fw-confirm-note'}));

        const azioni = new St.BoxLayout({style_class: 'fw-actions', x_expand: true});
        const annulla = new St.Button({label: 'Annulla', style_class: 'fw-btn-mini',
                                       x_expand: true, can_focus: true});
        annulla.connect('clicked', () => this._chiudiPulizia());
        const conferma = new St.Button({label: 'Elimina',
                                        style_class: 'fw-btn-mini fw-btn-danger',
                                        x_expand: true, can_focus: true});
        conferma.connect('clicked', () => this._eseguiPulizia());
        azioni.add_child(annulla);
        azioni.add_child(conferma);
        this._boxPulizia.add_child(azioni);
        this._boxPulizia.show();
    }

    _eseguiPulizia() {
        if (this._pulendo)
            return;
        const scelti = (this._righePulizia ?? []).filter(r => r.scelto).map(r => r.voce.target);
        if (!scelti.length) {
            this._mostraEsito('Niente di selezionato.');
            return;
        }
        // reclaim.py e non clean.sh. Quello si cercava dentro il checkout del
        // progetto, che in un'installazione normale non esiste: la condizione
        // scattava sempre e il pulsante rispondeva «Niente di selezionato»
        // anche con tutto spuntato. E dentro ha dnf5, journalctl e i coredump,
        // che fuori da Fedora non hanno senso. reclaim.py viaggia
        // nell'estensione e fa solo i target che questo pulsante puo' chiedere.
        const script = this._percorsoScript('reclaim.py');
        if (!script) {
            this._mostraEsito('reclaim.py non trovato.');
            return;
        }

        this._pulendo = true;
        this._mostraEsito('Pulizia in corso…');
        try {
            // STDERR separato e non unito: l'esito si legge come JSON, e un
            // avviso finito in mezzo lo renderebbe illeggibile.
            const proc = Gio.Subprocess.new([script, '--apply', '--json', ...scelti],
                                            Gio.SubprocessFlags.STDOUT_PIPE |
                                            Gio.SubprocessFlags.STDERR_PIPE);
            proc.communicate_utf8_async(null, null, (src, res) => {
                this._pulendo = false;
                if (this._morto)
                    return;
                let liberati = null;
                try {
                    const [, stdout] = src.communicate_utf8_finish(res);
                    // Dato strutturato, non una frase da cercare con una
                    // regex: il testo per l'utente si puo' riscrivere senza
                    // accorgersi di aver rotto il conteggio.
                    liberati = JSON.parse(stdout ?? '').liberatiMb ?? null;
                } catch (e) {
                    logError(e, 'claude-code-watchdog: pulizia, lettura esito fallita');
                }
                // Il dialogo si chiude da solo: restare aperto su un elenco
                // ormai vuoto è solo confusione.
                this._chiudiPulizia();
                this._mostraEsito(liberati !== null
                    ? `Liberati ${liberati} MB.` : 'Pulizia conclusa.');
                this._raccogli();
            });
        } catch (e) {
            this._pulendo = false;
            this._chiudiPulizia();
            this._mostraEsito('Avvio della pulizia fallito.');
            logError(e, 'claude-code-watchdog: reclaim.py non avviato');
        }
    }

    /* ------------------------------------------------ azioni progetto --- */

    /* Gio costruisce l'URI con le fughe giuste: un "file://" concatenato a
       mano si rompe sul primo spazio, e fra i progetti c'è "Documenti Vari". */
    _apriPercorso(percorso) {
        if (!percorso)
            return;
        try {
            Gio.AppInfo.launch_default_for_uri(
                Gio.File.new_for_path(percorso).get_uri(), null);
        } catch (e) {
            logError(e, 'claude-code-watchdog: apertura non riuscita');
        }
    }

    apriCartella(p) {
        if (!p.esiste) {
            this._mostraEsito('La cartella non esiste più.');
            return;
        }
        this._apriPercorso(p.percorso);
        this.menu.close();
    }

    /* La shell da usare dopo che claude esce.
       Ptyxis può avere un comando personalizzato nel profilo:
       ignorarlo significa dare all'utente una shell spoglia, senza il suo
       prompt e i suoi alias. Si legge quello prima di ripiegare su $SHELL. */
    _shell() {
        const scelta = this._settings.get_string('shell').trim();
        if (scelta)
            return scelta;
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
                        return cmd.split(/\s+/)[0];
                }
            }
        } catch {
            // Ptyxis assente o schema diverso: si passa oltre senza rumore.
        }
        return GLib.getenv('SHELL') || 'bash';
    }

    /* Vero se quel terminale ha già almeno una finestra. */
    _terminaleHaFinestre(desktop) {
        try {
            const app = Shell.AppSystem.get_default().lookup_app(desktop);
            return !!app && app.get_n_windows() > 0;
        } catch (e) {
            logError(e, 'claude-code-watchdog: conteggio finestre fallito');
            return false;
        }
    }

    _comandoTerminale(cwd, comando = 'claude --resume') {
        const custom = this._settings.get_string('terminal-command').trim();
        if (custom) {
            // Solo %d: l'azione è per progetto, non c'è un id di sessione da
            // sostituire. La documentazione va tenuta allineata a questo.
            return ['bash', '-lc', custom.replace(/%d/g, GLib.shell_quote(cwd))];
        }

        const sh = this._shell();
        const shq = GLib.shell_quote(sh);
        // -i perché la shell legga i suoi file di configurazione: senza, il
        // prompt e gli alias dell'utente non ci sono.
        const riga = `${comando}; exec ${shq} -i`;

        const term = TERMINALI.find(t => GLib.find_program_in_path(t.cmd));
        if (!term) {
            if (GLib.find_program_in_path('xdg-terminal-exec'))
                return ['xdg-terminal-exec', sh, '-i', '-c', riga];
            return null;
        }

        // Scheda solo se c'è già una finestra dove metterla.
        const aperto = this._terminaleHaFinestre(term.desktop);
        if (term.cmd === 'ptyxis') {
            // Senza finestre NON si passa --new-window: «ptyxis -- comando» è
            // già documentato come «esegui in una nuova finestra», e aggiungere
            // il flag ne fa aprire due.
            return aperto
                ? ['ptyxis', '--tab', '-d', cwd, '--', sh, '-i', '-c', riga]
                : ['ptyxis', '-d', cwd, '--', sh, '-i', '-c', riga];
        }
        if (term.cmd === 'kgx')
            return ['kgx', '--working-directory', cwd, '--', sh, '-i', '-c', riga];
        return aperto
            ? ['gnome-terminal', '--tab', '--working-directory', cwd, '--', sh, '-i', '-c', riga]
            : ['gnome-terminal', '--window', '--working-directory', cwd, '--', sh, '-i', '-c', riga];
    }

    /* Avvia il terminale con un comando dentro una cartella.
       ATTENZIONE: questo metodo è stato cancellato per sbaglio il 2026-09-17
       riscrivendo _comandoTerminale, e «Riprendi» ha smesso di funzionare con
       un «_apriTerminale is not a function» visibile solo nel journal. */
    _apriTerminale(cwd, comando) {
        const cmd = this._comandoTerminale(cwd, comando);
        if (!cmd) {
            this._mostraEsito('Nessun terminale trovato: impostalo nelle preferenze.');
            return false;
        }
        try {
            Gio.Subprocess.new(cmd, Gio.SubprocessFlags.NONE);
            this.menu.close();
            return true;
        } catch (e) {
            this._mostraEsito('Apertura del terminale fallita.');
            logError(e, 'claude-code-watchdog: terminale non avviato');
            return false;
        }
    }

    riprendi(p) {
        if (!p.esiste) {
            this._mostraEsito('La cartella di lavoro non esiste più.');
            return;
        }
        this._apriTerminale(p.percorso, 'claude --resume');
    }

    /* La cartella dove nascono i nuovi progetti: quella impostata, oppure
       quella che contiene il progetto watchdog. */
    _radiceProgetti() {
        // Le barre finali vanno tolte: il confronto con path_get_dirname() è
        // testuale, e «~/Documenti/Claude/» incollato da un gestore file non
        // combacerebbe mai — mandando ogni progetto in «fuori dai progetti».
        const pulisci = c => c.replace(/\/+$/, '') || '/';
        const scelta = this._settings.get_string('projects-root').trim();
        if (scelta)
            return pulisci(scelta.replace(/^~/, GLib.get_home_dir()));
        // Dedotta dai progetti gia' noti e pubblicata in metrics.json.
        // Prima si ricavava da «progetto», che e' null quando lo script
        // gira copiato dentro l'estensione: il rilevamento automatico
        // che lo schema promette non ha mai funzionato da installato.
        if (this._dati?.radiceProgetti)
            return pulisci(this._dati.radiceProgetti);
        if (this._dati?.progetto)
            return pulisci(GLib.path_get_dirname(this._dati.progetto));
        return GLib.get_home_dir();
    }

    /* Un nome di cartella, non un percorso: niente separatori, niente nomi
       nascosti, niente risalite. Chi digita qui sta creando una cartella. */
    _validaNome(nome) {
        const n = nome.trim();
        if (!n)
            return 'Serve un nome.';
        if (n.includes('/'))
            return 'Il nome non può contenere «/».';
        if (n.startsWith('.'))
            return 'Il nome non può iniziare con un punto.';
        if (n === '..' || n === '.')
            return 'Nome non valido.';
        if (n.length > 80)
            return 'Nome troppo lungo.';
        const percorso = GLib.build_filenamev([this._radiceProgetti(), n]);
        if (GLib.file_test(percorso, GLib.FileTest.EXISTS))
            return 'Esiste già una cartella con questo nome.';
        return null;
    }

    /* Il README di partenza.
       Volutamente quasi vuoto: l'unica cosa che conta è la riga che deve
       scrivere l'utente, e un file pieno di sezioni vuote inviterebbe a
       ignorarlo invece che a compilarlo. */
    _readmeIniziale(nome, percorso) {
        const oggi = GLib.DateTime.new_now_local().format('%Y-%m-%d');
        const breve = percorso.replace(GLib.get_home_dir(), '~');
        return [
            `# ${nome}`,
            '',
            '> Due righe su cos\u2019è questo progetto e perché esiste.',
            '> Si leggono fra sei mesi, quando il nome della cartella non basterà.',
            '',
            `Creato il ${oggi} · \`${breve}\``,
            '',
            '## Riprendere',
            '',
            '```bash',
            `cd ${GLib.shell_quote(percorso)}`,
            'claude --resume',
            '```',
            '',
            'Qui stanno i file di lavoro. Le conversazioni sono in',
            '`~/.claude/projects/`, le memorie del progetto nella sua',
            'sottocartella `memory/`.',
            '',
        ].join('\n');
    }

    _creaProgetto(nome) {
        const errore = this._validaNome(nome);
        if (errore) {
            this._erroreNuovo?.set_text(errore);
            this._erroreNuovo?.show();
            return;
        }
        const percorso = GLib.build_filenamev([this._radiceProgetti(), nome.trim()]);
        try {
            Gio.File.new_for_path(percorso).make_directory_with_parents(null);
        } catch (e) {
            this._erroreNuovo?.set_text('Non si riesce a creare la cartella.');
            this._erroreNuovo?.show();
            logError(e, 'claude-code-watchdog: creazione cartella fallita');
            return;
        }
        let conReadme = false;
        if (this._settings.get_boolean('new-project-readme')) {
            try {
                const f = Gio.File.new_for_path(
                    GLib.build_filenamev([percorso, 'README.md']));
                f.replace_contents(
                    new TextEncoder().encode(this._readmeIniziale(nome.trim(), percorso)),
                    null, false, Gio.FileCreateFlags.NONE, null);
                conReadme = true;
            } catch (e) {
                // La cartella c'è già: un README mancato non è un fallimento.
                logError(e, 'claude-code-watchdog: README non scritto');
            }
        }

        this._chiudiNuovo();
        // Sessione nuova, non --resume: la cartella è appena nata.
        if (this._apriTerminale(percorso, 'claude')) {
            this._mostraEsito(conReadme
                ? `Creato ${nome.trim()} con il suo README.`
                : `Creato ${nome.trim()}.`);
        }
        this._raccogli();
    }

    /* ----------------------------------------------- cartella spostata --- */

    chiediCorreggi(p, riga) {
        const area = riga.areaConferma;
        area.destroy_all_children();
        area.remove_style_class_name('fw-confirm');
        area.add_style_class_name('fw-fix');

        area.add_child(new St.Label({
            text: 'Dove è finita questa cartella?',
            style_class: 'fw-confirm-title'}));
        area.add_child(new St.Label({
            text: `Prima era ${p.percorso}`, style_class: 'fw-confirm-note'}));

        // Proposta: stesso nome dentro la radice dei progetti. Nove volte su
        // dieci è lì che è stata spostata.
        const proposta = GLib.build_filenamev(
            [this._radiceProgetti(), GLib.path_get_basename(p.percorso)]);
        const campo = new St.Entry({style_class: 'fw-entry', x_expand: true,
                                    can_focus: true});
        campo.set_text(GLib.file_test(proposta, GLib.FileTest.IS_DIR) ? proposta : '');
        campo.hint_text = 'percorso della cartella';
        area.add_child(campo);

        const esito = new St.Label({text: '', style_class: 'fw-fix-esito', visible: false});
        esito.clutter_text.line_wrap = true;
        area.add_child(esito);

        const azioni = new St.BoxLayout({style_class: 'fw-actions', x_expand: true});
        const annulla = new St.Button({label: 'Annulla', style_class: 'fw-btn-mini',
                                       x_expand: true, can_focus: true});
        annulla.connect('clicked', () => riga.chiudiConferma());
        const verifica = new St.Button({label: 'Verifica', style_class: 'fw-btn-mini',
                                        x_expand: true, can_focus: true});
        const sposta = new St.Button({label: 'Sposta', x_expand: true, can_focus: true,
                                      style_class: 'fw-btn-mini fw-btn-spento'});
        sposta.reactive = false;

        // Si verifica prima e si sposta dopo: il pulsante resta spento finché
        // non c'è una prova che sia la cartella giusta.
        const fai = () => this._verificaSpostamento(
            p, campo.get_text(), esito, sposta, riga);
        verifica.connect('clicked', fai);
        campo.clutter_text.connect('activate', fai);
        // Cambiare il percorso dopo la verifica invalida la verifica: il
        // pulsante torna spento, altrimenti si potrebbe verificare un percorso
        // e spostare verso un altro.
        campo.clutter_text.connect('text-changed', () => {
            sposta.reactive = false;
            sposta.style_class = 'fw-btn-mini fw-btn-spento';
            this._percorsoVerificato = null;
        });
        sposta.connect('clicked', () =>
            this._eseguiSpostamento(p, campo.get_text(), riga));

        azioni.add_child(annulla);
        azioni.add_child(verifica);
        azioni.add_child(sposta);
        area.add_child(azioni);
        area.show();
        global.stage.set_key_focus(campo.clutter_text);
    }

    _percorsoRelocate() {
        return this._percorsoScript('project-relocate.py');
    }

    _verificaSpostamento(p, nuova, esito, sposta, riga) {
        const script = this._percorsoRelocate();
        if (!script || !nuova.trim()) {
            esito.set_text(script ? 'Scrivi un percorso.'
                                  : 'project-relocate.py non trovato.');
            esito.show();
            return;
        }
        esito.set_text('Verifica in corso…');
        esito.show();
        try {
            const proc = Gio.Subprocess.new([script, p.percorso, nuova.trim(), '--json'],
                                            Gio.SubprocessFlags.STDOUT_PIPE |
                                            Gio.SubprocessFlags.STDERR_SILENCE);
            proc.communicate_utf8_async(null, null, (src, res) => {
                if (this._morto || !esito.get_stage())
                    return;
                let d = null;
                try {
                    const [, stdout] = src.communicate_utf8_finish(res);
                    d = JSON.parse(stdout);
                } catch (e) {
                    logError(e, 'claude-code-watchdog: verifica spostamento illeggibile');
                }
                if (!d) {
                    esito.set_text('Verifica fallita.');
                    return;
                }
                const simbolo = {sicuro: '✓', incerto: '?', no: '✗'}[d.verdetto] ?? '?';
                const prove = d.trovati?.length
                    ? `\nFile ritrovati: ${d.trovati.slice(0, 4).join(', ')}`
                    : '';
                esito.set_text(`${simbolo} ${d.motivo}${prove}`);
                const ok = d.verdetto !== 'no';
                this._percorsoVerificato = ok ? nuova.trim() : null;
                sposta.reactive = ok;
                sposta.style_class = ok
                    ? 'fw-btn-mini fw-btn-riprendi' : 'fw-btn-mini fw-btn-spento';
                this._ultimaVerifica = ok ? d.verdetto : null;
            });
        } catch (e) {
            esito.set_text('Verifica non avviata.');
            logError(e, 'claude-code-watchdog: project-relocate non avviato');
        }
    }

    _eseguiSpostamento(p, nuova, riga) {
        const script = this._percorsoRelocate();
        if (!script)
            return;
        // Si sposta SOLO verso il percorso che è stato verificato. Senza questo
        // controllo un campo svuotato dopo la verifica arrivava allo script
        // come stringa vuota, e realpath('') è la cartella di lavoro del
        // processo chiamante: le trascrizioni finivano nel posto sbagliato.
        const scelto = (nuova ?? '').trim();
        if (!scelto || scelto !== this._percorsoVerificato) {
            this._mostraEsito('Verifica di nuovo il percorso prima di spostare.');
            return;
        }
        riga?.chiudiConferma();
        this._mostraEsito('Spostamento in corso…');
        try {
            const proc = Gio.Subprocess.new([script, p.percorso, nuova.trim(), '--apply', '--json'],
                                            Gio.SubprocessFlags.STDOUT_PIPE |
                                            Gio.SubprocessFlags.STDERR_SILENCE);
            proc.communicate_utf8_async(null, null, (src, res) => {
                if (this._morto)
                    return;
                let d = null;
                try {
                    const [, stdout] = src.communicate_utf8_finish(res);
                    d = JSON.parse(stdout);
                } catch (e) {
                    logError(e, 'claude-code-watchdog: esito spostamento illeggibile');
                }
                const errori = d?.errori ?? [];
                // Il numero di sessioni TROVATE non è quello delle spostate.
                const n = d?.spostate ?? 0;
                this._mostraEsito(errori.length
                    ? `Spostamento incompleto: ${errori[0]}`
                    : (n ? `Riagganciate ${n} sessioni. Originali nel cestino.`
                         : 'Nessuna trascrizione spostata.'));
                this._firmaProgetti = null;   // forza il ridisegno dell'elenco
                this._firmaAltre = null;
                this._raccogli();
            });
        } catch (e) {
            this._mostraEsito('Spostamento non avviato.');
            logError(e, 'claude-code-watchdog: project-relocate non avviato');
        }
    }

    /* Mostra cosa verrebbe rimosso PRIMA di rimuovere. */
    chiediElimina(p, riga) {
        const script = this._percorsoScript('project-purge.py');
        if (!script) {
            this._mostraEsito('project-purge.py non trovato.');
            return;
        }
        if (!this._settings.get_boolean('confirm-delete')) {
            this._eliminaProgetto(p, riga);
            return;
        }
        const area = riga.areaConferma;
        area.destroy_all_children();
        area.add_child(new St.Label({text: 'Lettura…', style_class: 'fw-confirm-note'}));
        area.show();

        try {
            const proc = Gio.Subprocess.new([script, p.percorso, '--json'],
                                            Gio.SubprocessFlags.STDOUT_PIPE |
                                            Gio.SubprocessFlags.STDERR_SILENCE);
            proc.communicate_utf8_async(null, null, (src, res) => {
                // Un aggiornamento nel frattempo ricostruisce le righe: quella
                // catturata qui può essere già stata distrutta.
                if (this._morto ||
                    !(this._righeProgetto.includes(riga) ||
                      (this._righeAltre ?? []).includes(riga)))
                    return;
                let dati = null;
                try {
                    const [, stdout] = src.communicate_utf8_finish(res);
                    dati = JSON.parse(stdout);
                } catch (e) {
                    logError(e, 'claude-code-watchdog: elenco rimozione illeggibile');
                }
                this._mostraConfermaProgetto(p, riga, dati);
            });
        } catch (e) {
            area.destroy_all_children();
            area.add_child(new St.Label({text: 'Lettura fallita.',
                                         style_class: 'fw-confirm-note'}));
            logError(e, 'claude-code-watchdog: project-purge non avviato');
        }
    }

    _mostraConfermaProgetto(p, riga, dati) {
        const area = riga.areaConferma;
        area.destroy_all_children();

        const voci = dati?.voci ?? [];
        if (!voci.length) {
            area.add_child(new St.Label({text: 'Nessun dato Claude per questo progetto.',
                                         style_class: 'fw-confirm-note'}));
            return;
        }

        area.add_child(new St.Label({
            text: `${voci.length} elementi · ${(dati.byteTotali / 1048576).toFixed(1)} MB`,
            style_class: 'fw-confirm-title'}));

        for (const v of voci.sort((a, b) => b.byte - a.byte)) {
            const r = new St.BoxLayout({x_expand: true, style_class: 'fw-purge-row'});
            r.add_child(new St.Label({text: v.cosa, style_class: 'fw-pick-name',
                                      x_expand: true}));
            r.add_child(new St.Label({text: `${(v.byte / 1048576).toFixed(1)} MB`,
                                      style_class: 'fw-pick-detail'}));
            area.add_child(r);
        }

        // Quello che NON viene toccato va detto per primo: è la domanda che uno
        // si fa guardando un bottone rosso accanto al nome di una sua cartella.
        area.add_child(new St.Label({
            text: riga.vero
                ? `La cartella di lavoro ${p.percorso} non viene toccata.`
                : `${p.percorso} non viene toccata: si tolgono solo le sessioni.`,
            style_class: 'fw-confirm-safe'}));
        area.add_child(new St.Label({
            text: 'Va tutto nel cestino: se sbagli, si recupera da lì.',
            style_class: 'fw-confirm-note'}));

        const azioni = new St.BoxLayout({style_class: 'fw-actions', x_expand: true});
        const annulla = new St.Button({label: 'Annulla', style_class: 'fw-btn-mini',
                                       x_expand: true, can_focus: true});
        annulla.connect('clicked', () => riga.chiudiConferma());
        const ok = new St.Button({label: riga.vero ? 'Elimina i dati Claude'
                                                   : 'Elimina le sessioni',
                                  style_class: 'fw-btn-mini fw-btn-danger',
                                  x_expand: true, can_focus: true});
        ok.connect('clicked', () => this._eliminaProgetto(p, riga));
        azioni.add_child(annulla);
        azioni.add_child(ok);
        area.add_child(azioni);
    }

    _eliminaProgetto(p, riga) {
        const script = this._percorsoScript('project-purge.py');
        if (!script) {
            this._mostraEsito('project-purge.py non trovato.');
            return;
        }
        riga?.chiudiConferma();
        this._mostraEsito(riga?.vero === false
            ? `Rimozione delle sessioni di ${taglia(p.nome, 20)}…`
            : `Rimozione dei dati di ${taglia(p.nome, 24)}…`);
        try {
            const proc = Gio.Subprocess.new([script, p.percorso, '--apply'],
                                            Gio.SubprocessFlags.STDOUT_SILENCE |
                                            Gio.SubprocessFlags.STDERR_SILENCE);
            proc.wait_async(null, () => {
                if (this._morto)
                    return;
                // Uscita diversa da 0 significa che qualche rimozione è
                // fallita: dirlo, invece di annunciare un successo.
                const ok = proc.get_successful();
                this._mostraEsito(ok
                    ? `Dati di ${taglia(p.nome, 22)} rimossi.`
                    : `Rimozione incompleta per ${taglia(p.nome, 18)}.`);
                this._raccogli();
            });
        } catch (e) {
            this._mostraEsito('Rimozione fallita.');
            logError(e, 'claude-code-watchdog: project-purge non avviato');
        }
    }

    destroy() {
        // Le richiamate dei sottoprocessi sopravvivono a destroy(): senza
        // questa bandiera toccherebbero attori già deallocati.
        this._morto = true;
        // Il suggerimento vive fuori dal menu, appeso alla chrome della shell:
        // se non lo si toglie a mano resta lì dopo la disattivazione.
        this.suggerimento?.destroy();
        this.suggerimento = null;
        for (const t of ['_timeout', '_timeoutEsito', '_timeoutQuota', '_orologio']) {
            if (this[t]) {
                GLib.source_remove(this[t]);
                this[t] = 0;
            }
        }
        if (this._idSettings) {
            this._settings.disconnect(this._idSettings);
            this._idSettings = 0;
        }
        super.destroy();
    }
});

export default class FedoraWatchdogExtension extends Extension {
    enable() {
        try {
            this._indicatore = new Indicatore(this);
            Main.panel.addToStatusArea(this.uuid, this._indicatore);
        } catch (e) {
            // Senza questa rete un errore qui lascia l'estensione in ERROR e
            // l'indicatore a metà costruzione, che poi fa fallire anche
            // disable(). Meglio ripulire e dire cosa è andato storto.
            logError(e, 'claude-code-watchdog: avvio fallito');
            try {
                this._indicatore?.destroy();
            } catch (e2) {
                logError(e2, 'claude-code-watchdog: pulizia dopo avvio fallito');
            }
            this._indicatore = null;
            throw e;
        }
    }

    disable() {
        this._indicatore?.destroy();
        this._indicatore = null;
    }
}
