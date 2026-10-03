// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CiroBoxHub

/* La mascotte fluttuante di Watchface — la «graffetta».
 *
 * Una sola mascotte, con una nuvoletta che elenca gli avvisi in corso: chi ti
 * aspetta, chi si è inceppato, chi ha finito. Uno è evidenziato, e faccina,
 * bordo e punta prendono il suo colore; un clic su un'altra riga la evidenzia,
 * un clic sulla faccina porta al terminale di quella evidenziata. Sul disco
 * della faccina un numero dice quanti sono, il robottino accanto quanti
 * aiutanti ha la sessione evidenziata.
 *
 * Ogni riga se ne va da sola quando la sua sessione riparte; «ha finito» dopo
 * i secondi scelti nelle preferenze; la × la toglie subito. Senza righe, la
 * mascotte si ritira — a meno che sia «sempre visibile»: allora resta, senza
 * nuvoletta, e la sua faccia segue Claude come quella della barra. Si trascina dove vuoi e si ricorda il posto. Con una
 * finestra a schermo intero sullo stesso monitor non compare: la nasconde la
 * shell (trackFullscreen).
 *
 * Le funzioni in cima non dipendono da GNOME: prova-js.sh le estrae da questo
 * file e le esegue con gjs.
 */

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {iconaStato, misureMascotte, piuUrgente, ORDINE_STATI} from './watchface.js';

export {posizioneFumetto, aggiungiAvviso, potaAvvisi, togliAvviso, Fumetto};

/* Distanza dai bordi dell'area di lavoro, al primo avvio. */
const MARGINE = 24;

/* Dove va la mascotte. Il posto ricordato è l'angolo in basso a destra della
   faccina (`ax`, `ay`): la nuvoletta cambia larghezza col testo, la faccina
   no, e così non salta a ogni avviso. -1, -1 vuol dire «mai spostata»:
   l'angolo in basso a destra del monitor principale. Se quel punto non sta
   più su nessun monitor — il secondo schermo staccato — si torna lì.
   Comunque vada, tutto il fumetto resta dentro l'area di lavoro. */
function posizioneFumetto(ax, ay, w, h, aree, primaria) {
    let i = -1;
    if (ax !== -1 || ay !== -1) {
        i = aree.findIndex(a => ax > a.x && ax <= a.x + a.width &&
                                ay > a.y && ay <= a.y + a.height);
    }
    if (i < 0) {
        i = primaria >= 0 && primaria < aree.length ? primaria : 0;
        ax = aree[i].x + aree[i].width - MARGINE;
        ay = aree[i].y + aree[i].height - MARGINE;
    }
    const a = aree[i];
    const x = Math.max(a.x, Math.min(ax - w, a.x + a.width - w));
    const y = Math.max(a.y, Math.min(ay - h, a.y + a.height - h));
    return [Math.round(x), Math.round(y)];
}

/* L'elenco degli avvisi. Un avviso è {id, stato, testo, quando, scade}: uno
   per sessione, il più recente. `scade` in secondi, 0 = finché non cambia
   qualcosa. In testa i più urgenti, a parità i più recenti. */
function ordinati(avvisi) {
    return [...avvisi].sort((a, b) => ORDINE_STATI.indexOf(a.stato) -
                                      ORDINE_STATI.indexOf(b.stato) || b.quando - a.quando);
}

/* Chi resta evidenziato: lo stesso se c'è ancora, se no il primo. */
function evidenziato(avvisi, id) {
    return avvisi.some(a => a.id === id) ? id : (avvisi[0]?.id ?? null);
}

/* Un avviso nuovo prende l'evidenza se è urgente almeno quanto quello
   evidenziato: «ti aspetta» non si fa coprire da «ha finito», ma un altro
   «ti aspetta» sì, perché è più recente. */
function aggiungiAvviso(avvisi, nuovo, id) {
    const lista = ordinati([...avvisi.filter(a => a.id !== nuovo.id), nuovo]);
    const ora = lista.find(a => a.id === id && a.id !== nuovo.id);
    const prende = !ora || ORDINE_STATI.indexOf(nuovo.stato) <= ORDINE_STATI.indexOf(ora.stato);
    return {avvisi: lista, id: prende ? nuovo.id : ora.id};
}

/* Via gli avvisi superati: la sessione non c'è più, ha cambiato stato (hai
   risposto, è ripartita), oppure il tempo è scaduto. */
function potaAvvisi(avvisi, sessioni, adesso, id) {
    const lista = avvisi.filter(a => {
        const s = sessioni.find(x => x.id === a.id);
        return s && s.stato === a.stato && !(a.scade > 0 && adesso >= a.scade);
    });
    return {avvisi: lista, id: evidenziato(lista, id)};
}

function togliAvviso(avvisi, via, id) {
    const lista = avvisi.filter(a => a.id !== via);
    return {avvisi: lista, id: evidenziato(lista, id)};
}

/* ------------------------------------------------------------ in shell --- */

/* Righe visibili nella nuvoletta; le altre si contano in fondo. */
const MAX_RIGHE = 4;
/* Sotto questo spostamento, in pixel, è un clic e non un trascinamento. */
const SOGLIA_TRASCINA = 6;

/* Il colore di ogni stato, per la punta disegnata. Il fondo è chiaro in
   entrambi i temi, quindi il testo è scuro e fisso, come nei pulsanti. */
const COLORI = {
    aspetta: [0xB7, 0x7B, 0x1A],
    errore: [0xCE, 0x5A, 0x50],
    finito: [0x2F, 0x92, 0x84],
};
const FONDO = [0xFA, 0xFA, 0xFA];

class Fumetto {
    constructor({percorsoEstensione, settings, suApri}) {
        this._percorso = percorsoEstensione;
        this._settings = settings;
        this._suApri = suApri;
        this._esterno = null;
        this._avvisi = [];
        this._id = null;             // l'avviso evidenziato
        this._sessioni = [];
        this._scadenza = 0;
        this._presa = null;
        this._firma = null;
        this._idSettings = settings.connect('changed', (_s, chiave) => {
            if (chiave === 'watchface-alerts') {
                if (!this._acceso())
                    this._svuota();
            } else if (chiave === 'watchface-size') {
                // Si ricostruisce alla misura nuova.
                this._ritira(false);
                this._smonta();
                this._disegna();
            } else if (chiave === 'watchface-floating-always') {
                this._disegna();
            } else if (chiave === 'watchface-floating-x' && this._carta?.visible) {
                this._colloca();
            }
        });
    }

    _acceso() {
        return this._settings.get_string('watchface-alerts') === 'mascotte';
    }

    _sempre() {
        return this._settings.get_boolean('watchface-floating-always');
    }

    /* Qualcosa da dire su `s`: una riga nuova, o quella della sessione
       aggiornata. */
    avvisa(s, testo) {
        if (!this._acceso())
            return;
        const adesso = Math.floor(Date.now() / 1000);
        const secondi = this._settings.get_int('watchface-floating-seconds');
        // «Ha finito» è una buona notizia e non chiede niente: se ne va da
        // sola, dopo i secondi scelti nelle preferenze (0: mai).
        const scade = s.stato === 'finito' && secondi > 0 ? adesso + secondi : 0;
        ({avvisi: this._avvisi, id: this._id} = aggiungiAvviso(
            this._avvisi, {id: s.id, stato: s.stato, testo, progetto: s.progetto,
                           quando: adesso, scade}, this._id));
        this._disegna();
    }

    /* A ogni rilettura delle sessioni, dopo gli eventuali avvisi. */
    aggiorna(sessioni) {
        this._sessioni = sessioni;
        if (this._avvisi.length)
            this._pota();
        else if (this._sempre())
            this._disegna();
    }

    distruggi() {
        if (this._idSettings) {
            this._settings.disconnect(this._idSettings);
            this._idSettings = 0;
        }
        this._fermaScadenza();
        this._lasciaPresa();
        this._smonta();
    }

    _pota() {
        ({avvisi: this._avvisi, id: this._id} = potaAvvisi(
            this._avvisi, this._sessioni, Math.floor(Date.now() / 1000), this._id));
        this._disegna();
    }

    _togli(id) {
        ({avvisi: this._avvisi, id: this._id} = togliAvviso(this._avvisi, id, this._id));
        this._disegna();
    }

    _evidenzia(id) {
        this._id = id;
        this._disegna();
    }

    _svuota() {
        this._avvisi = [];
        this._id = null;
        this._disegna();
    }

    /* ------------------------------------------------------- costruzione --- */

    _monta() {
        const misure = misureMascotte(this._settings.get_string('watchface-size'));
        // L'attore esterno lo segue la shell per lo schermo intero, e ne
        // decide la visibilità: il nostro mostra e nascondi sta sulla carta,
        // dentro, così le due cose non si pestano i piedi.
        this._esterno = new St.Widget({layout_manager: new Clutter.BinLayout()});
        this._carta = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
                                        style_class: 'fw-fumetto', visible: false});

        this._nuvola = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
                                         style_class: 'fw-fumetto-nuvola'});

        // La punta della nuvoletta, verso la faccina. Disegnata: St non ha
        // triangoli. Sale di qualche pixel per coprire il bordo della nuvola.
        this._coda = new St.DrawingArea({style_class: 'fw-fumetto-coda',
                                         x_align: Clutter.ActorAlign.END,
                                         translation_y: -3});
        this._coda.connect('repaint', area => this._disegnaCoda(area));

        // In fondo: il robottino, se servono, e la faccina col suo contatore.
        const sotto = new St.BoxLayout({style_class: 'fw-fumetto-sotto',
                                        x_align: Clutter.ActorAlign.END});
        this._robot = new St.BoxLayout({style_class: 'fw-fumetto-robot',
                                        y_align: Clutter.ActorAlign.END, visible: false});
        this._robot.add_child(new St.Icon({
            gicon: Gio.icon_new_for_string(GLib.build_filenamev(
                [this._percorso, 'icons', 'fw-robot.svg'])),
            icon_size: Math.round(misure.fumetto * 0.45)}));
        this._robotConto = new St.Label({style_class: 'fw-fumetto-robot-conto',
                                         y_align: Clutter.ActorAlign.CENTER});
        this._robot.add_child(this._robotConto);
        // Posizioni calcolate, non allineamenti: in un BinLayout il
        // contatore finiva in mezzo alla faccia (visto nella shell di prova).
        const tondo = new St.Widget();
        this._faccia = new St.Icon({style_class: 'fw-fumetto-faccia', icon_size: misure.fumetto,
                                    reactive: true, track_hover: true});
        this._faccia.connect('button-press-event', (_a, e) => this._premi(e));
        this._faccia.connect('motion-event', (_a, e) => this._muovi(e));
        this._faccia.connect('button-release-event', (_a, e) => this._rilascia(e));
        this._conto = new St.Label({style_class: 'fw-fumetto-conto', visible: false});
        tondo.add_child(this._faccia);
        tondo.add_child(this._conto);
        sotto.add_child(this._robot);
        sotto.add_child(tondo);

        this._carta.add_child(this._nuvola);
        this._carta.add_child(this._coda);
        this._carta.add_child(sotto);
        this._esterno.add_child(this._carta);
        Main.layoutManager.addChrome(this._esterno, {trackFullscreen: true});
    }

    _smonta() {
        this._esterno?.destroy();
        this._esterno = null;
        this._carta = null;
    }

    _riga(a) {
        const sel = a.id === this._id;
        const riga = new St.BoxLayout({style_class: 'fw-fumetto-riga' +
                                           (sel ? ' fw-fumetto-sel' : ''),
                                       x_expand: true});
        const corpo = new St.Button({style_class: 'fw-fumetto-corpo', x_expand: true,
                                     can_focus: true});
        const dentro = new St.BoxLayout({style_class: 'fw-fumetto-dentro', x_expand: true});
        dentro.add_child(new St.Widget({style_class: `fw-fumetto-pallino fw-fumetto-pallino-${a.stato}`,
                                        y_align: Clutter.ActorAlign.CENTER}));
        const testi = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
                                        x_expand: true});
        testi.add_child(new St.Label({text: a.progetto, style_class: 'fw-fumetto-titolo'}));
        testi.add_child(new St.Label({text: a.testo, style_class: 'fw-fumetto-testo'}));
        dentro.add_child(testi);
        corpo.set_child(dentro);
        // Un clic evidenzia; sulla riga già evidenziata porta al terminale,
        // come la faccina.
        corpo.connect('clicked', () => (sel ? this._apri() : this._evidenzia(a.id)));
        const chiudi = new St.Button({style_class: 'fw-fumetto-chiudi',
                                      y_align: Clutter.ActorAlign.CENTER,
                                      child: new St.Icon({icon_name: 'window-close-symbolic',
                                                          icon_size: 12})});
        chiudi.connect('clicked', () => this._togli(a.id));
        riga.add_child(corpo);
        riga.add_child(chiudi);
        return riga;
    }

    _disegnaCoda(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const sel = this._avvisi.find(a => a.id === this._id);
        const colore = COLORI[sel?.stato] ?? COLORI.finito;
        // Dal bordo della nuvola verso il basso a destra, dove sta la faccina.
        cr.moveTo(w * 0.1, 0);
        cr.lineTo(w * 0.75, h - 1);
        cr.lineTo(w * 0.85, 0);
        cr.closePath();
        cr.setSourceRGB(...FONDO.map(c => c / 255));
        cr.fill();
        cr.moveTo(w * 0.1, 3);
        cr.lineTo(w * 0.75, h - 1);
        cr.lineTo(w * 0.85, 3);
        cr.setSourceRGB(...colore.map(c => c / 255));
        cr.setLineWidth(2.5);
        cr.setLineJoin(1);       // ROUND
        cr.stroke();
        cr.$dispose();
    }

    /* ---------------------------------------------------- mostra, ritira --- */

    /* Rifà la mascotte dall'elenco. Senza avvisi si ritira; «sempre
       visibile», resta senza nuvoletta, con la faccia dello stato più urgente
       fra tutte le sessioni — la stessa della barra. */
    _disegna() {
        this._riprogrammaScadenza();
        const sel = this._avvisi.find(a => a.id === this._id);
        if (!sel && !this._sempre()) {
            this._firma = null;
            this._ritira(true);
            return;
        }
        const stato = sel?.stato ?? piuUrgente(this._sessioni.map(x => x.stato)) ?? 'dorme';
        const aiutanti = sel
            ? this._sessioni.find(x => x.id === sel.id)?.aiutanti ?? 0
            : this._sessioni.reduce((n, x) => n + x.aiutanti, 0);
        // Gli eventi arrivano a raffica mentre Claude lavora: si ridisegna
        // solo quando cambia qualcosa che si vede.
        const firma = JSON.stringify([this._avvisi.map(a => [a.id, a.stato, a.testo]),
                                      this._id, stato, aiutanti]);
        if (firma === this._firma && this._carta?.visible)
            return;
        this._firma = firma;
        if (!this._esterno)
            this._monta();
        const nuova = !this._carta.visible;
        this._nuvola.visible = this._coda.visible = !!sel;

        this._nuvola.destroy_all_children();
        for (const a of this._avvisi.slice(0, MAX_RIGHE))
            this._nuvola.add_child(this._riga(a));
        const altri = this._avvisi.length - MAX_RIGHE;
        if (altri > 0) {
            this._nuvola.add_child(new St.Label({
                text: altri === 1 ? '+1 altro' : `+${altri} altri`,
                style_class: 'fw-fumetto-altri'}));
        }

        // Lo stato evidenziato sulla carta: ne prendono il colore il bordo
        // della nuvola e il disco della faccina.
        for (const st of ORDINE_STATI)
            this._carta.remove_style_class_name(`fw-fumetto-${st}`);
        this._carta.add_style_class_name(`fw-fumetto-${stato}`);
        this._faccia.gicon = Gio.icon_new_for_string(GLib.build_filenamev(
            [this._percorso, 'icons', `${iconaStato(stato)}.svg`]));
        this._conto.text = String(this._avvisi.length);
        this._conto.visible = this._avvisi.length > 1;
        // In alto a destra sul disco, appena sporgente.
        const [, lato] = this._faccia.get_preferred_width(-1);
        const [, largo] = this._conto.get_preferred_width(-1);
        this._conto.set_position(Math.round(lato - largo + 4), -4);
        this._robot.visible = aiutanti > 0;
        this._robotConto.text = aiutanti > 1 ? `×${aiutanti}` : '';
        this._coda.queue_repaint();

        this._carta.show();
        this._colloca();
        if (nuova) {
            this._carta.remove_all_transitions();
            this._carta.opacity = 0;
            this._carta.translation_y = 14;
            this._carta.ease({opacity: 255, translation_y: 0, duration: 260,
                              mode: Clutter.AnimationMode.EASE_OUT_BACK});
        }
    }

    _ritira(animata) {
        this._lasciaPresa();
        this._firma = null;
        const carta = this._carta;
        if (!carta?.visible)
            return;
        carta.remove_all_transitions();
        if (!animata) {
            carta.hide();
            return;
        }
        carta.ease({opacity: 0, translation_y: 10, duration: 180,
                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                    onComplete: () => carta.hide()});
    }

    /* Un solo timer, alla scadenza più vicina: lì si pota l'elenco. */
    _riprogrammaScadenza() {
        this._fermaScadenza();
        const scadenze = this._avvisi.map(a => a.scade).filter(t => t > 0);
        if (!scadenze.length)
            return;
        const fra = Math.max(1, Math.min(...scadenze) - Math.floor(Date.now() / 1000));
        this._scadenza = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, fra, () => {
            this._scadenza = 0;
            this._pota();
            return GLib.SOURCE_REMOVE;
        });
    }

    _fermaScadenza() {
        if (this._scadenza) {
            GLib.source_remove(this._scadenza);
            this._scadenza = 0;
        }
    }

    /* Al posto ricordato, ricalcolato a ogni disegno: nel frattempo il
       testo, le righe, la grandezza o i monitor possono essere cambiati. */
    _colloca() {
        const lm = Main.layoutManager;
        const aree = lm.monitors.map((_m, i) => lm.getWorkAreaForMonitor(i));
        if (!aree.length)
            return;
        const [, w] = this._carta.get_preferred_width(-1);
        const [, h] = this._carta.get_preferred_height(w);
        const [x, y] = posizioneFumetto(this._settings.get_int('watchface-floating-x'),
                                        this._settings.get_int('watchface-floating-y'),
                                        w, h, aree, lm.primaryIndex);
        this._esterno.set_position(x, y);
    }

    /* Al terminale della sessione evidenziata, e l'avviso è letto: si
       toglie. Senza avvisi, a quella più urgente: le sessioni arrivano
       ordinate per urgenza. */
    _apri() {
        const id = this._id;
        const s = id ? this._sessioni.find(x => x.id === id) : this._sessioni[0];
        if (id)
            this._togli(id);
        if (s)
            this._suApri?.(s);
    }

    /* ------------------------------------------------------ trascinamento --- */

    _premi(evento) {
        if (evento.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        const [px, py] = evento.get_coords();
        this._lasciaPresa();
        this._presa = {px, py, x: this._esterno.x, y: this._esterno.y, mossa: false,
                       grab: global.stage.grab(this._faccia)};
        return Clutter.EVENT_STOP;
    }

    _muovi(evento) {
        const p = this._presa;
        if (!p)
            return Clutter.EVENT_PROPAGATE;
        const [px, py] = evento.get_coords();
        if (!p.mossa && Math.hypot(px - p.px, py - p.py) < SOGLIA_TRASCINA)
            return Clutter.EVENT_STOP;
        p.mossa = true;
        this._esterno.set_position(Math.round(p.x + px - p.px), Math.round(p.y + py - p.py));
        return Clutter.EVENT_STOP;
    }

    _rilascia(_evento) {
        const p = this._presa;
        if (!p)
            return Clutter.EVENT_PROPAGATE;
        this._lasciaPresa();
        if (!p.mossa) {
            this._apri();
            return Clutter.EVENT_STOP;
        }
        // Si ricorda l'angolo in basso a destra della faccina, poi si
        // ricolloca: un rilascio a metà fuori dallo schermo rientra.
        const [w, h] = this._carta.get_size();
        this._settings.set_int('watchface-floating-y', Math.round(this._esterno.y + h));
        this._settings.set_int('watchface-floating-x', Math.round(this._esterno.x + w));
        return Clutter.EVENT_STOP;
    }

    _lasciaPresa() {
        this._presa?.grab?.dismiss();
        this._presa = null;
    }
}
