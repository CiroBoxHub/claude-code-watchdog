import { expect, test } from 'claude-code/testing'

import { correggi, leggi } from './aiutanti'

const ORA = 1_800_000_000

test('leggi: le righe «id TAB epoca», e quelle del formato vecchio', () => {
    expect(leggi('a\t100\nb\t200\n')).toEqual([['a', '100'], ['b', '200']])
    // Senza epoca e' il formato vecchio dell'hook: si butta.
    expect(leggi('a\nb\t200')).toEqual([['b', '200']])
    expect(leggi('')).toEqual([])
    expect(leggi(null)).toEqual([])
})

/* La tabella dei casi. Il mod **corregge** l'elenco dell'hook, non lo
   sostituisce: quello che il motore non nomina resta dov'era. */
test('correggi: la regola su tutti i casi noti', () => {
    // Niente da cambiare → null, cosi' il file non si riscrive per nulla.
    expect(correggi('a\t100\n', [{id: 'a', status: 'waiting'}], 100)).toBe(null)
    expect(correggi('', [], ORA)).toBe(null)

    // Finito: via subito, non dopo un'ora. È il difetto da cui si parte.
    expect(correggi('a\t100\nb\t100\n',
                    [{id: 'a', status: 'completed'}], ORA)).toBe('b\t100\n')
    for (const s of ['completed', 'failed', 'killed'])
        expect(correggi('a\t100\n', [{id: 'a', status: s}], ORA)).toBe('')

    // Vivo: l'epoca si rinfresca, cosi' un aiutante che lavora due ore non
    // smette di essere contato (era il prezzo dichiarato della scadenza).
    for (const s of ['pending', 'running', 'waiting'])
        expect(correggi('a\t100\n', [{id: 'a', status: s}], ORA))
            .toBe(`a\t${ORA}\n`)

    // Vivo e assente dall'elenco: si aggiunge.
    expect(correggi('', [{id: 'z', status: 'running'}], ORA)).toBe(`z\t${ORA}\n`)

    // `idle` e' un compagno fra due turni: non e' al lavoro, e l'hook non lo
    // contava (un aiutante che aspetta manda SubagentStop).
    expect(correggi('', [{id: 'i', status: 'idle'}], ORA)).toBe(null)
    expect(correggi('i\t100\n', [{id: 'i', status: 'idle'}], ORA)).toBe(null)

    // Un id che il motore non conosce non si tocca: e' dell'hook, con la sua
    // scadenza. Correggere non vuol dire sostituire.
    expect(correggi('x\t100\n', [{id: 'a', status: 'running'}], ORA))
        .toBe(`x\t100\na\t${ORA}\n`)

    // Uno stato che non conosciamo non e' ne' vivo ne' finito: si lascia.
    expect(correggi('a\t100\n', [{id: 'a', status: 'boh'}], ORA)).toBe(null)

    // Una voce senza id non deve diventare una riga: con un `status` vivo
    // finirebbe nel file come «undefined», e il pannello conterebbe un
    // aiutante che non esiste. La prova vuole lo stato vivo: con `completed`
    // passava anche senza la difesa (mutazione, 2026-10-08).
    expect(correggi('', [{status: 'running'}], ORA)).toBe(null)
    expect(correggi('a\t100\n', [{status: 'completed'}], ORA)).toBe(null)
    expect(correggi('a\t100\n', null, ORA)).toBe(null)

    // Un doppione nel file si riduce a uno solo.
    expect(correggi('a\t100\na\t100\n', [], ORA)).toBe('a\t100\n')
})
