import type { EngineInterface, Register } from 'claude-code'

import { correggi } from './aiutanti'
import { contenuto, voci } from './quota'

/* Watchface da dentro Claude Code.
 *
 * L'estensione GNOME guarda Claude Code da fuori: l'hook in bash scrive una
 * riga di stato per sessione, il pannello la legge. Funziona, ma due cose da
 * fuori non si vedono e si indovinano — quanta quota resta (una CLI intera
 * ogni mezz'ora) e quali aiutanti sono ancora al lavoro (gli id scadono a
 * un'ora perche' lo Stop finisce nel file del processo figlio).
 *
 * Questo mod sta dentro il ciclo e quelle due le sa. Scrive **gli stessi
 * file** dell'hook e di collect-usage.py, non dei suoi: il pannello non
 * cambia di una riga, e se il mod non c'e' si torna a prima.
 *
 * Non crea nessuna cartella. Quelle dei dati nascono 700 e i file 600 perche'
 * contengono i nomi dei progetti, cioe' dei clienti, e `$.fs.write` non sa
 * dare un modo: se la cartella non c'e' ancora, il mod sta zitto invece di
 * crearne una leggibile a tutti. Le creano il pannello e l'hook.
 */

const CADENZA_MS = 10_000
const DIR_STATO = 'claude-code-watchdog/watchface'
const DIR_DATI = 'claude-code-watchdog'

let sessione: string | null = null
let dirStato: string | null = null
let dirDati: string | null = null
let ultimiAiutanti: string | null = null
let ultimaQuota: string | null = null

/** Temporaneo e poi rinomina, come fanno l'hook e collect-usage.py: il
    pannello legge questi file **senza lock**, e fra il troncamento e la
    scrittura ne vedrebbe uno vuoto. Su `.aiutanti` quello costava un «Claude
    ha finito» falso (rilevato da /code-review il 2026-10-06).
    Un fork per cambiamento vero, non per giro: niente cambia, niente si
    scrive. `sh` riceve i percorsi come argomenti, non dentro il testo. */
async function scriviAtomico($: EngineInterface, dest: string, testo: string,
                             modo: string | null): Promise<boolean> {
    const tmp = `${dest}.mod.tmp`
    try {
        await $.fs.write(tmp, testo)
        const script = modo
            ? 'chmod "$1" "$2" && mv -f "$2" "$3"'
            : 'mv -f "$2" "$3"'
        const r = await $.process.run(
            ['sh', '-c', script, 'sh', modo ?? '600', tmp, dest])
        return r.exitCode === 0
    } catch {
        return false
    }
}

/** La quota in usage.json, nel formato di collect-usage.py. */
async function aggiornaQuota($: EngineInterface, limiti: unknown): Promise<void> {
  try {
    if (!dirDati) return
    const v = voci(limiti as never)
    if (!v.length) return                // niente dato: non si azzera il file
    const testo = contenuto(v, new Date().toISOString().replace(/\.\d+Z$/, '+00:00'))
    // Il confronto salta `letteIl`, che cambia sempre: se le percentuali sono
    // quelle di prima non si riscrive niente.
    const firma = JSON.stringify(v)
    if (firma === ultimaQuota) return
    if (await scriviAtomico($, `${dirDati}/usage.json`, testo, '600'))
        ultimaQuota = firma
  } catch { /* il pannello tiene il dato di prima */ }
}

/** L'elenco degli aiutanti, corretto con quello che il motore sa. */
async function aggiornaAiutanti($: EngineInterface): Promise<void> {
  try {
    if (!dirStato || !sessione) return
    const f = `${dirStato}/${sessione}.aiutanti`
    let testo = ''
    try {
        if (await $.fs.exists(f)) testo = await $.fs.read(f)
    } catch {
        return                           // sparito fra il controllo e la lettura
    }
    let agenti
    try {
        agenti = await $.agent.list()
    } catch {
        return                           // senza il motore non si corregge
    }
    const nuovo = correggi(testo, agenti, Math.floor(Date.now() / 1000))
    if (nuovo === null || nuovo === ultimiAiutanti) return
    if (await scriviAtomico($, f, nuovo, null)) ultimiAiutanti = nuovo
  } catch { /* resta l'elenco dell'hook, con la sua scadenza */ }
}

export const register: Register = on => {
    on('session.start', async ($, e, next) => {
        const esito = await next(e)
        // Solo le sessioni di una persona, la stessa regola dell'hook: quelle
        // avviate da un programma (`claude -p`, l'SDK) nessuno le guarda, e la
        // lettura della quota ne apriva una a ogni giro.
        if (!e.isInteractive) return esito
        try {
            sessione = await $.session.id()
            const run = await $.env.get('XDG_RUNTIME_DIR')
            const home = await $.env.get('HOME')
            const dati = await $.env.get('XDG_DATA_HOME')
            const base = run || null
            dirStato = base && (await $.fs.exists(`${base}/${DIR_STATO}`))
                ? `${base}/${DIR_STATO}` : null
            const radice = dati || (home ? `${home}/.local/share` : null)
            dirDati = radice && (await $.fs.exists(`${radice}/${DIR_DATI}`))
                ? `${radice}/${DIR_DATI}` : null
            await aggiornaQuota($, (await $.session.usage()).rateLimits)
            await aggiornaAiutanti($)
            $.clock.every(CADENZA_MS, () => aggiornaAiutanti($))
        } catch (errore) {
            // Un mod che si inceppa non deve disturbare la sessione: il
            // pannello torna a quello che sapeva l'hook.
            $.ui.log(`watchdog: avvio non riuscito: ${errore}`, {to: 'debug'})
        }
        return esito
    })

    /* Scatta quando una finestra di quota si muove di un punto intero,
       compare o se ne va: e' il momento in cui il dato e' cambiato davvero. */
    on('session.measure', async ($, e, next) => {
        await aggiornaQuota($, e.rateLimits)
        return next(e)
    })

    /* Un aiutante che parte si vede subito, senza aspettare il giro. */
    /* `agent.spawn` puo' negare l'avvio, quindi un nostro inciampo
       bloccherebbe un aiutante: il .catch lo lascia passare sempre. Noi qui
       guardiamo, non decidiamo. */
    on('agent.spawn', async ($, e, next) => {
        const esito = await next(e)
        await aggiornaAiutanti($)
        return esito
    }).catch(($, e, next) => next(e))

    on('turn.complete', async ($, e, next) => {
        await aggiornaAiutanti($)
        return next(e)
    })

    on('session.end', async ($, e, next) => {
        sessione = null
        return next(e)
    })
}
