/* La riga di stato: il mod la **corregge alla fine del turno**, che e'
 * l'unico momento in cui l'hook non riceve niente.
 *
 * Claude Code manda `Stop` quando risponde, ma **non manda niente quando il
 * turno finisce in un altro modo**: se lo interrompi con Esc, se neghi un
 * permesso e Claude si ferma, se il modello rifiuta, se la chiamata va in
 * errore. L'ultimo evento visto resta `PreToolUse` o `PostToolUse`, e
 * `statoProprio` li legge come «lavora» — per un'ora il primo, per dieci
 * minuti il secondo. Quindi la faccina dice «sta lavorando» mentre in realta'
 * sta aspettando te: e' la lentezza segnalata dall'uso il 2026-10-08.
 *
 * `turn.complete` scatta sempre, e `reason` dice perche': `answer`, `aborted`
 * (interrotto), `refusal`, `error`. Il mod scrive la riga come l'avrebbe
 * scritta l'hook: stesso evento, epoca adesso, fallimenti a zero. Tutto il
 * resto della riga **non si tocca** — cwd, pid, riserva e il numero degli
 * aiutanti sono dell'hook e lui li sa meglio.
 *
 * **Il motivo si conserva.** Una prima versione scriveva `Stop` per tutti e
 * quattro: un turno finito in errore diventava la faccina verde «ha finito»
 * invece del limone, e quale delle due vinceva dipendeva da quale scrittura
 * arrivava per ultima. Ora `error` scrive `StopFailure`, che e' l'evento che
 * Claude Code manda per la stessa cosa. Rilevato da /code-review il
 * 2026-10-08.
 *
 * Quando il turno finisce con una risposta, `Stop` arriva comunque: la riga
 * che scriviamo e' identica a quella che scrivera' lui, quindi scriverla non
 * fa danno e arriva prima.
 */

/** I sette campi della riga, spezzati a mano: `split` su TAB va bene qui
    perche' JavaScript non fonde i separatori vuoti come fa `read` in bash. */
export function campi(testo: string | null | undefined): string[] {
    const riga = (testo ?? '').split('\n')[0] ?? ''
    return riga === '' ? [] : riga.split('\t')
}

/* Gli eventi che dicono gia' «il turno e' finito»: riscriverli con l'epoca di
   adesso li farebbe sembrare appena finiti a ogni turno di un'altra sessione,
   e nel caso di StopFailure cancellerebbe l'errore. */
const FERMI = new Set(['Stop', 'StopFailure', 'SessionStart'])

/** La riga con l'evento di fine turno, o `null` se non c'e' niente da
    cambiare: nessuna riga, o una che gia' dice la stessa cosa. */
export function fineTurno(testo: string | null | undefined, adesso: number,
                          motivo?: string): string | null {
    const c = campi(testo)
    if (c.length < 2) return null              // niente riga, niente da correggere
    if (FERMI.has(c[0] ?? '')) return null
    const nuovo = [...c]
    while (nuovo.length < 7) nuovo.push('')
    nuovo[0] = motivo === 'error' ? 'StopFailure' : 'Stop'
    nuovo[1] = String(adesso)
    nuovo[2] = '0'                             // i fallimenti si azzerano, come fa l'hook
    return nuovo.slice(0, 7).join('\t') + '\n'
}
