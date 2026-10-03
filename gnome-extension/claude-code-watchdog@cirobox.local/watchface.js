// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 CiroBoxHub

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

export {leggiRigaWatchface, statoSessione, approvazioneVista, piuUrgente, iconaStato, testoStato,
        misureMascotte, genitoreDaStat, catenaPid, canaleAvviso, ORDINE_STATI, Watchface};

/* Dal più urgente al più tranquillo: con più sessioni vince il primo. */
const ORDINE_STATI = ['aspetta', 'errore', 'lavora', 'finito', 'dorme'];

/* «evento \t epoca \t fallimenti \t aiutanti \t cwd \t pid», come la scrive
   watchface-hook (il pid manca nelle righe delle versioni precedenti). Una
   riga vuota o storta torna null: il file può essere letto nell'istante in
   cui l'hook lo sta riscrivendo. L'hook toglie le tabulazioni dalla cartella,
   quindi i campi non si confondono. */
function leggiRigaWatchface(testo) {
    const riga = (testo ?? '').split('\n')[0];
    const campi = riga.split('\t');
    if (campi.length < 5 || !/^[A-Za-z]+$/.test(campi[0]))
        return null;
    const numero = x => (/^\d+$/.test(x) ? parseInt(x, 10) : 0);
    // La cartella arriva com'era nel JSON di Claude Code, con le sequenze di
    // escape: si decodifica come una stringa JSON, e se non lo è si tiene
    // così com'è invece di perdere la riga.
    let cwd = campi[4];
    try {
        cwd = JSON.parse(`"${cwd}"`);
    } catch (e) {
        // resta grezza
    }
    return {evento: campi[0], epoca: numero(campi[1]),
            fallimenti: numero(campi[2]), aiutanti: numero(campi[3]), cwd,
            pid: numero(campi[5] ?? '')};
}

/* Il genitore di un processo da /proc/<pid>/stat. Il nome del programma sta
   fra parentesi e può contenere spazi e parentesi: si conta dall'ultima. */
function genitoreDaStat(testo) {
    const fine = (testo ?? '').lastIndexOf(')');
    if (fine < 0)
        return 0;
    const campi = testo.slice(fine + 2).split(' ');
    return /^\d+$/.test(campi[1] ?? '') ? parseInt(campi[1], 10) : 0;
}

/* Il processo e i suoi antenati, dal più vicino, fino a init escluso. Un tetto
   ai passi: un ciclo nei dati letti non deve bloccare la shell. */
function catenaPid(pid, genitore, massimo = 40) {
    const catena = [];
    for (let p = pid; p > 1 && catena.length < massimo && !catena.includes(p); p = genitore(p))
        catena.push(p);
    return catena;
}

/* Lo stato di una sessione dal suo ultimo evento e da quanto è vecchio.
   Le scadenze esistono perché non sempre arriva un evento che chiude: una
   sessione può morire senza SessionEnd (terminale chiuso, macchina sospesa), e
   Claude Code non manda Stop quando interrompi con Esc o neghi un permesso
   (revisione del 2026-10-03). Resta il silenzio, e lo si legge così: uno
   strumento in esecuzione può durare a lungo — una compilazione — mentre fra
   un passo e l'altro Claude non tace per dieci minuti. */
function statoSessione(s, adesso) {
    if (!s)
        return null;
    const eta = adesso - s.epoca;
    const ORA = 3600;
    if (s.evento === 'StopFailure')
        return eta < ORA ? 'errore' : 'dorme';
    // Un permesso già dato: il comando gira. Claude Code non manda nessun
    // evento quando approvi — il prossimo è PostToolUse, a comando finito —
    // e l'approvazione la vede la sorveglianza dei processi (`approvato`).
    if (s.evento === 'PermissionRequest' && s.approvato)
        return eta < ORA ? 'lavora' : 'dorme';
    // Prima dei fallimenti: una richiesta di permesso dopo tre errori di fila
    // vuole comunque una risposta, ed è quella che conta.
    if (s.evento === 'PermissionRequest' || s.evento === 'Notification')
        return eta < ORA ? 'aspetta' : 'dorme';
    if (s.fallimenti >= 3)
        return eta < ORA ? 'errore' : 'dorme';
    if (s.evento === 'Stop')
        return eta < 600 ? 'finito' : 'dorme';
    if (s.evento === 'SessionStart')
        return 'dorme';
    if (s.evento === 'PreToolUse')
        return eta < ORA ? 'lavora' : 'dorme';
    return eta < 600 ? 'lavora' : 'dorme';
}

/* Hai approvato il permesso? Quando lo approvi, Claude avvia il comando: un
   processo figlio nuovo. `base` sono i figli che c'erano alla richiesta,
   `attuali` quelli di adesso ([pid, riga di comando]), `contati` quante
   letture di fila ha passato ogni figlio nuovo. Due letture, non una: un
   hook che Claude lancia nel frattempo è anche lui un figlio, ma dura un
   attimo. Il nostro hook si riconosce e non conta. Misurato il 2026-10-04:
   approvazione alle 00:39:01, figlio nuovo alla stessa ora, PostToolUse
   undici secondi dopo. */
function approvazioneVista(base, attuali, contati) {
    const ora = new Map();
    for (const [pid, comando] of attuali) {
        if (base.includes(pid) || comando.includes('watchface-hook'))
            continue;
        ora.set(pid, (contati.get(pid) ?? 0) + 1);
    }
    return {contati: ora, approvato: [...ora.values()].some(n => n >= 2)};
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

/* I figli di un processo, con la loro riga di comando: [[pid, comando]].
   Linux li elenca per thread, in /proc/<pid>/task/<tid>/children, e Claude
   ne ha parecchi. Un processo finito, o /proc illeggibile: nessun figlio. */
function figliDi(pid) {
    const figli = [];
    const leggi = percorso => {
        try {
            return new TextDecoder().decode(GLib.file_get_contents(percorso)[1]);
        } catch (e) {
            return '';
        }
    };
    try {
        const elenco = Gio.File.new_for_path(`/proc/${pid}/task`)
            .enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = elenco.next_file(null))) {
            for (const f of leggi(`/proc/${pid}/task/${info.get_name()}/children`).split(/\s+/)) {
                if (/^\d+$/.test(f))
                    figli.push([parseInt(f, 10), leggi(`/proc/${f}/cmdline`).replace(/\0/g, ' ')]);
            }
        }
        elenco.close(null);
    } catch (e) {
        // processo finito
    }
    return figli;
}

const TESTI = {
    aspetta: 'aspetta te',
    errore: 'si è inceppato',
    lavora: 'sta lavorando',
    finito: 'ha finito',
    dorme: 'aperta',
};

class Watchface {
    /* `suCambio` si chiama quando cambia qualcosa da disegnare. Come avvisare
       lo dice `avvisi()` — «notifiche», «mascotte» o «nessuno» — letto ogni
       volta: l'utente può cambiarlo senza riavviare niente. */
    constructor({percorsoEstensione, suCambio, avvisi, terminali, suApri, suAvviso}) {
        this._percorso = percorsoEstensione;
        this._suCambio = suCambio;
        this._suApri = suApri;
        this._suAvviso = suAvviso;
        this._avvisi = avvisi;
        this._terminali = terminali ?? [];
        this._sessioni = [];
        this._statiPrima = null;     // null: la prima lettura non notifica
        this._lavoraDa = new Map();
        this._monitor = null;
        this._idMonitor = 0;
        this._attesa = 0;
        this._orologio = 0;
        this._fonte = null;
        // Permessi in attesa sorvegliati: id → {epoca, base, contati}; e
        // quelli visti approvare: id → epoca della richiesta.
        this._permessi = new Map();
        this._approvati = new Map();
        this._sorveglianza = 0;
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
        for (const t of ['_attesa', '_orologio', '_sorveglianza']) {
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
                // Gli id hanno solo lettere, cifre e trattini: un punto vuol
                // dire lock, elenco degli aiutanti o temporaneo dell'hook.
                if (id.includes('.'))
                    continue;
                let testo = '';
                try {
                    const [, dati] = GLib.file_get_contents(
                        GLib.build_filenamev([CARTELLA, id]));
                    testo = new TextDecoder().decode(dati);
                } catch (e) {
                    continue;              // sparito fra l'elenco e la lettura
                }
                const s = leggiRigaWatchface(testo);
                if (!s)
                    continue;
                if (adesso - s.epoca > VISIBILE_S) {
                    // Finita senza SessionEnd: il file si toglie, se no lo si
                    // rilegge a ogni evento di ogni altra sessione.
                    for (const nome of [id, `${id}.aiutanti`, `${id}.lock`])
                        GLib.unlink(GLib.build_filenamev([CARTELLA, nome]));
                    continue;
                }
                s.approvato = s.evento === 'PermissionRequest' &&
                              this._approvati.get(id) === s.epoca;
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
        this._riprogrammaSorveglianza();
        this._suCambio?.();
    }

    /* Chi aspetta un permesso, e ha il pid di Claude, si sorveglia una volta
       al secondo finché la richiesta resta quella: appena compare il comando
       approvato, la faccina passa a «lavora» senza aspettare che finisca. Una
       richiesta nuova (epoca diversa) riparte da capo. */
    _riprogrammaSorveglianza() {
        const inAttesa = this._sessioni.filter(
            s => s.evento === 'PermissionRequest' && s.stato === 'aspetta' && s.pid > 0);
        for (const id of [...this._permessi.keys()]) {
            if (!inAttesa.some(s => s.id === id && s.epoca === this._permessi.get(id).epoca))
                this._permessi.delete(id);
        }
        for (const id of [...this._approvati.keys()]) {
            if (!this._sessioni.some(s => s.id === id && s.epoca === this._approvati.get(id)))
                this._approvati.delete(id);
        }
        for (const s of inAttesa) {
            if (!this._permessi.has(s.id)) {
                this._permessi.set(s.id, {epoca: s.epoca, pid: s.pid,
                                          base: figliDi(s.pid).map(([p]) => p),
                                          contati: new Map()});
            }
        }
        if (this._permessi.size && !this._sorveglianza) {
            this._sorveglianza = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
                let visto = false;
                for (const [id, p] of this._permessi) {
                    const esito = approvazioneVista(p.base, figliDi(p.pid), p.contati);
                    p.contati = esito.contati;
                    if (esito.approvato) {
                        this._approvati.set(id, p.epoca);
                        visto = true;
                    }
                }
                if (visto) {
                    this._sorveglianza = 0;
                    this._rileggi();
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            });
        } else if (!this._permessi.size && this._sorveglianza) {
            GLib.source_remove(this._sorveglianza);
            this._sorveglianza = 0;
        }
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
                this._avviso(s, 'Claude aspetta te',
                             s.evento === 'PermissionRequest'
                                 ? 'chiede un permesso' : 'aspetta una risposta');
            } else if (s.stato === 'errore') {
                this._avviso(s, 'Claude si è inceppato',
                             s.evento === 'StopFailure'
                                 ? 'si è fermata per un errore'
                                 : `${s.fallimenti} errori di fila`);
            } else if (s.stato === 'finito' && vecchio === 'lavora') {
                const da = this._lavoraDa.get(s.id);
                const durata = da === undefined ? 0 : adesso - da;
                if (durata >= TURNO_LUNGO_S) {
                    this._avviso(s, 'Claude ha finito', durata < 90
                        ? 'ha finito' : `ha finito, dopo ${Math.round(durata / 60)} min`);
                }
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

    /* Qualcosa da dire su una sessione: con la notifica o con la mascotte
       fluttuante, una sola delle due — erano un doppione, e l'utente sceglie.
       Stessa regola per entrambe: se stai guardando il terminale, niente. */
    _avviso(s, titolo, breve) {
        const canale = canaleAvviso(this._avvisi?.(), this._terminaleInPrimoPiano());
        if (canale === 'notifica')
            this._notifica(s, titolo, `${s.progetto}: ${breve}`);
        if (canale !== 'mascotte')
            return;
        try {
            this._suAvviso?.(s, breve);
        } catch (e) {
            logError(e, 'claude-code-watchdog: mascotte fluttuante non riuscita');
        }
    }

    _notifica(s, titolo, testo) {
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
            // Un clic sulla notifica porta al terminale di quella sessione.
            n.connect('activated', () => this._suApri?.(s));
            this._fonte.addNotification(n);
        } catch (e) {
            logError(e, 'claude-code-watchdog: notifica di Watchface non riuscita');
        }
    }
}

/* Da dove passa un avviso: «notifica», «mascotte» o null. Uno solo dei due —
   erano un doppione — e nessuno se stai già guardando il terminale. Un valore
   sconosciuto vale come quello di serie, le notifiche. */
function canaleAvviso(come, terminaleDavanti) {
    if (terminaleDavanti || come === 'nessuno')
        return null;
    return come === 'mascotte' ? 'mascotte' : 'notifica';
}

/* L'icona di uno stato: il limone per gli errori, la faccina per il resto. */
function iconaStato(stato) {
    if (stato === 'errore')
        return 'fw-limone';
    return `fw-faccina-${stato ?? 'dorme'}`;
}

/* Pixel della faccina nella barra, nel popup, del robottino e della mascotte
   fluttuante, per ogni grandezza scelta nelle preferenze. La barra di GNOME è
   alta circa 32 px: oltre 24 la faccina tocca i bordi. A 16 è un puntino con
   la barba. */
const MISURE_MASCOTTE = {
    piccola: {barra: 18, popup: 26, robot: 18, fumetto: 80},
    media: {barra: 22, popup: 34, robot: 22, fumetto: 96},
    grande: {barra: 24, popup: 42, robot: 26, fumetto: 120},
};

function misureMascotte(taglia) {
    return MISURE_MASCOTTE[taglia] ?? MISURE_MASCOTTE.media;
}

function testoStato(s) {
    if (s.stato === 'aspetta' && s.evento === 'PermissionRequest')
        return 'chiede un permesso';
    return TESTI[s.stato] ?? s.stato;
}
