#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 CiroBoxHub
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
WF="$WD_ROOT/gnome-extension/claude-code-watchdog@cirobox.local/watchface.js"
[[ -f "$SRC" ]] || { echo "extension.js non trovato"; exit 2; }
command -v gjs >/dev/null || { echo "gjs non installato: prove JS saltate"; exit 0; }

echo "Prove sulle funzioni pure di extension.js"
echo

gjs -c '
const [file, fileWf] = ARGV;
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

// Watchface: le funzioni pure e le due tabelle che usano, dallo stesso modo.
const testoWf = new TextDecoder().decode(imports.gi.GLib.file_get_contents(fileWf)[1]);
let codiceWf = "";
for (const nome of ["ORDINE_STATI", "TESTI", "MISURE_MASCOTTE",
                    "AIUTANTE_SCADENZA_S"]) {
    const m = new RegExp("^const " + nome + " = [\\s\\S]*?;$", "m").exec(testoWf);
    if (!m)
        throw new Error("costante non trovata in watchface.js: " + nome);
    codiceWf += m[0].replace(/^const /, "var ") + "\n";
}
for (const nome of ["leggiRigaWatchface", "statoSessione", "statoProprio", "approvazioneVista",
                     "piuUrgente", "iconaStato", "segnoStato", "testoStato", "misureMascotte",
                     "genitoreDaStat", "catenaPid", "parentela", "ricordaPadri", "ordinaAlbero",
                     "contaAiutanti", "turnoOccupato",
                     "canaleAvviso"]) {
    const m = new RegExp("^function " + nome + "\\([^)]*\\) \\{[\\s\\S]*?^\\}", "m").exec(testoWf);
    if (!m)
        throw new Error("funzione non trovata in watchface.js: " + nome);
    codiceWf += m[0] + "\n";
}
eval(codiceWf);

// La mascotte fluttuante: la funzione che decide dove va, con la sua costante.
const fileFu = fileWf.replace(/watchface\.js$/, "fumetto.js");
const testoFu = new TextDecoder().decode(imports.gi.GLib.file_get_contents(fileFu)[1]);
let codiceFu = "";
const fnFu = n => new RegExp("^function " + n + "\\([^)]*\\) \\{[\\s\\S]*?^\\}", "m");
for (const re of [/^const MARGINE = [\s\S]*?;$/m, fnFu("posizioneFumetto"), fnFu("ordinati"),
                  fnFu("evidenziato"), fnFu("aggiungiAvviso"), fnFu("potaAvvisi"),
                  fnFu("togliAvviso")]) {
    const m = re.exec(testoFu);
    if (!m)
        throw new Error("non trovato in fumetto.js: " + re);
    codiceFu += m[0].replace(/^const /, "var ") + "\n";
}
eval(codiceFu);

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

// --- Watchface: la riga scritta dall hook
const r = leggiRigaWatchface("PreToolUse\t1000\t2\t1\t/home/x/prog\n");
uguale("watchface: legge i cinque campi",
       [r.evento, r.epoca, r.fallimenti, r.aiutanti, r.cwd].join("|"), "PreToolUse|1000|2|1|/home/x/prog");
uguale("watchface: una riga vuota non e una sessione", leggiRigaWatchface(""), "null");
uguale("watchface: una riga troncata non e una sessione", leggiRigaWatchface("Stop\t10"), "null");
uguale("watchface: decodifica la cartella come stringa JSON",
       leggiRigaWatchface("Stop\t1\t0\t0\t/home/x/con \\\"virgolette\\\"").cwd, "/home/x/con \"virgolette\"");
uguale("watchface: un numero storto vale zero",
       leggiRigaWatchface("Stop\tabc\t0\t0\t/x").epoca, "0");

// --- Watchface: lo stato, sulla tabella dei casi
const st = (evento, eta, fallimenti = 0) =>
    statoSessione({evento, epoca: 100000 - eta, fallimenti, aiutanti: 0}, 100000);
const casi = [
    ["PreToolUse", 5, 0, "lavora"], ["UserPromptSubmit", 5, 0, "lavora"],
    ["PreToolUse", 30 * 60, 0, "lavora"], ["PreToolUse", 2 * 3600, 0, "dorme"],
    ["PostToolUse", 5 * 60, 0, "lavora"], ["PostToolUse", 15 * 60, 0, "dorme"],
    ["UserPromptSubmit", 15 * 60, 0, "dorme"],
    ["PermissionRequest", 5, 0, "aspetta"], ["Notification", 5, 0, "aspetta"],
    ["PermissionRequest", 2 * 3600, 0, "dorme"],
    ["PermissionRequest", 5, 5, "aspetta"],
    ["StopFailure", 5, 0, "errore"], ["StopFailure", 2 * 3600, 0, "dorme"],
    ["PostToolUseFailure", 5, 3, "errore"], ["PostToolUseFailure", 5, 2, "lavora"],
    ["Stop", 60, 0, "finito"], ["Stop", 700, 0, "dorme"],
    ["SessionStart", 5, 0, "dorme"],
    ["PreCompact", 5, 0, "compatta"], ["PreCompactAuto", 30 * 60, 0, "compatta"],
    ["PreCompactAuto", 5, 3, "compatta"], ["PreCompact", 2 * 3600, 0, "dorme"],
];
const sbagliati = casi.filter(([e, eta, f, atteso]) => st(e, eta, f) !== atteso)
    .map(([e, eta, f, atteso]) => e + "/" + eta + "s/" + f + ": " + st(e, eta, f) + " invece di " + atteso);
uguale("watchface: lo stato su tutti i casi noti", sbagliati.join("; ") || "tutti", "tutti");
uguale("watchface: nessuna sessione, nessuno stato", statoSessione(null, 1), "null");
const approvato = (eta, extra = {}) => statoSessione(
    {evento: "PermissionRequest", epoca: 100000 - eta, fallimenti: 0, aiutanti: 0,
     approvato: true, ...extra}, 100000);
uguale("watchface: un permesso approvato vale lavora, anche dopo tre errori, e scade",
       [approvato(5), approvato(5, {fallimenti: 3}), approvato(2 * 3600)].join(","),
       "lavora,lavora,dorme");
uguale("watchface: approvato vale solo per la richiesta di permesso",
       statoSessione({evento: "Notification", epoca: 99995, fallimenti: 0, aiutanti: 0,
                      approvato: true}, 100000), "aspetta");

// --- Watchface: gli aiutanti al lavoro mentre la sessione tace.
// Una sessione ferma su Stop con tre agenti in background diceva «ha finito»,
// e non cera modo di accorgersene (segnalato il 2026-10-06). La regola vale
// solo sugli stati tranquilli: se Claude aspetta te, o lavora, o si e
// inceppato, quello viene prima — gli aiutanti non sono la notizia.
const stA = (evento, eta, aiutanti) =>
    statoSessione({evento, epoca: 100000 - eta, fallimenti: 0, aiutanti}, 100000);
const casiAiutanti = [
    ["Stop", 60, 0, "finito"],
    ["Stop", 60, 2, "aiutanti"],
    ["Stop", 700, 2, "aiutanti"],
    ["SessionStart", 5, 3, "aiutanti"],
    ["PostToolUse", 15 * 60, 1, "aiutanti"],
    ["PreToolUse", 5, 2, "lavora"],
    ["PermissionRequest", 5, 2, "aspetta"],
    ["StopFailure", 5, 2, "errore"],
    ["PreCompact", 5, 2, "compatta"],
];
const sbAiutanti = casiAiutanti
    .filter(([e, eta, a, atteso]) => stA(e, eta, a) !== atteso)
    .map(([e, eta, a, atteso]) => e + "/" + eta + "s/" + a + " aiutanti: " +
         stA(e, eta, a) + " invece di " + atteso);
uguale("watchface: gli aiutanti al lavoro su tutti i casi noti",
       sbAiutanti.join("; ") || "tutti", "tutti");
uguale("watchface: lo stato proprio non guarda gli aiutanti",
       statoProprio({evento: "Stop", epoca: 99940, fallimenti: 0, aiutanti: 5}, 100000),
       "finito");
uguale("watchface: aiutanti sta fra compatta e finito",
       piuUrgente(["finito", "aiutanti"]) + "," + piuUrgente(["aiutanti", "lavora"]),
       "aiutanti,lavora");
uguale("watchface: licona degli aiutanti e il robottino",
       iconaStato("aiutanti"), "fw-robot");

// --- Watchface: chi ha avviato chi.
// Da Claude Code 2.1.291 una sessione non e piu un terminale: per gli
// aiutanti in background Claude avvia processi `claude` figli, e il demone ne
// tiene di riserva (`bg-spare`). Senza questa regola un terminale solo
// compariva come tre sessioni dello stesso progetto.
const alberoFinto = {10: 0, 20: 10, 30: 20, 40: 30, 50: 0, 60: 50, 70: 0};
const antenatiFinti = pid => {
    const out = [];
    for (let p = pid; p > 0 && out.length < 20; p = alberoFinto[p] ?? 0)
        out.push(p);
    return out;
};
const comandiFinti = {10: "claude", 20: "claude bg-spare --bg-spare /tmp/s.sock",
                      30: "claude", 40: "claude", 50: "claude --resume",
                      60: "claude", 70: "claude"};
const par = sessioni => parentela(sessioni, antenatiFinti, pid => comandiFinti[pid] ?? "");
const S = (id, pid) => ({id, pid});
// La madre non ha padre; la figlia diretta lo ha; il nipote salta la riserva
// in mezzo e si attacca alla nonna.
const r1 = par([S("madre", 10), S("riserva", 20), S("nipote", 30)]);
const leggi = (r, id) => {
    const s = r.find(x => x.id === id);
    return s.id + ":padre=" + s.padre + ",impianto=" + s.impianto;
};
uguale("parentela: la madre non ha padre", leggi(r1, "madre"), "madre:padre=null,impianto=false");
uguale("parentela: bg-spare e impianto", leggi(r1, "riserva"), "riserva:padre=madre,impianto=true");
uguale("parentela: il nipote salta limpianto e si attacca alla nonna",
       leggi(r1, "nipote"), "nipote:padre=madre,impianto=false");
// Il padre e il piu vicino, non il piu lontano.
const r2 = par([S("madre", 10), S("figlia", 30), S("nipote", 40)]);
uguale("parentela: vince lantenato piu vicino", leggi(r2, "nipote"),
       "nipote:padre=figlia,impianto=false");
// Un antenato che non e una sessione non fa padre; e una riga vecchia senza
// pid non ha modo di saperlo.
const r3 = par([S("sola", 60), S("senzapid", 0)]);
uguale("parentela: un antenato che non e sessione non fa padre",
       leggi(r3, "sola"), "sola:padre=null,impianto=false");
uguale("parentela: senza pid non si indovina",
       leggi(r3, "senzapid"), "senzapid:padre=null,impianto=false");
// Nessuno e padre di se stesso, nemmeno con la stessa riga due volte.
const r4 = par([S("a", 70), S("b", 70)]);
uguale("parentela: nessuno e padre di se stesso",
       leggi(r4, "a") + "|" + leggi(r4, "b"),
       "a:padre=null,impianto=false|b:padre=a,impianto=false");

// --- Watchface: gli aiutanti vivi si contano dall elenco, non dalla riga.
// L hook aggiorna il numero nella riga solo quando Claude manda un evento, e
// una sessione che avvia lavoro in background e poi tace non ne manda piu:
// il pannello deve ricontarli da se a ogni lettura.
const ADESSO = 1000000;
const el = righe => righe.join("\n");
uguale("aiutanti: elenco vuoto", contaAiutanti("", ADESSO), "0");
uguale("aiutanti: niente elenco", contaAiutanti(null, ADESSO), "0");
uguale("aiutanti: due freschi contano due",
       contaAiutanti(el(["a\t" + (ADESSO - 10), "b\t" + (ADESSO - 60)]), ADESSO), "2");
uguale("aiutanti: uno vecchio di quattro ore non conta",
       contaAiutanti(el(["a\t" + (ADESSO - 14400), "b\t" + (ADESSO - 60)]), ADESSO), "1");
uguale("aiutanti: sul filo della scadenza non conta",
       contaAiutanti("a\t" + (ADESSO - AIUTANTE_SCADENZA_S), ADESSO), "0");
uguale("aiutanti: un attimo prima conta",
       contaAiutanti("a\t" + (ADESSO - AIUTANTE_SCADENZA_S + 1), ADESSO), "1");
uguale("aiutanti: le righe senza epoca (formato vecchio) non contano",
       contaAiutanti(el(["a263612d89aecb2ef", "a780b916e6c0751be"]), ADESSO), "0");
uguale("aiutanti: unepoca storta non conta",
       contaAiutanti("a\tdomani", ADESSO), "0");
// Un numero seguito da lettere e il caso che distingue la guardia dal caso
// fortunato: parseInt("999abc") torna 999, quindi senza il controllo sulla
// forma la riga conterebbe.
uguale("aiutanti: unepoca con la coda sporca non conta",
       contaAiutanti("a\t" + (ADESSO - 5) + "abc", ADESSO), "0");
uguale("aiutanti: una riga vuota in fondo non conta",
       contaAiutanti("a\t" + (ADESSO - 5) + "\n", ADESSO), "1");

// --- Watchface: cosa vale come turno occupato per la notifica di fine lavoro.
// Senza «aiutanti» qui dentro, un turno che avvia un agente passa
// lavora -> aiutanti -> finito e la notifica «Claude ha finito» non scatta
// mai: ne entrando in aiutanti, che non e finito, ne uscendone, perche lo
// stato di prima non risultava occupato.
uguale("turno: cosa conta come occupato",
       ["lavora", "compatta", "aiutanti", "finito", "dorme", "aspetta", "errore"]
           .map(s => s + "=" + turnoOccupato(s)).join(" "),
       "lavora=true compatta=true aiutanti=true finito=false dorme=false " +
       "aspetta=false errore=false");

// --- Watchface: la parentela si ricorda quando il processo non c e piu.
const mem = new Map();
const viva = [{id: "f", padre: "m", impianto: false}, {id: "m", padre: null, impianto: false}];
ricordaPadri(viva, mem);
uguale("memoria: impara dalla sessione viva", mem.get("f").padre, "m");
// Stesso elenco, ma il processo e finito: parentela() non trova piu antenati.
const morta = [{id: "f", padre: null, impianto: false}, {id: "m", padre: null, impianto: false}];
ricordaPadri(morta, mem);
uguale("memoria: la figlia resta figlia anche a processo finito",
       morta.find(s => s.id === "f").padre, "m");
// Un bg-spare finito non deve ricomparire come riga vera.
const mem2 = new Map();
// Senza padre, se no e quello a farla ricordare e il caso non distingue.
ricordaPadri([{id: "r", padre: null, impianto: true}], mem2);
const riserva = [{id: "r", padre: null, impianto: false}];
ricordaPadri(riserva, mem2);
uguale("memoria: una riserva finita resta impianto", riserva[0].impianto, "true");
// La memoria non cresce: chi non ha piu la sua riga esce.
ricordaPadri([{id: "altro", padre: null, impianto: false}], mem2);
uguale("memoria: si pota da se", mem2.has("r") ? "tiene" : "pulita", "pulita");

// --- Watchface: le figlie sotto la madre, rientrate.
const A = (id, padre) => ({id, padre});
const stampa = r => r.map(s => "  ".repeat(s.livello) + s.id).join("|");
uguale("albero: senza padri resta lordine di prima",
       stampa(ordinaAlbero([A("a", null), A("b", null)])), "a|b");
uguale("albero: la figlia va sotto la madre, rientrata",
       stampa(ordinaAlbero([A("a", null), A("b", null), A("figlia", "a")])),
       "a|  figlia|b");
uguale("albero: la nipote rientra di due",
       stampa(ordinaAlbero([A("a", null), A("f", "a"), A("n", "f")])),
       "a|  f|    n");
// L orfana va rimessa fra le radici al suo posto, non in fondo: se la madre
// non c e piu, la riga resta dove l ordine per urgenza l aveva messa. Con la
// madre in testa all elenco i due casi si distinguono.
uguale("albero: unorfana torna radice al suo posto",
       stampa(ordinaAlbero([A("orfana", "sparita"), A("a", null)])), "orfana|a");
uguale("albero: nessuno si perde con un anello nei dati",
       stampa(ordinaAlbero([A("x", "y"), A("y", "x")])).split("|").sort().join(","),
       "x,y");
uguale("albero: le figlie di una stessa madre restano nellordine ricevuto",
       stampa(ordinaAlbero([A("m", null), A("f1", "m"), A("f2", "m")])),
       "m|  f1|  f2");

// --- Watchface: il segno che lampeggia, al posto del respiro del disco.
const segni = ["aspetta", "errore", "lavora", "compatta", "aiutanti", "finito", "dorme"]
    .map(s => s + "=" + segnoStato(s)).join(" ");
uguale("watchface: il segno di ogni stato", segni,
       "aspetta=fw-segno-domanda errore=fw-segno-errore lavora=fw-segno-lampadina " +
       "compatta=fw-segno-lampadina aiutanti=fw-segno-lampadina finito=null dorme=null");

// L approvazione, vista dai processi figli. Ogni caso: figli alla richiesta,
// letture successive, e se a un certo punto risulta approvato.
const sorveglia = (base, letture) => {
    let contati = new Map(), visto = false;
    for (const attuali of letture) {
        const esito = approvazioneVista(base, attuali, contati);
        contati = esito.contati;
        visto ||= esito.approvato;
    }
    return visto;
};
const casiAppr = [
    ["nessun figlio nuovo", [1], [[[1, "mcp"]], [[1, "mcp"]]], false],
    ["un figlio nuovo visto una volta sola", [1], [[[1, "mcp"], [7, "bash -c ls"]]], false],
    ["un figlio nuovo visto due volte", [1], [[[7, "bash -c ls"]], [[7, "bash -c ls"]]], true],
    ["il nostro hook non conta", [], [[[8, "bash x/watchface-hook Notification"]],
                                      [[8, "bash x/watchface-hook Notification"]]], false],
    ["un figlio che c era gia non conta", [5], [[[5, "bash -c sleep"]], [[5, "bash -c sleep"]]], false],
    ["due figli brevi diversi non fanno un approvato", [], [[[8, "hook a"]], [[9, "hook b"]]], false],
];
const sbagliatiAppr = casiAppr.filter(([, base, letture, atteso]) => sorveglia(base, letture) !== atteso)
    .map(([n]) => n);
uguale("watchface: l approvazione su tutti i casi noti", sbagliatiAppr.join("; ") || "tutti", "tutti");

uguale("watchface: aspetta vince su tutto",
       piuUrgente(["dorme", "lavora", "errore", "aspetta", "finito"]), "aspetta");
uguale("watchface: errore vince su lavora", piuUrgente(["lavora", "errore"]), "errore");
uguale("watchface: lavora vince su finito", piuUrgente(["finito", "lavora"]), "lavora");
uguale("watchface: il compact sta fra lavora e finito",
       [piuUrgente(["compatta", "lavora"]), piuUrgente(["finito", "compatta"])].join(","),
       "lavora,compatta");
uguale("watchface: elenco vuoto", piuUrgente([]), "null");

uguale("watchface: il limone per gli errori", iconaStato("errore"), "fw-limone");
uguale("watchface: la faccina negli altri stati", iconaStato("aspetta"), "fw-faccina-aspetta");
uguale("watchface: il limone con gli occhi in su per il compact", iconaStato("compatta"), "fw-limone-su");
// Ogni stato ha la sua icona a colori e la simbolica della barra, e un testo:
// un file mancante si vede solo nella shell, come un quadrato vuoto.
const cartellaIcone = fileWf.replace(/watchface\.js$/, "icons/");
const senzaIcona = ORDINE_STATI.flatMap(s => [iconaStato(s), iconaStato(s) + "-symbolic"])
    .filter(n => !imports.gi.GLib.file_test(cartellaIcone + n + ".svg",
                                            imports.gi.GLib.FileTest.EXISTS));
uguale("watchface: ogni stato ha le sue icone", senzaIcona.join(", ") || "tutte", "tutte");
uguale("watchface: ogni stato ha il suo testo",
       ORDINE_STATI.filter(s => !TESTI[s]).join(", ") || "tutti", "tutti");
uguale("watchface: senza stato dorme", iconaStato(null), "fw-faccina-dorme");
uguale("watchface: il permesso si dice", testoStato({stato: "aspetta", evento: "PermissionRequest"}),
       "chiede un permesso");
uguale("watchface: gli altri stati hanno il loro testo", testoStato({stato: "lavora"}), "sta lavorando");
uguale("watchface: legge il pid di claude, e la cartella resta la cartella",
       ((r) => r.pid + "|" + r.cwd)(leggiRigaWatchface("Stop\t1\t0\t0\t/x\t4321")), "4321|/x");
uguale("watchface: una riga senza pid (versione vecchia) vale zero",
       leggiRigaWatchface("Stop\t1\t0\t0\t/x").pid + "|" + leggiRigaWatchface("Stop\t1\t0\t0\t/x").cwd, "0|/x");
uguale("watchface: il genitore si legge dopo la parentesi finale",
       genitoreDaStat("123 (strano) nome) S 77 123 123 0"), "77");
uguale("watchface: uno stat illeggibile non ha genitore", genitoreDaStat("spazzatura"), "0");
const albero = {50: 40, 40: 30, 30: 1};
uguale("watchface: la catena risale fino a init escluso",
       catenaPid(50, p => albero[p] ?? 0).join(","), "50,40,30");
uguale("watchface: un ciclo nei dati non blocca",
       catenaPid(7, p => (p === 7 ? 8 : 7)).join(","), "7,8");
uguale("watchface: un processo finito non ha catena oltre se stesso",
       catenaPid(99, () => 0).join(","), "99");
// Due monitor come a casa: il portatile a sinistra, il principale a destra.
const AREE = [{x: 0, y: 0, width: 1000, height: 800}, {x: 1000, y: 0, width: 1920, height: 1080}];
const casiFu = [
    ["mai spostata: angolo del principale", [-1, -1, 100, 200, AREE, 1], [2796, 856]],
    ["posto ricordato sul primo monitor", [500, 400, 100, 200, AREE, 1], [400, 200]],
    ["monitor staccato: torna nell angolo", [5000, 400, 100, 200, AREE, 1], [2796, 856]],
    ["in cima allo schermo non esce sopra", [990, 100, 300, 200, AREE, 1], [690, 0]],
    ["a sinistra non esce dal bordo", [50, 700, 300, 200, AREE, 1], [0, 500]],
    ["primario sconosciuto: il primo", [-1, -1, 100, 100, AREE, 7], [876, 676]],
];
const sbagliatiFu = casiFu.filter(([, a, atteso]) =>
    JSON.stringify(posizioneFumetto(...a)) !== JSON.stringify(atteso))
    .map(([n, a]) => n + " -> " + JSON.stringify(posizioneFumetto(...a)));
uguale("fumetto: la posizione su tutti i casi noti", sbagliatiFu.join("; ") || "tutti", "tutti");
// L elenco della nuvoletta. Ogni caso: elenco di partenza, evidenziato,
// operazione, e cosa ci si aspetta (righe in ordine | evidenziata).
const av = (id, stato, quando, scade = 0) => ({id, stato, quando, scade});
const ses = (id, stato) => ({id, stato});
const descr = r => r.avvisi.map(a => a.id + ":" + a.stato).join(",") + "|" + r.id;
const casiAv = [
    ["il primo avviso si evidenzia",
     aggiungiAvviso([], av("a", "finito", 1), null), "a:finito|a"],
    ["ha finito non copre ti aspetta",
     aggiungiAvviso([av("a", "aspetta", 1)], av("b", "finito", 2), "a"), "a:aspetta,b:finito|a"],
    ["si e inceppato copre ha finito",
     aggiungiAvviso([av("a", "finito", 1)], av("b", "errore", 2), "a"), "b:errore,a:finito|b"],
    ["a parita vince il piu recente, anche in cima",
     aggiungiAvviso([av("a", "aspetta", 1)], av("b", "aspetta", 2), "a"), "b:aspetta,a:aspetta|b"],
    ["la stessa sessione ha una riga sola",
     aggiungiAvviso([av("a", "aspetta", 1), av("b", "finito", 1)], av("a", "errore", 2), "a"),
     "a:errore,b:finito|a"],
    ["la sessione che riparte se ne va, l evidenza passa alla prima",
     potaAvvisi([av("a", "aspetta", 1), av("b", "finito", 1)],
                [ses("a", "lavora"), ses("b", "finito")], 5, "a"), "b:finito|b"],
    ["la sessione chiusa se ne va",
     potaAvvisi([av("a", "aspetta", 1), av("b", "errore", 1)], [ses("b", "errore")], 5, "b"),
     "b:errore|b"],
    ["ha finito scade, ti aspetta no",
     potaAvvisi([av("a", "aspetta", 1), av("b", "finito", 1, 9)],
                [ses("a", "aspetta"), ses("b", "finito")], 9, "b"), "a:aspetta|a"],
    ["prima della scadenza resta",
     potaAvvisi([av("b", "finito", 1, 9)], [ses("b", "finito")], 8, "b"), "b:finito|b"],
    ["l evidenza resta dove l hai messa, anche non in cima",
     potaAvvisi([av("a", "aspetta", 1), av("b", "finito", 1)],
                [ses("a", "aspetta"), ses("b", "finito")], 5, "b"), "a:aspetta,b:finito|b"],
    ["togliere quella non evidenziata lascia l evidenza",
     togliAvviso([av("a", "aspetta", 1), av("b", "finito", 1)], "b", "a"), "a:aspetta|a"],
    ["togliere l ultima svuota",
     togliAvviso([av("a", "aspetta", 1)], "a", "a"), "|null"],
];
const sbagliatiAv = casiAv.filter(([, r, atteso]) => descr(r) !== atteso)
    .map(([n, r]) => n + " -> " + descr(r));
uguale("fumetto: l elenco degli avvisi su tutti i casi noti", sbagliatiAv.join("; ") || "tutti", "tutti");
uguale("watchface: un avviso passa da un canale solo, e mai col terminale davanti",
       [["notifiche", false], ["mascotte", false], ["nessuno", false],
        ["mascotte", true], ["notifiche", true], [undefined, false]]
           .map(([c, t]) => canaleAvviso(c, t)).join(","),
       "notifica,mascotte,,,,notifica");
uguale("watchface: una grandezza sconosciuta vale media",
       JSON.stringify(misureMascotte("enorme")), JSON.stringify(misureMascotte("media")));
uguale("watchface: le grandezze crescono e nella barra stanno sotto i 24 px",
       ["piccola", "media", "grande"].map(t => misureMascotte(t))
           .every((m, i, a) => m.barra <= 24 && (i === 0 || (m.barra > a[i - 1].barra &&
                                                              m.popup > a[i - 1].popup &&
                                                              m.fumetto > a[i - 1].fumetto))),
       true);

print("");
if (fallite > 0) {
    print("\x1b[31m" + fallite + " prove JS fallite\x1b[0m su " + (passate + fallite));
    imports.system.exit(1);
}
print("\x1b[32mTutte le " + passate + " prove JS passano.\x1b[0m");
' "$SRC" "$WF"
