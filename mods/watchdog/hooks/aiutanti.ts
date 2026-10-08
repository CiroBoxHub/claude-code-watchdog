/* Gli aiutanti: il mod non rifa' il conto, lo corregge.
 *
 * L'hook tiene `<sessione>.aiutanti`, una riga «id <TAB> epoca» per aiutante
 * avviato, e li fa scadere a un'ora perche' lo `SubagentStop` di un aiutante
 * in background finisce nel file del processo figlio e non in quello del
 * padre: il 2026-10-06 una sessione ne mostrava sette, fermi da quattro ore.
 *
 * Il mod gira dentro il ciclo del padre e puo' chiedere `$.agent.list()`, che
 * dice per ogni agente dove sta il suo ciclo. Quindi:
 * - un id che il motore dice finito si toglie subito, non dopo un'ora;
 * - un id che il motore dice vivo tiene l'epoca fresca, cosi' un aiutante che
 *   lavora davvero due ore non smette di essere contato (era il prezzo
 *   dichiarato della scadenza);
 * - un id vivo che manca dall'elenco si aggiunge;
 * - un id che il motore non conosce **non si tocca**: resta dell'hook, con la
 *   sua scadenza. Correggere non vuol dire sostituire.
 *
 * Due scrittori sullo stesso file, e il mod non prende il lock dell'hook:
 * scrivono entrambi su temporaneo e rinomina, quindi nessun lettore vede un
 * file a meta', e un aggiornamento perso torna al giro dopo (dieci secondi).
 * Prendere il lock vorrebbe dire un fork per giro, che e' il costo che si sta
 * togliendo.
 */

/** Un agente come lo da' `$.agent.list()` (AgentInfo). */
export type Agente = { id?: string, status?: string }

/* AgentStatus: pending (non partito), running (in un turno), waiting (su
   lavoro in background che possiede), idle (fra due turni, finche' un
   messaggio lo sveglia), poi completed, failed, killed.
   `idle` non conta: e' un compagno di squadra fra due turni, e l'hook non lo
   contava nemmeno — un aiutante che aspetta manda SubagentStop. */
const VIVI = new Set(['pending', 'running', 'waiting'])
const FINITI = new Set(['completed', 'failed', 'killed'])

/** Le righe del file, come testo, da «id <TAB> epoca» per riga. */
export function leggi(testo: string | null | undefined): [string, string][] {
    const righe: [string, string][] = []
    for (const riga of (testo ?? '').split('\n')) {
        if (!riga) continue
        const i = riga.indexOf('\t')
        if (i < 0) continue              // formato vecchio, senza epoca
        righe.push([riga.slice(0, i), riga.slice(i + 1)])
    }
    return righe
}

/** L'elenco corretto: `null` quando non c'e' niente da cambiare, cosi' chi
    chiama non riscrive il file per nulla. */
export function correggi(testo: string | null | undefined,
                         agenti: Agente[] | null | undefined,
                         adesso: number): string | null {
    const prima = leggi(testo)
    const vivi = new Map<string, true>()
    const finiti = new Set<string>()
    for (const a of Array.isArray(agenti) ? agenti : []) {
        if (!a?.id) continue
        if (VIVI.has(a.status ?? '')) vivi.set(a.id, true)
        else if (FINITI.has(a.status ?? '')) finiti.add(a.id)
        // Uno stato che non conosciamo non e' ne' vivo ne' finito: si lascia
        // stare, come un id che il motore non nomina.
    }

    const dopo: [string, string][] = []
    const visti = new Set<string>()
    for (const [id, epoca] of prima) {
        if (visti.has(id)) continue      // doppioni: uno basta
        visti.add(id)
        if (finiti.has(id)) continue
        dopo.push([id, vivi.has(id) ? String(adesso) : epoca])
    }
    for (const id of vivi.keys()) {
        if (visti.has(id)) continue
        visti.add(id)
        dopo.push([id, String(adesso)])
    }

    const nuovo = dopo.map(([id, e]) => `${id}\t${e}`).join('\n')
    const vecchio = prima.map(([id, e]) => `${id}\t${e}`).join('\n')
    if (nuovo === vecchio) return null
    return nuovo ? nuovo + '\n' : ''
}
