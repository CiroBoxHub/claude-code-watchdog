/* La quota, da dentro Claude Code.
 *
 * `collect-usage.py` accende una CLI intera ogni mezz'ora per avere due
 * percentuali: 2,57 s e 323 MB di picco, piu' una trascrizione-fantasma da
 * cestinare. Il motore invece ce le ha in casa e manda `session.measure`
 * quando si muovono. Qui si traduce il suo vocabolario nel nostro e basta.
 *
 * I nomi non coincidono: il motore dice `five_hour` e `seven_day`, la
 * trascrizione di /usage diceva `session` e `weekly_all`. Il pannello legge i
 * secondi, quindi si traduce qui, una volta, in una funzione che si prova.
 */

/** Un limite come lo da' il motore (SessionRateLimit). */
export type Limite = {
    kind?: string
    percentUsed?: number
    resetsAt?: string
}

/** Una voce di usage.json, come la scrive collect-usage.py. */
export type Voce = {
    tipo: string
    gruppo: string
    percento: number
    azzeramento: string | null
    gravita: null
    attivo: null
}

/* `spend_limit` non e' qui dentro di proposito: e' il tetto di spesa di un
   gateway, non una finestra di quota, e il pannello non ha dove metterlo.
   `gravita` e `attivo` li scriveva la CLI e il pannello non li guarda: si
   tengono nel formato, a null, per non cambiare la forma del file. */
const MAPPA: Record<string, {tipo: string, gruppo: string}> = {
    five_hour: {tipo: 'session', gruppo: 'session'},
    seven_day: {tipo: 'weekly_all', gruppo: 'weekly'},
}

/** Le voci per usage.json, o un elenco vuoto se non c'e' niente da dire. */
export function voci(limiti: Limite[] | null | undefined): Voce[] {
    if (!Array.isArray(limiti)) return []
    const fatte: Voce[] = []
    for (const l of limiti) {
        const m = MAPPA[l?.kind ?? '']
        if (!m || typeof l.percentUsed !== 'number') continue
        fatte.push({
            tipo: m.tipo,
            gruppo: m.gruppo,
            percento: l.percentUsed,
            azzeramento: l.resetsAt ?? null,
            gravita: null,
            attivo: null,
        })
    }
    return fatte
}

/** Il file come lo aspetta il pannello. `fonte` dice chi l'ha scritto: senza,
    un giorno non si saprebbe perche' manca un limite che la CLI vedeva. */
export function contenuto(voci: Voce[], adessoIso: string): string {
    return JSON.stringify({letteIl: adessoIso, limiti: voci, extra: {},
                           fonte: 'mod'}, null, 1)
}
