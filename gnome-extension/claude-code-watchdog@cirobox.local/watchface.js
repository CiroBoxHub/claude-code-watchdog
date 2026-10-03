/* Watchface — cosa sta facendo Claude Code, adesso.
 *
 * L'hook `watchface-hook` scrive una riga per sessione in
 * $XDG_RUNTIME_DIR/claude-code-watchdog/watchface/, a ogni evento di Claude
 * Code. Qui si osserva quella cartella (inotify, niente letture a intervalli),
 * si ricava lo stato di ogni sessione e si avvisa chi la disegna.
 *
 * Le funzioni in cima non dipendono da GNOME: prova-js.sh le estrae da questo
 * file e le esegue con gjs. La classe in fondo è la parte che vive nella shell.
 */

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

export {leggiRigaWatchface, statoSessione, piuUrgente, iconaStato, testoStato,
        ORDINE_STATI, Watchface};

/* Dal più urgente al più tranquillo: con più sessioni vince il primo. */
const ORDINE_STATI = ['aspetta', 'errore', 'lavora', 'finito', 'dorme'];

/* «evento \t epoca \t fallimenti \t aiutanti \t cwd», come la scrive
   watchface-hook. Una riga vuota o storta torna null: il file può essere
   letto nell'istante in cui l'hook lo sta riscrivendo. */
function leggiRigaWatchface(testo) {
    const riga = (testo ?? '').split('\n')[0];
    const campi = riga.split('\t');
    if (campi.length < 5 || !/^[A-Za-z]+$/.test(campi[0]))
        return null;
    const numero = x => (/^\d+$/.test(x) ? parseInt(x, 10) : 0);
    // La cartella arriva com'era nel JSON di Claude Code, con le sequenze di
    // escape: si decodifica come una stringa JSON, e se non lo è si tiene
    // così com'è invece di perdere la riga.
    let cwd = campi.slice(4).join('\t');
    try {
        cwd = JSON.parse(`"${cwd}"`);
    } catch (e) {
        // resta grezza
    }
    return {evento: campi[0], epoca: numero(campi[1]),
            fallimenti: numero(campi[2]), aiutanti: numero(campi[3]), cwd};
}

/* Lo stato di una sessione dal suo ultimo evento e da quanto è vecchio.
   Le scadenze esistono perché una sessione può morire senza SessionEnd —
   terminale chiuso, macchina sospesa — e non deve restare «al lavoro» per
   sempre. */
function statoSessione(s, adesso) {
    if (!s)
        return null;
    const eta = adesso - s.epoca;
    const ORA = 3600;
    if (s.evento === 'StopFailure')
        return eta < ORA ? 'errore' : 'dorme';
    // Prima dei fallimenti: una richiesta di permesso dopo tre errori di fila
    // vuole comunque una risposta, ed è quella che conta.
    if (s.evento === 'PermissionRequest' || s.evento === 'Notification')
        return eta < 6 * ORA ? 'aspetta' : 'dorme';
    if (s.fallimenti >= 3)
        return eta < ORA ? 'errore' : 'dorme';
    if (s.evento === 'Stop')
        return eta < 600 ? 'finito' : 'dorme';
    if (s.evento === 'SessionStart')
        return 'dorme';
    return eta < 2 * ORA ? 'lavora' : 'dorme';
}

function piuUrgente(stati) {
    for (const s of ORDINE_STATI) {
        if (stati.includes(s))
            return s;
    }
    return null;
}

/* ------------------------------------------------------------ in shell --- */

const CARTELLA = GLib.build_filenamev([GLib.get_user_runtime_dir(),
                                       'claude-code-watchdog', 'watchface']);
/* Una sessione più vecchia di così non si mostra: è finita senza dirlo. */
const VISIBILE_S = 12 * 3600;
/* Un turno più corto di così non merita una notifica a fine lavoro: era una
   risposta veloce, e l'hai vista arrivare. */
const TURNO_LUNGO_S = 30;

const TESTI = {
    aspetta: 'aspetta te',
    errore: 'si è inceppato',
    lavora: 'sta lavorando',
    finito: 'ha finito',
    dorme: 'aperta',
};

class Watchface {
    /* `suCambio` si chiama quando cambia qualcosa da disegnare. Le notifiche
       le decide `notifiche()`, letto ogni volta: l'utente può spegnerle senza
       riavviare niente. */
    constructor({percorsoEstensione, suCambio, notifiche, terminali}) {
        this._percorso = percorsoEstensione;
        this._suCambio = suCambio;
        this._notifiche = notifiche;
        this._terminali = terminali ?? [];
        this._sessioni = [];
        this._statiPrima = null;     // null: la prima lettura non notifica
        this._lavoraDa = new Map();
        this._monitor = null;
        this._idMonitor = 0;
        this._attesa = 0;
        this._orologio = 0;
        this._fonte = null;
    }

    avvia() {
        try {
            GLib.mkdir_with_parents(CARTELLA, 0o700);
            this._monitor = Gio.File.new_for_path(CARTELLA)
                .monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._idMonitor = this._monitor.connect('changed', () => this._programma());
        } catch (e) {
            logError(e, 'claude-code-watchdog: cartella di Watchface non osservabile');
        }
        this._rileggi();
    }

    ferma() {
        if (this._monitor) {
            if (this._idMonitor)
                this._monitor.disconnect(this._idMonitor);
            this._monitor.cancel();
            this._monitor = null;
        }
        for (const t of ['_attesa', '_orologio']) {
            if (this[t]) {
                GLib.source_remove(this[t]);
                this[t] = 0;
            }
        }
        this._fonte?.destroy();
        this._fonte = null;
    }

    get sessioni() {
        return this._sessioni;
    }

    get stato() {
        return piuUrgente(this._sessioni.map(s => s.stato));
    }

    /* Un evento ne porta altri a raffica (Pre, Post, Pre…): si aspetta un
       attimo e si legge una volta sola. */
    _programma() {
        if (this._attesa)
            return;
        this._attesa = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._attesa = 0;
            this._rileggi();
            return GLib.SOURCE_REMOVE;
        });
    }

    _rileggi() {
        const adesso = Math.floor(Date.now() / 1000);
        const sessioni = [];
        try {
            const dir = Gio.File.new_for_path(CARTELLA);
            const elenco = dir.enumerate_children('standard::name',
                                                  Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = elenco.next_file(null))) {
                const id = info.get_name();
                let testo = '';
                try {
                    const [, dati] = GLib.file_get_contents(
                        GLib.build_filenamev([CARTELLA, id]));
                    testo = new TextDecoder().decode(dati);
                } catch (e) {
                    continue;              // sparito fra l'elenco e la lettura
                }
                const s = leggiRigaWatchface(testo);
                if (!s || adesso - s.epoca > VISIBILE_S)
                    continue;
                sessioni.push({id, ...s, stato: statoSessione(s, adesso),
                               progetto: GLib.path_get_basename(s.cwd || '?')});
            }
            elenco.close(null);
        } catch (e) {
            // La cartella non c'è ancora: nessuna sessione, non è un errore.
        }
        sessioni.sort((a, b) => ORDINE_STATI.indexOf(a.stato) -
                                ORDINE_STATI.indexOf(b.stato) || b.epoca - a.epoca);
        this._avvisa(sessioni, adesso);
        this._sessioni = sessioni;
        this._riprogrammaOrologio();
        this._suCambio?.();
    }

    /* Gli stati cambiano anche col tempo («finito» torna «dorme» dopo dieci
       minuti) senza che arrivi nessun evento: un controllo al minuto, solo
       finché c'è qualcosa che può cambiare. */
    _riprogrammaOrologio() {
        const serve = this._sessioni.some(s => s.stato !== 'dorme');
        if (serve && !this._orologio) {
            this._orologio = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 60, () => {
                this._orologio = 0;
                this._rileggi();
                return GLib.SOURCE_REMOVE;
            });
        } else if (!serve && this._orologio) {
            GLib.source_remove(this._orologio);
            this._orologio = 0;
        }
    }

    _avvisa(sessioni, adesso) {
        const prima = this._statiPrima;
        this._statiPrima = new Map(sessioni.map(s => [s.id, s.stato]));
        for (const s of sessioni) {
            const vecchio = prima?.get(s.id);
            if (s.stato === 'lavora' && vecchio !== 'lavora')
                this._lavoraDa.set(s.id, adesso);
            if (!prima || vecchio === s.stato)
                continue;
            if (s.stato === 'aspetta') {
                this._notifica(s, 'Claude aspetta te',
                               s.evento === 'PermissionRequest'
                                   ? `${s.progetto}: chiede un permesso`
                                   : `${s.progetto}: aspetta una risposta`);
            } else if (s.stato === 'errore') {
                this._notifica(s, 'Claude si è inceppato',
                               s.evento === 'StopFailure'
                                   ? `${s.progetto}: la sessione si è fermata per un errore`
                                   : `${s.progetto}: ${s.fallimenti} errori di fila`);
            } else if (s.stato === 'finito' && vecchio === 'lavora') {
                const da = this._lavoraDa.get(s.id);
                if (da !== undefined && adesso - da >= TURNO_LUNGO_S)
                    this._notifica(s, 'Claude ha finito', s.progetto);
            }
        }
        for (const id of [...this._lavoraDa.keys()]) {
            if (!this._statiPrima.has(id))
                this._lavoraDa.delete(id);
        }
    }

    /* Se stai già guardando un terminale la notifica è rumore: l'hai davanti. */
    _terminaleInPrimoPiano() {
        const finestra = global.display.focus_window;
        if (!finestra)
            return false;
        const app = Shell.WindowTracker.get_default().get_window_app(finestra);
        return this._terminali.includes(app?.get_id());
    }

    _notifica(s, titolo, testo) {
        if (!this._notifiche?.() || this._terminaleInPrimoPiano())
            return;
        try {
            const icona = Gio.icon_new_for_string(GLib.build_filenamev(
                [this._percorso, 'icons', `${iconaStato(s.stato)}.svg`]));
            if (!this._fonte) {
                this._fonte = new MessageTray.Source({title: 'Watchface', icon: icona});
                this._fonte.connect('destroy', () => {
                    this._fonte = null;
                });
                Main.messageTray.add(this._fonte);
            }
            const n = new MessageTray.Notification({source: this._fonte, title: titolo,
                                                    body: testo, gicon: icona});
            this._fonte.addNotification(n);
        } catch (e) {
            logError(e, 'claude-code-watchdog: notifica di Watchface non riuscita');
        }
    }
}

/* L'icona di uno stato: il limone per gli errori, la faccina per il resto. */
function iconaStato(stato) {
    if (stato === 'errore')
        return 'fw-limone';
    return `fw-faccina-${stato ?? 'dorme'}`;
}

function testoStato(s) {
    if (s.stato === 'aspetta' && s.evento === 'PermissionRequest')
        return 'chiede un permesso';
    return TESTI[s.stato] ?? s.stato;
}
