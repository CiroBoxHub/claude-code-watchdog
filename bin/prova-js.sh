#!/usr/bin/env bash
# Prove sulle funzioni pure di extension.js, eseguite davvero con gjs.
#
# Fino al 2026-09-24 nessuna prova eseguiva una riga di JavaScript: di
# extension.js si controllavano sintassi, metodi, chiavi e campi, ma il
# comportamento no. E il comportamento si vede solo dopo logout e login,
# quindi un difetto lì resta invisibile per ore.
#
# Le funzioni si estraggono dal SORGENTE VERO, non da una copia: una copia
# diverge, ed è il difetto che questo progetto ha già pagato due volte.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SRC="$WD_ROOT/gnome-extension/claude-code-watchdog@cirobox.local/extension.js"
[[ -f "$SRC" ]] || { echo "extension.js non trovato"; exit 2; }
command -v gjs >/dev/null || { echo "gjs non installato: prove JS saltate"; exit 0; }

echo "Prove sulle funzioni pure di extension.js"
echo

gjs -c '
const [file] = ARGV;
const sorgente = imports.gi.GLib.file_get_contents(file)[1];
const testo = new TextDecoder().decode(sorgente);

// Si prendono solo le funzioni senza dipendenze da GNOME: le altre non si
// possono eseguire fuori dal processo della shell.
const PURE = ["fmtMb", "fmtNum", "fmtAge", "taglia", "tagliaNome"];
let codice = "";
for (const nome of PURE) {
    const re = new RegExp("^function " + nome + "\\([^)]*\\) \\{[\\s\\S]*?^\\}", "m");
    const m = re.exec(testo);
    if (!m)
        throw new Error("funzione non trovata nel sorgente: " + nome);
    codice += m[0] + "\n";
}
// eval su codice estratto dal NOSTRO sorgente, non da input esterno: è il
// modo per provare le funzioni vere invece di una copia che diverge. Il file
// è quello che verrà installato, e se cambia le prove lo seguono.
eval(codice);

let passate = 0, fallite = 0;
function uguale(cosa, ottenuto, atteso) {
    if (String(ottenuto) === String(atteso)) {
        print("  \x1b[32mok\x1b[0m   " + cosa);
        passate++;
    } else {
        print("  \x1b[31mKO\x1b[0m   " + cosa);
        print("       atteso «" + atteso + "», ottenuto «" + ottenuto + "»");
        fallite++;
    }
}

// --- fmtMb: sopra i 1024 MB passa ai GB, con un decimale
uguale("fmtMb: niente dato", fmtMb(null), "—");
uguale("fmtMb: zero non è niente", fmtMb(0), "0 MB");
uguale("fmtMb: arrotonda i MB", fmtMb(512.4), "512 MB");
uguale("fmtMb: passa ai GB a 1024", fmtMb(1024), "1.0 GB");
uguale("fmtMb: forma compatta", fmtMb(2048, true), "2.0G");

// --- fmtNum: la forma k scatta a 10000, non prima
uguale("fmtNum: niente dato", fmtNum(null), "—");
uguale("fmtNum: sotto i 10000 per esteso", fmtNum(9999), "9999");
uguale("fmtNum: da 10000 in forma k", fmtNum(10000), "10.0k");

// --- taglia: accorcia dalla coda, e il puntino conta nella lunghezza
uguale("taglia: più corto resta intero", taglia("breve", 10), "breve");
uguale("taglia: esatto resta intero", taglia("1234567890", 10), "1234567890");
uguale("taglia: più lungo perde la coda", taglia("12345678901", 10), "123456789…");
uguale("taglia: un percorso si legge dall inizio",
       taglia("/home/tizio/errore/lungo/assai", 12), "/home/tizio…");
uguale("taglia: niente testo", taglia(null, 10), "");

// --- tagliaNome: con le barre la parte che identifica sta in fondo
uguale("tagliaNome: senza barre accorcia dalla coda",
       tagliaNome("nomeprogettolunghissimo", 10), "nomeproge…");
// "cliente/repo-alfa/src" sono 21 caratteri; con n=12 restano i 11 finali
// preceduti dal puntino.
uguale("tagliaNome: con le barre accorcia dalla testa",
       tagliaNome("cliente/repo-alfa/src", 12), "…po-alfa/src");
uguale("tagliaNome: due fratelli restano distinguibili",
       tagliaNome("cliente/repo-alfa/src", 12) === tagliaNome("cliente/repo-beta/src", 12)
           ? "uguali" : "distinti", "distinti");
uguale("tagliaNome: più corto resta intero", tagliaNome("a/b", 10), "a/b");

// --- fmtAge: le soglie sono 5 s, 60 s, un ora, un giorno
const ora = Date.now();
const fa = s => new Date(ora - s * 1000).toISOString();
uguale("fmtAge: mai letto", fmtAge(null), "mai");
uguale("fmtAge: appena adesso", fmtAge(fa(1)), "adesso");
uguale("fmtAge: secondi", fmtAge(fa(30)), "30 s fa");
uguale("fmtAge: minuti", fmtAge(fa(300)), "5 min fa");
uguale("fmtAge: ore", fmtAge(fa(7200)), "2 h fa");
uguale("fmtAge: un giorno al singolare", fmtAge(fa(86400 * 1.5)), "1 giorno fa");
uguale("fmtAge: più giorni al plurale", fmtAge(fa(86400 * 3)), "3 giorni fa");
// Una data nel futuro non deve dare un tempo negativo: succede con l orologio
// spostato o con i fusi.
uguale("fmtAge: una data nel futuro non va in negativo",
       fmtAge(new Date(ora + 60000).toISOString()), "adesso");

print("");
if (fallite > 0) {
    print("\x1b[31m" + fallite + " prove JS fallite\x1b[0m su " + (passate + fallite));
    imports.system.exit(1);
}
print("\x1b[32mTutte le " + passate + " prove JS passano.\x1b[0m");
' "$SRC"
