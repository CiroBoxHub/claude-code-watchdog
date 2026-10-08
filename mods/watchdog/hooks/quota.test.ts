import { expect, test } from 'claude-code/testing'

import { contenuto, voci } from './quota'

/* La tabella dei casi prima del codice (regola 1 del progetto). Il motore
   parla di `five_hour` e `seven_day`, il pannello di `session` e `weekly`:
   qui si fissa la traduzione, perche' e' l'unico posto dove avviene. */
test('voci: la traduzione dal motore al formato del pannello', () => {
    expect(voci([{kind: 'five_hour', percentUsed: 35,
                  resetsAt: '2026-10-08T12:29:59Z'}])).toEqual([{
        tipo: 'session', gruppo: 'session', percento: 35,
        azzeramento: '2026-10-08T12:29:59Z', gravita: null, attivo: null}])

    expect(voci([{kind: 'seven_day', percentUsed: 37}])[0]).toEqual({
        tipo: 'weekly_all', gruppo: 'weekly', percento: 37,
        azzeramento: null, gravita: null, attivo: null})

    // Il tetto di spesa di un gateway non e' una finestra di quota: si scarta,
    // se no il pannello ne farebbe una barra che non sa misurare.
    expect(voci([{kind: 'spend_limit', percentUsed: 12}])).toEqual([])

    // Una percentuale con un decimale passa com'e': il motore la da' cosi'.
    expect(voci([{kind: 'five_hour', percentUsed: 23.5}])[0].percento).toBe(23.5)

    // Niente dato, dato di forma ignota, percentuale assente: niente voci.
    // Scrivere un elenco vuoto azzererebbe le barre del pannello.
    expect(voci(null)).toEqual([])
    expect(voci([])).toEqual([])
    expect(voci([{kind: 'five_hour'}])).toEqual([])
    expect(voci([{percentUsed: 9}])).toEqual([])

    // I due limiti insieme, nell'ordine in cui arrivano.
    const due = voci([{kind: 'seven_day', percentUsed: 37},
                      {kind: 'five_hour', percentUsed: 2}])
    expect(due.map(v => v.tipo)).toEqual(['weekly_all', 'session'])
})

test('contenuto: la forma che il pannello sa leggere', () => {
    const d = JSON.parse(contenuto(voci([{kind: 'five_hour', percentUsed: 7}]),
                                   '2026-10-08T10:00:00+00:00'))
    expect(d.letteIl).toBe('2026-10-08T10:00:00+00:00')
    expect(d.limiti[0].gruppo).toBe('session')
    expect(d.extra).toEqual({})
    // `fonte` dice chi l'ha scritto: senza, un limite che la CLI vedeva e il
    // mod no sembrerebbe sparito senza motivo.
    expect(d.fonte).toBe('mod')
})
