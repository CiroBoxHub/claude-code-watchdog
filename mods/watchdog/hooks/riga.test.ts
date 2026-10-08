import { expect, test } from 'claude-code/testing'

import { campi, fineTurno } from './riga'

const ORA = 1_800_000_000
const r = (...c: string[]) => c.join('\t') + '\n'

test('campi: la riga si spezza senza fondere i vuoti', () => {
    // Il pid vuoto e' il caso vero: Claude Code non sempre lo passa, e in bash
    // `read` con IFS=TAB fondeva i due separatori facendo slittare la riserva.
    expect(campi(r('Stop', '100', '0', '0', '/x', '', '1')))
        .toEqual(['Stop', '100', '0', '0', '/x', '', '1'])
    expect(campi('')).toEqual([])
    expect(campi(null)).toEqual([])
    // Solo la prima riga: il file ne ha una sola, ma un a capo di troppo non
    // deve diventare un campo.
    expect(campi('a\tb\n\n')).toEqual(['a', 'b'])
})

/* Tabella dei casi. La correzione tocca tre campi e non uno di piu': cwd,
   pid, riserva e il numero degli aiutanti sono dell'hook. */
test('fineTurno: la regola su tutti i casi noti', () => {
    // Il caso per cui esiste: interrotto con Esc, l'ultimo evento era un
    // PreToolUse, che `statoProprio` legge come «lavora» per un'ora.
    expect(fineTurno(r('PreToolUse', '100', '2', '3', '/x', '999', '1'), ORA))
        .toBe(r('Stop', String(ORA), '0', '3', '/x', '999', '1'))

    // Il pid vuoto resta vuoto, non sparisce e non slitta.
    expect(fineTurno(r('PostToolUse', '100', '0', '0', '/x', '', ''), ORA))
        .toBe(r('Stop', String(ORA), '0', '0', '/x', '', ''))

    // Una riga gia' ferma non si tocca: riscriverla con l'epoca di adesso la
    // farebbe sembrare appena finita ogni volta che un'altra sessione lavora.
    expect(fineTurno(r('Stop', '100', '0', '0', '/x', '9', ''), ORA)).toBe(null)
    expect(fineTurno(r('SessionStart', '100', '0', '0', '/x', '9', ''), ORA)).toBe(null)

    // Niente riga: non se ne inventa una. L'hook non ha ancora scritto.
    expect(fineTurno('', ORA)).toBe(null)
    expect(fineTurno(null, ORA)).toBe(null)
    expect(fineTurno('PreToolUse', ORA)).toBe(null)

    // Una riga corta del formato vecchio si completa a sette campi, se no il
    // pannello leggerebbe la riserva da un campo che non c'e'.
    expect(fineTurno(r('PreToolUse', '100', '0'), ORA))
        .toBe(r('Stop', String(ORA), '0', '', '', '', ''))

    // Campi in piu' di una versione futura: si tagliano a sette, non si
    // trascinano dentro la riserva.
    expect(campi(fineTurno(r('PreToolUse', '100', '0', '0', '/x', '9', '', 'extra'), ORA)))
        .toHaveLength(7)

    // Il /compact e la richiesta di permesso finiscono anche loro col turno.
    expect(campi(fineTurno(r('PreCompact', '100', '0', '0', '/x', '9', ''), ORA))[0])
        .toBe('Stop')
})

/* Il motivo per cui il turno e' finito cambia la faccina: un turno andato in
   errore deve restare il limone, non diventare il sorriso di «ha finito». */
test('fineTurno: il motivo si conserva', () => {
    const con = (motivo?: string) =>
        campi(fineTurno(r('PreToolUse', '100', '0', '0', '/x', '9', ''), ORA, motivo))[0]
    expect(con('error')).toBe('StopFailure')
    expect(con('aborted')).toBe('Stop')       // Esc: tocca a te, non e' un guasto
    expect(con('refusal')).toBe('Stop')
    expect(con('answer')).toBe('Stop')
    expect(con(undefined)).toBe('Stop')

    // E una riga che dice gia' «si e' inceppato» non si schiaccia su «Stop»:
    // quale delle due vinceva dipendeva da chi scriveva per ultimo.
    expect(fineTurno(r('StopFailure', '100', '0', '0', '/x', '9', ''), ORA)).toBe(null)
})
