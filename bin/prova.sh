#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 CiroBoxHub
# Collaudo funzionale degli script, su dati finti in una sandbox.
#
# Esiste perché i controlli statici non bastano: dei difetti trovati dalla
# revisione del 2026-09-17, tre sarebbero caduti qui — la radice sbagliata nella
# copia dentro l'estensione, il cestino potato per mtime, la codifica delle
# cartelle divergente fra due script.
#
# Non tocca i dati veri: ogni prova gira con HOME dirottata in una cartella
# temporanea.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# lib.sh calcola WD_ROOT, ma le prove dirottano HOME: si esporta perché i
# sotto-processi python lo ritrovino.
export WD_ROOT

passate=0; fallite=0
ok()  { printf '  \033[32mok\033[0m   %s\n' "$1"; passate=$((passate+1)); }
ko()  { printf '  \033[31mKO\033[0m   %s\n' "$1"; [[ -n "${2:-}" ]] && printf '       %s\n' "$2"; fallite=$((fallite+1)); }
uguale() { [[ "$2" == "$3" ]] && ok "$1" || ko "$1" "atteso «$3», ottenuto «$2»"; }

SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

# ------------------------------------------------------------------ dati ---
# Una finta ~ con una conversazione vera e uno scarto senza risposte.
prepara() {
  export HOME="$SANDBOX/home"
  rm -rf "$HOME"; mkdir -p "$HOME/.claude/projects/-tmp-progetto" \
        "$HOME/.claude/session-env" "$HOME/.local/share"
  mkdir -p "$SANDBOX/lavoro/progetto"
  echo "contenuto" > "$SANDBOX/lavoro/progetto/dato.csv"

  local d="$HOME/.claude/projects/-tmp-progetto"
  {
    printf '{"type":"user","cwd":"/tmp/progetto","timestamp":"2026-09-01T10:00:00Z","message":{"role":"user","content":"apri /tmp/progetto/dato.csv"}}\n'
    printf '{"type":"assistant","cwd":"/tmp/progetto","timestamp":"2026-09-01T10:00:01Z","message":{"role":"assistant"}}\n'
  } > "$d/aaaaaaaa-0000-0000-0000-000000000001.jsonl"
  printf '{"type":"user","cwd":"/tmp/progetto","timestamp":"2026-09-01T10:00:00Z","message":{"role":"user","content":"x"}}\n' \
      > "$d/bbbbbbbb-0000-0000-0000-000000000002.jsonl"
  # Invecchiata oltre ATTESA_SCARTO_S: una trascrizione senza risposte scritta
  # adesso e' un'invocazione in corso, non uno scarto.
  touch -d "10 minutes ago" "$d/bbbbbbbb-0000-0000-0000-000000000002.jsonl"
  mkdir -p "$HOME/.claude/session-env/aaaaaaaa-0000-0000-0000-000000000001"
}

echo "Collaudo degli script — sandbox in $SANDBOX"
echo

# ------------------------------------------------- claude-sessions.py ---
prepara
out=$("$WD_ROOT/bin/claude-sessions.py" --format json 2>/dev/null)
uguale "claude-sessions: conta le conversazioni vere" \
  "$(echo "$out" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["reali"]))')" "1"
uguale "claude-sessions: riconosce gli scarti" \
  "$(echo "$out" | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["fantasma"]))')" "1"

# i subagenti non sono conversazioni
mkdir -p "$HOME/.claude/projects/-tmp-progetto/aaaaaaaa/subagents"
cp "$HOME/.claude/projects/-tmp-progetto/aaaaaaaa-0000-0000-0000-000000000001.jsonl" \
   "$HOME/.claude/projects/-tmp-progetto/aaaaaaaa/subagents/agent-xx.jsonl"
uguale "claude-sessions: ignora i subagenti" \
  "$("$WD_ROOT/bin/claude-sessions.py" --format json 2>/dev/null | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["reali"]))')" "1"

# La cache dei metadati non deve mai dare numeri vecchi. Vale la pena provarla
# perche' una cache sbagliata non segnala niente: mostra dati plausibili.
prepara
export XDG_CACHE_HOME="$HOME/.cache"
f="$HOME/.claude/projects/-tmp-progetto/aaaaaaaa-0000-0000-0000-000000000001.jsonl"
msg() { "$WD_ROOT/bin/claude-sessions.py" --format json 2>/dev/null \
        | python3 -c 'import json,sys;print(json.load(sys.stdin)["reali"][0]["n_msg"])'; }
prima=$(msg)
uguale "cache: il secondo giro da' lo stesso conteggio" "$(msg)" "$prima"
printf '{"type":"user","cwd":"/tmp/progetto","timestamp":"2026-09-01T10:00:02Z","message":{"role":"user","content":"ancora"}}\n' >> "$f"
uguale "cache: una trascrizione cresciuta viene riletta" \
  "$(msg)" "$((prima + 1))"
rm -f "$f"
uguale "cache: una trascrizione sparita non resta in cache" \
  "$("$WD_ROOT/bin/claude-sessions.py" --format json 2>/dev/null \
     | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["reali"]))')" "0"
uguale "cache: non conserva voci di file inesistenti" \
  "$(python3 -c "
import json,os
c=os.path.expanduser('$HOME/.cache/claude-code-watchdog/sessioni.json')
d=json.load(open(c))
print(all(os.path.exists(k) for k in d['voci']))")" "True"
unset XDG_CACHE_HOME

# XDG_* impostata ma vuota vale come non impostata, dice la specifica.
# Path("") è Path("."): i dati sarebbero finiti nella cartella da cui è partita
# la shell, che per l'estensione è imprevedibile.
prepara
(cd "$SANDBOX" && XDG_DATA_HOME= "$WD_ROOT/bin/collect-metrics.py" --quiet >/dev/null 2>&1)
uguale "XDG vuota: i dati vanno nel posto di sempre" \
  "$([[ -f "$HOME/.local/share/claude-code-watchdog/metrics.json" ]] && echo si || echo no)" "si"
uguale "XDG vuota: non crea cartelle nel percorso corrente" \
  "$([[ -d "$SANDBOX/claude-code-watchdog" ]] && echo creata || echo nessuna)" "nessuna"

# La riscrittura delle trascrizioni è atomica: un'interruzione a metà non deve
# lasciare una conversazione troncata. Si prova la funzione, perché il caso
# vero — il processo ucciso a metà scrittura — non si riproduce.
prepara
uguale "scrittura atomica: sostituisce senza lasciare temporanei" \
  "$(python3 -c "
import importlib.util as u, os
from pathlib import Path
s=u.spec_from_file_location('fc','$WD_ROOT/bin/fix-cwd.py');m=u.module_from_spec(s);s.loader.exec_module(m)
d=Path('$SANDBOX/atom'); d.mkdir(parents=True, exist_ok=True)
f=d/'x.jsonl'; f.write_text('vecchio')
m.scrivi_atomico(f, 'nuovo')
resti=[x.name for x in d.iterdir() if x.name != 'x.jsonl']
print(f.read_text(), resti)")" "nuovo []"
uguale "scrittura atomica: se fallisce non tocca l'originale" \
  "$(python3 -c "
import importlib.util as u
from pathlib import Path
s=u.spec_from_file_location('fc','$WD_ROOT/bin/fix-cwd.py');m=u.module_from_spec(s);s.loader.exec_module(m)
d=Path('$SANDBOX/atom2'); d.mkdir(parents=True, exist_ok=True)
f=d/'y.jsonl'; f.write_text('originale')
try:
    m.scrivi_atomico(f, object())   # non è testo: solleva
except Exception:
    pass
resti=[x.name for x in d.iterdir() if x.name != 'y.jsonl']
print(f.read_text(), resti)")" "originale []"

# Una cache malformata non deve far saltare l'inventario: da --stubs dipendono
# reclaim.py e clean.sh, e un inventario che muore li ferma entrambi.
prepara
export XDG_CACHE_HOME="$HOME/.cache"
mkdir -p "$HOME/.cache/claude-code-watchdog"
# Fuori dalla sostituzione di comando: dentro, le virgolette del JSON vanno
# protette e i payload arrivavano a destinazione con le barre rovesciate
# dentro — JSON non valido, che finiva nel ramo sbagliato. La prova passava
# anche rimettendo il difetto, verificato con una mutazione.
rotte=('[]' '{"versione":1,"voci":[]}' '{"versione":1}' '{"versione":1,"voci":"x"}' 'non json')
_esito=tutte-ok
for rotta in "${rotte[@]}"; do
  printf '%s' "$rotta" > "$HOME/.cache/claude-code-watchdog/sessioni.json"
  "$WD_ROOT/bin/claude-sessions.py" --stubs >/dev/null 2>&1 || { _esito="rotta su: $rotta"; break; }
done
uguale "cache: una cache malformata non ferma l'inventario" "$_esito" "tutte-ok"
uguale "cache: non lascia temporanei in giro" \
  "$(ls "$HOME/.cache/claude-code-watchdog"/*.tmp 2>/dev/null | wc -l)" "0"
unset XDG_CACHE_HOME

# La scrittura atomica non deve declassare i permessi: le trascrizioni stanno
# a 600 e contengono i nomi dei progetti, quindi dei clienti.
uguale "scrittura atomica: conserva i permessi dell'originale" \
  "$(python3 -c "
import importlib.util as u, os
from pathlib import Path
s=u.spec_from_file_location('fc','$WD_ROOT/bin/fix-cwd.py');m=u.module_from_spec(s);s.loader.exec_module(m)
d=Path('$SANDBOX/perm'); d.mkdir(parents=True, exist_ok=True)
f=d/'t.jsonl'; f.write_text('a'); f.chmod(0o600)
m.scrivi_atomico(f,'b')
n=d/'nuovo.jsonl'; m.scrivi_atomico(n,'c')
print(oct(f.stat().st_mode & 0o777), oct(n.stat().st_mode & 0o777))")" "0o600 0o600"

# Una trascrizione senza risposte ma scritta adesso e' un'invocazione in
# corso, non uno scarto: la nostra lettura della quota ne crea una e la toglie
# due secondi dopo, e nel pannello si vedeva «1 sessione fantasma» comparire e
# sparire a ogni aggiornamento. Peggio: `clean.sh claude-stubs` avrebbe potuto
# cestinare una sessione interattiva vera in attesa della prima risposta.
prepara
d="$HOME/.claude/projects/-tmp-progetto"
printf '{"type":"user","cwd":"/tmp/progetto","timestamp":"2026-09-01T10:00:00Z","message":{"role":"user","content":"appena partita"}}\n' \
  > "$d/99999999-0000-0000-0000-000000000099.jsonl"
uguale "scarti: una trascrizione appena scritta non e' uno scarto" \
  "$("$WD_ROOT/bin/claude-sessions.py" --stubs 2>/dev/null | grep -c 99999999)" "0"
touch -d "10 minutes ago" "$d/99999999-0000-0000-0000-000000000099.jsonl"
uguale "scarti: dopo l'attesa lo diventa" \
  "$("$WD_ROOT/bin/claude-sessions.py" --stubs 2>/dev/null | grep -c 99999999)" "1"

# Sessioni automatiche orfane: lanciate da un programma (entrypoint sdk-*) in
# una cartella che non c'e' piu'. Il caso nato il 2026-10-03: skillspector
# lancia Claude in /tmp/skillspector_cli_* e ne ha lasciate 62. «Cartella
# sparita» da sola NON basta: le conversazioni interattive di progetti persi
# con /tmp sono backup voluti (vedi CLAUDE.md). Tabella dei casi:
#   A sdk-cli, cartella sparita, con risposta      → orfana
#   B sdk-py,  cartella sparita, con risposta      → orfana
#   C cli,     cartella sparita (backup da /tmp)   → no
#   D sdk-cli, cartella che esiste                 → no
#   E sdk-cli, cartella sparita, senza risposta    → no (e' uno scarto)
#   F sdk-cli, cartella sparita, scritta adesso    → no (in corso)
#   G senza entrypoint, cartella sparita           → no (non si indovina)
#   H claude-desktop, cartella sparita             → no
prepara_orfane() {
  prepara
  local p="$HOME/.claude/projects" via="$SANDBOX/sparita"
  mkdir -p "$p/-orf-a/memory" "$p/-orf-misto" "$p/-orf-d" "$p/-orf-efgh"
  riga() { # riga TIPO ENTRYPOINT CWD
    if [[ -n "$2" ]]; then
      printf '{"type":"%s","entrypoint":"%s","cwd":"%s","timestamp":"2026-09-01T10:00:00Z","message":{"role":"%s"}}\n' "$1" "$2" "$3" "$1"
    else
      printf '{"type":"%s","cwd":"%s","timestamp":"2026-09-01T10:00:00Z","message":{"role":"%s"}}\n' "$1" "$3" "$1"
    fi
  }
  conv() { riga user "$1" "$2"; riga assistant "$1" "$2"; }
  conv sdk-cli "$via/a"                 > "$p/-orf-a/aaaaaaaa-0000-0000-0000-00000000000a.jsonl"
  conv sdk-py  "$via/b"                 > "$p/-orf-misto/aaaaaaaa-0000-0000-0000-00000000000b.jsonl"
  conv cli     "$via/c"                 > "$p/-orf-misto/cccccccc-0000-0000-0000-00000000000c.jsonl"
  conv sdk-cli "$SANDBOX/lavoro/progetto" > "$p/-orf-d/dddddddd-0000-0000-0000-00000000000d.jsonl"
  riga user sdk-cli "$via/e"            > "$p/-orf-efgh/eeeeeeee-0000-0000-0000-00000000000e.jsonl"
  conv sdk-cli "$via/f"                 > "$p/-orf-efgh/ffffffff-0000-0000-0000-00000000000f.jsonl"
  conv ""      "$via/g"                 > "$p/-orf-efgh/99999999-0000-0000-0000-000000000009.jsonl"
  conv claude-desktop "$via/h"          > "$p/-orf-efgh/88888888-0000-0000-0000-000000000008.jsonl"
  find "$p" -name '*.jsonl' ! -name 'ffffffff-*' -exec touch -d "10 minutes ago" {} +
}
orfane() { "$WD_ROOT/bin/claude-sessions.py" --orfane 2>/dev/null \
           | sed 's#.*/##; s#-.*##' | sort | tr '\n' ' '; }

prepara_orfane
uguale "orfane: solo le automatiche con la cartella sparita" "$(orfane)" "aaaaaaaa aaaaaaaa "
uguale "orfane: sono proprio A e B" \
  "$("$WD_ROOT/bin/claude-sessions.py" --orfane 2>/dev/null | grep -oE '0000000000[ab]\.jsonl' | sort | tr '\n' ' ')" \
  "0000000000a.jsonl 0000000000b.jsonl "

# La cache non deve far perdere l'entrypoint: ne' al secondo giro, ne' quando
# il file cresce e si legge solo la coda, ne' con una cache scritta da una
# versione che l'entrypoint non lo salvava.
export XDG_CACHE_HOME="$HOME/.cache"
# Oltre i 4 KB della testa: sotto, ogni aggiunta cambia la testa e il file si
# rilegge intero, e la lettura incrementale non verrebbe mai provata.
f="$HOME/.claude/projects/-orf-a/aaaaaaaa-0000-0000-0000-00000000000a.jsonl"
printf '{"type":"user","entrypoint":"sdk-cli","cwd":"%s","timestamp":"2026-09-01T10:00:00Z","message":{"role":"user","content":"%s"}}\n' \
  "$SANDBOX/sparita/a" "$(head -c 5000 /dev/zero | tr '\0' x)" > "$f.tmp"
cat "$f" >> "$f.tmp" && mv "$f.tmp" "$f"
touch -d "10 minutes ago" "$f"
orfane >/dev/null
uguale "orfane: il secondo giro dalla cache da' lo stesso elenco" "$(orfane)" "aaaaaaaa aaaaaaaa "
# La riga in coda e' senza entrypoint: cosi' deve arrivare dalla cache, e non
# dalla parte appena letta.
riga assistant "" "$SANDBOX/sparita/a" >> "$HOME/.claude/projects/-orf-a/aaaaaaaa-0000-0000-0000-00000000000a.jsonl"
touch -d "10 minutes ago" "$HOME/.claude/projects/-orf-a/aaaaaaaa-0000-0000-0000-00000000000a.jsonl"
uguale "orfane: una trascrizione cresciuta resta orfana" "$(orfane)" "aaaaaaaa aaaaaaaa "
python3 - "$XDG_CACHE_HOME/claude-code-watchdog/sessioni.json" <<'EOF'
import json, sys
f = sys.argv[1]; d = json.load(open(f))
for v in d["voci"].values():
    v["dati"].pop("entrypoint", None)
d["versione"] = 2
json.dump(d, open(f, "w"))
EOF
uguale "orfane: una cache della versione precedente non le nasconde" "$(orfane)" "aaaaaaaa aaaaaaaa "
unset XDG_CACHE_HOME

# Richieste e contesto per sessione: la base dei consigli sulla quota. Un
# messaggio dell'assistente occupa piu' righe con lo stesso id (una per blocco
# di contenuto): si conta una volta. «Grande» e' oltre 150k token di contesto,
# la stessa soglia che usa /usage.
prepara
export XDG_CACHE_HOME="$HOME/.cache"
f="$HOME/.claude/projects/-tmp-progetto/cccccccc-0000-0000-0000-0000000000c1.jsonl"
risposta() { # risposta ID CONTESTO_LETTO
  printf '{"type":"assistant","cwd":"/tmp/progetto","timestamp":"2026-09-01T10:00:00Z","message":{"id":"%s","role":"assistant","usage":{"input_tokens":5,"cache_read_input_tokens":%s,"cache_creation_input_tokens":0,"output_tokens":10}}}\n' "$1" "$2"
}
{
  printf '{"type":"user","cwd":"/tmp/progetto","timestamp":"2026-09-01T10:00:00Z","message":{"role":"user","content":"%s"}}\n' "$(head -c 5000 /dev/zero | tr '\0' x)"
  risposta m1 200000; risposta m1 200000; risposta m2 10000; risposta m3 160000
} > "$f"
contesto() { "$WD_ROOT/bin/claude-sessions.py" --format json 2>/dev/null | python3 -c "
import json,sys
s=[x for x in json.load(sys.stdin)['reali'] if x['id'].startswith('cccccccc')][0]
print(s['n_req'], s['n_grande'])"; }
uguale "contesto: un messaggio su piu' righe conta una volta" "$(contesto)" "3 2"
# La lettura incrementale riparte a meta' di un messaggio: la riga che arriva
# dopo ha lo stesso id dell'ultima letta e non e' una richiesta nuova.
risposta m3 160000 >> "$f"
uguale "contesto: un messaggio spezzato fra due letture conta una volta" "$(contesto)" "3 2"
risposta m4 1000 >> "$f"
uguale "contesto: la richiesta nuova in coda si conta" "$(contesto)" "4 2"
# Un /compact: si riparte da lì, col contesto che Claude Code dice rimasto.
# Segnalato dall'utente il 2026-10-04: il consiglio «fai /compact» restava.
dopo() { "$WD_ROOT/bin/claude-sessions.py" --format json 2>/dev/null | python3 -c "
import json,sys
s=[x for x in json.load(sys.stdin)['reali'] if x['id'].startswith('cccccccc')][0]
print(s['n_req'], s['n_grande'], s['ctx_ultimo'], s['compattata'])"; }
printf '{"type":"system","subtype":"compact_boundary","content":"Conversation compacted","timestamp":"2026-09-02T10:00:00Z","compactMetadata":{"trigger":"manual","preTokens":612472,"postTokens":14948}}\n' >> "$f"
uguale "contesto: un /compact azzera i conti e tiene il contesto rimasto" \
  "$(dopo)" "0 0 14948 2026-09-02T10:00:00Z"
risposta m5 300000 >> "$f"
uguale "contesto: dopo il /compact si riconta da capo" "$(dopo)" "1 1 300005 2026-09-02T10:00:00Z"
unset XDG_CACHE_HOME

# I consigli sulla quota: regole su numeri gia' contati, provate in tabella.
uguale "consigli: la regola su tutti i casi noti" "$(python3 - <<EOF
import importlib.util as u
from datetime import datetime, timezone, timedelta
s = u.spec_from_file_location('cm', '$WD_ROOT/bin/collect-metrics.py')
m = u.module_from_spec(s); s.loader.exec_module(m)
adesso = datetime(2026, 10, 3, 12, tzinfo=timezone.utc)
def iso(giorni): return (adesso - timedelta(days=giorni)).isoformat()
def sess(nome, req, grandi, dal, fino=0.1, ctx=200_000, compattata=None):
    return {"id": nome, "cwd": f"/lavoro/{nome}", "title": None, "n_req": req,
            "n_grande": grandi, "first": iso(dal), "last": iso(fino),
            "ctx_ultimo": ctx, "compattata": iso(compattata) if compattata else None}
soglie = {"pct": 50, "giorni": 7, "minimo": 20, "ore": 12}
H = 1 / 24   # un'ora, in giorni
casi = [
    ("pesante",    [sess("p", 100, 60, 1)],               ["p:contesto"]),
    ("leggera",    [sess("q", 100, 49, 1)],               []),
    ("poche",      [sess("r", 10, 10, 1)],                []),
    ("lunga",      [sess("l", 100, 0, 10)],               ["l:durata"]),
    ("entrambe",   [sess("e", 100, 90, 10)],              ["e:contesto+durata"]),
    ("ferma",      [sess("f", 100, 90, 20, fino=10)],     []),
    # Il contesto di adesso decide: dopo un /compact non c'e' piu' niente da
    # alleggerire, anche se prima era pesante e la sessione e' vecchia.
    ("compattata", [sess("k", 100, 90, 20, ctx=15_000)],  []),
    ("leggera ora", [sess("o", 100, 0, 10, ctx=60_000)],  []),
    # Ricresciuta dopo il /compact di ieri: pesa di nuovo, ma i giorni si
    # contano dal compact, quindi niente «durata».
    ("ricresciuta", [sess("g", 100, 80, 20, ctx=550_000, compattata=1)],
                    ["g:contesto"]),
    # Una sessione lasciata non consuma: chi ha seguito il consiglio e ne ha
    # aperta una nuova non deve rileggerlo per giorni. Conta l'ultima volta
    # che e' stata usata: entro 12 ore si', oltre no.
    ("lasciata",   [sess("v", 100, 90, 20, fino=13 * H)], []),
    ("in pausa",   [sess("w", 100, 90, 20, fino=11 * H)], ["w:contesto+durata"]),
    ("sostituita", [sess("x", 100, 90, 20, fino=14 * H),
                    sess("y", 5, 0, 0.1, ctx=20_000)],   []),
    ("tre",        [sess("a", 100, 60, 1), sess("b", 100, 90, 1),
                    sess("c", 100, 70, 1), sess("d", 100, 80, 1)],
                   ["b:contesto", "d:contesto", "c:contesto"]),
]
male = []
for nome, sessioni, atteso in casi:
    avuto = [f"{c['progetto']}:{'+'.join(c['motivi'])}"
             for c in m.consigli_quota(sessioni, None, adesso, soglie)]
    if avuto != atteso:
        male.append(f"{nome}: {avuto} invece di {atteso}")
print("; ".join(male) or "tutti")
EOF
)" "tutti"
uguale "consigli: la soglia del contesto grande e' la stessa nei due script" "$(python3 - <<EOF
import importlib.util as u
def carica(nome, f):
    s = u.spec_from_file_location(nome, f'$WD_ROOT/bin/{f}')
    m = u.module_from_spec(s); s.loader.exec_module(m); return m
print(carica('cm', 'collect-metrics.py').CONTESTO_GRANDE == carica('cs', 'claude-sessions.py').CONTESTO_GRANDE)
EOF
)" "True"

prepara_orfane
"$WD_ROOT/bin/collect-metrics.py" --quiet >/dev/null 2>&1
uguale "collect-metrics: pubblica la voce delle sessioni orfane" \
  "$(python3 -c "
import json
d=json.load(open('$HOME/.local/share/claude-code-watchdog/metrics.json'))
print([v['dettaglio'] for v in d['recuperabile']['voci'] if v['target']=='claude-orfane'])")" \
  "['2 sessioni automatiche in cartelle sparite']"
uguale "reclaim: claude-orfane elenca due trascrizioni" \
  "$("$WD_ROOT/bin/reclaim.py" --json claude-orfane 2>/dev/null \
     | python3 -c 'import json,sys;print(json.load(sys.stdin)["voci"][0]["file"])')" "2"
uguale "reclaim: claude-orfane senza --apply non tocca niente" \
  "$(find "$HOME/.claude/projects"/-orf-* -name '*.jsonl' | wc -l)" "8"
"$WD_ROOT/bin/reclaim.py" --apply claude-orfane >/dev/null 2>&1
uguale "reclaim: claude-orfane non tocca le sessioni escluse" \
  "$(find "$HOME/.claude/projects"/-orf-* -name '*.jsonl' ! -name 'aaaaaaaa-*' | wc -l)" "6"
uguale "reclaim: claude-orfane le manda nel cestino" \
  "$(ls "$HOME/.local/share/Trash/files" | grep -c '^aaaaaaaa-')" "2"
# La cartella di A resta vuota (memory/ vuota compresa) e se ne va; quella di
# B ospita anche C, un backup interattivo, e deve restare.
uguale "reclaim: claude-orfane toglie la cartella rimasta vuota" \
  "$([[ -e "$HOME/.claude/projects/-orf-a" ]] && echo c-e || echo tolta)" "tolta"
uguale "reclaim: claude-orfane lascia la cartella che ha altre sessioni" \
  "$(ls "$HOME/.claude/projects/-orf-misto")" "cccccccc-0000-0000-0000-00000000000c.jsonl"

# Lo staging di Claude Code non è cache: è la versione che sta scaricando,
# ~220 MB che compaiono in pochi secondi. Contarla faceva sbattere la barra al
# massimo a ogni aggiornamento, e il target di pulizia avrebbe potuto
# cestinare il download a metà.
prepara
mkdir -p "$HOME/.cache/claude/staging" "$HOME/.cache/claude-cli-nodejs/p"
head -c 3000000 /dev/zero > "$HOME/.cache/claude/staging/versione-nuova"
echo log > "$HOME/.cache/claude-cli-nodejs/p/mcp.log"
"$WD_ROOT/bin/collect-metrics.py" --quiet >/dev/null 2>&1
# 1 MB e non 0: du arrotonda a 1 la cartella dei log. Senza l'esclusione
# sarebbero 4, perche' lo staging finto pesa 3 MB.
uguale "cache: lo staging non entra nella misura" \
  "$(python3 -c "import json;print(json.load(open('$HOME/.local/share/claude-code-watchdog/metrics.json'))['claude']['cacheMb'])")" "1"
touch -d "30 days ago" "$HOME/.cache/claude/staging/versione-nuova"
"$WD_ROOT/bin/reclaim.py" --apply claude-cache >/dev/null 2>&1
uguale "cache: la pulizia non tocca il download in corso" \
  "$([[ -f "$HOME/.cache/claude/staging/versione-nuova" ]] && echo intatto || echo sparito)" "intatto"

# Le due strade di stale_mb devono dare lo stesso numero: `find` è quella
# usata, la scansione Python è il ripiego se find manca. Se divergessero, il
# pannello annuncerebbe una cifra e il ripiego un'altra, a seconda della
# macchina.
prepara
mkdir -p "$SANDBOX/scad/dentro"
head -c 4000000 /dev/zero > "$SANDBOX/scad/vecchio"
head -c 2000000 /dev/zero > "$SANDBOX/scad/dentro/pure-vecchio"
echo nuovo > "$SANDBOX/scad/recente"
touch -d "100 days ago" "$SANDBOX/scad/vecchio" "$SANDBOX/scad/dentro/pure-vecchio"
ln -sfn "$SANDBOX/scad/vecchio" "$SANDBOX/scad/collegamento"
uguale "stale_mb: find e il ripiego Python concordano" \
  "$(python3 -c "
import importlib.util as u
from pathlib import Path
s=u.spec_from_file_location('cm','$WD_ROOT/bin/collect-metrics.py');m=u.module_from_spec(s);s.loader.exec_module(m)
d=Path('$SANDBOX/scad')
a=m.stale_mb(d,60); b=m._stale_mb_python(d,60)
print(f'{a} {b}' if a==b else f'DIVERSI {a} {b}')")" "5 5"
uguale "stale_mb: non conta i file recenti" \
  "$(python3 -c "
import importlib.util as u
from pathlib import Path
s=u.spec_from_file_location('cm','$WD_ROOT/bin/collect-metrics.py');m=u.module_from_spec(s);s.loader.exec_module(m)
print(m.stale_mb(Path('$SANDBOX/scad'),200))")" "0"

# Il conto di ~/.cache stantia si tiene da parte perche' costa 40.000 file.
# Una memoria su un numero che il pulsante fa scendere e' pericolosa: puo'
# annunciare spazio gia' liberato.
prepara
export XDG_CACHE_HOME="$HOME/.cache"
mkdir -p "$HOME/.cache/vecchiume"
head -c 5000000 /dev/zero > "$HOME/.cache/vecchiume/grosso"
touch -d "200 days ago" "$HOME/.cache/vecchiume/grosso"
mem="$HOME/.cache/claude-code-watchdog/usercache.json"
"$WD_ROOT/bin/collect-metrics.py" --quiet >/dev/null 2>&1
uguale "memoria cache: scrive il conto" \
  "$([[ -f "$mem" ]] && echo si || echo no)" "si"
uguale "memoria cache: con una retention diversa ricalcola" \
  "$(python3 -c "
import importlib.util as u, json, os
s=u.spec_from_file_location('cm','$WD_ROOT/bin/collect-metrics.py');m=u.module_from_spec(s);s.loader.exec_module(m)
a=m.cache_stantia_mb(100)
d=json.load(open('$mem'))
print(d['giorni'])")" "100"
# La pulizia deve buttarla: se no il pannello annuncia spazio gia' tolto.
"$WD_ROOT/bin/collect-metrics.py" --quiet >/dev/null 2>&1
"$WD_ROOT/bin/reclaim.py" --apply usercache >/dev/null 2>&1
uguale "memoria cache: la pulizia la invalida" \
  "$([[ -f "$mem" ]] && echo resta || echo buttata)" "buttata"
unset XDG_CACHE_HOME

# Lettura incrementale: le trascrizioni si scrivono in coda, e quella viva
# arriva a decine di MB. Riprendere dal punto raggiunto e' il risparmio piu'
# grosso, ma sbagliarlo da' numeri plausibili e falsi.
prepara
export XDG_CACHE_HOME="$HOME/.cache"
d="$HOME/.claude/projects/-inc"; mkdir -p "$d"
f="$d/cafe0000-0000-0000-0000-000000000001.jsonl"
for i in 1 2 3 4 5; do
  printf '{"type":"user","cwd":"/tmp/p","timestamp":"2026-09-01T10:00:0%sZ","message":{"role":"user","content":"x"}}\n' "$i"
  printf '{"type":"assistant","cwd":"/tmp/p","timestamp":"2026-09-01T10:00:0%sZ","message":{"role":"assistant"}}\n' "$i"
done > "$f"
conta() { "$WD_ROOT/bin/claude-sessions.py" --format json 2>/dev/null \
  | python3 -c "
import json,sys
r=[s for s in json.load(sys.stdin)['reali'] if s['id'].startswith('cafe')]
print(r[0]['n_msg'] if r else 'assente')"; }
uguale "incrementale: prima lettura" "$(conta)" "10"
printf '{"type":"user","cwd":"/tmp/p","timestamp":"2026-09-01T10:00:09Z","message":{"role":"user","content":"ancora"}}\n' >> "$f"
uguale "incrementale: somma solo la coda nuova" "$(conta)" "11"

# Riscrittura che FA CRESCERE il file: la cwd nuova e' piu' lunga, come quando
# fix-cwd.py corregge un percorso. E' il caso insidioso — piu' corto cadrebbe
# gia' nel ramo della rilettura completa e non proverebbe niente. La crescita
# deve coprire piu' di un record intero, se no la coda nuova non contiene
# nessuna riga e il conteggio resta giusto per caso: verificato con una
# mutazione, la prima versione di questa prova passava anche senza il
# controllo sulla testa.
python3 - "$f" <<'EOF'
import sys
p = sys.argv[1]
righe = open(p).read().splitlines()
open(p, 'w').write("\n".join(
    r.replace('/tmp/p', '/tmp/percorso-molto-piu-lungo-di-prima') for r in righe) + "\n")
EOF
uguale "incrementale: un file riscritto e cresciuto si rilegge da capo" "$(conta)" "11"
unset XDG_CACHE_HOME

# collect-metrics importa claude-sessions invece di lanciarlo (0,004 s contro
# 0,085), ma tiene il sottoprocesso come ripiego. Due strade per lo stesso
# numero sono due strade che possono divergere: qui si controlla che non lo
# facciano, perche' quale venga usata dipende da come e' stato installato.
prepara
uguale "sessioni: import e sottoprocesso danno lo stesso inventario" \
  "$(python3 -c "
import importlib.util as u, json, subprocess, sys
s=u.spec_from_file_location('cs','$WD_ROOT/bin/claude-sessions.py');m=u.module_from_spec(s);s.loader.exec_module(m)
reali,dup,stub = m.inventario()
a = (len(reali), len(dup), len(stub), sum(x['n_msg'] for x in reali))
r = subprocess.run([sys.executable,'$WD_ROOT/bin/claude-sessions.py','--format','json'],
                   capture_output=True, text=True)
d = json.loads(r.stdout)
b = (len(d['reali']), len(d['duplicati']), len(d['fantasma']),
     sum(x['n_msg'] for x in d['reali']))
print('uguali' if a==b else f'DIVERSI {a} {b}')")" "uguali"

# La scomposizione di ~/.claude si fa con un `du` solo sui figli invece di
# sette sull'intero albero. Il rischio e' che i numeri non tornino piu':
# arrotondare ogni parte e poi sommare gonfiava il totale di 24 MB su 407.
prepara
mkdir -p "$HOME/.claude/projects" "$HOME/.claude/plugins" "$HOME/.claude/security"
head -c 3000000 /dev/zero > "$HOME/.claude/projects/grosso"
head -c 2000000 /dev/zero > "$HOME/.claude/plugins/medio"
head -c 1000000 /dev/zero > "$HOME/.claude/security/piccolo"
uguale "scomposizione: le parti sommano al totale" \
  "$(python3 -c "
import importlib.util as u
s=u.spec_from_file_location('cm','$WD_ROOT/bin/collect-metrics.py');m=u.module_from_spec(s);s.loader.exec_module(m)
tot, parti = m.claude_scomposizione()
print('uguali' if sum(parti.values()) == tot else f'DIVERSI {sum(parti.values())} vs {tot}')")" "uguali"
uguale "scomposizione: concorda con du entro 1 MB" \
  "$(python3 -c "
import importlib.util as u, subprocess, os
s=u.spec_from_file_location('cm','$WD_ROOT/bin/collect-metrics.py');m=u.module_from_spec(s);s.loader.exec_module(m)
tot, _ = m.claude_scomposizione()
rif = int(subprocess.run(['du','-sm','--one-file-system',os.path.expanduser('$HOME/.claude')],
                          capture_output=True, text=True).stdout.split()[0])
print('vicini' if abs(tot - rif) <= 1 else f'LONTANI {tot} vs {rif}')")" "vicini"

# ------------------------------------------------- collect-metrics.py ---
prepara
"$WD_ROOT/bin/collect-metrics.py" --quiet >/dev/null 2>&1
M="$HOME/.local/share/claude-code-watchdog/metrics.json"
[[ -f "$M" ]] && ok "collect-metrics: scrive metrics.json" || ko "collect-metrics: scrive metrics.json"
uguale "collect-metrics: conta le conversazioni" \
  "$(python3 -c "import json;print(json.load(open('$M'))['claude']['conversazioni'])")" "1"
uguale "collect-metrics: scompone lo spazio" \
  "$(python3 -c "import json;print('scomposizione' in json.load(open('$M'))['claude'])")" "True"
uguale "collect-metrics: fondoscala della cache di Claude, non di tutta ~/.cache" \
  "$(python3 -c "import json;print(json.load(open('$M'))['soglie']['cacheMb'])")" "200"
uguale "collect-metrics: pubblica chi occupa piu' cache" \
  "$(python3 -c "import json;print('cacheTop' in json.load(open('$M'))['claude'])")" "True"
uguale "collect-metrics: pubblica le soglie" \
  "$(python3 -c "import json;print(json.load(open('$M'))['soglie']['attenzione'])")" "75"

# La copia dentro l'estensione deve funzionare come quella nel progetto:
# è il difetto che faceva riportare una macchina vuota.
COPIA="$SANDBOX/finta-estensione"; mkdir -p "$COPIA"
cp "$WD_ROOT/bin/collect-metrics.py" "$WD_ROOT/bin/claude-sessions.py" \
   "$WD_ROOT/bin/reclaim.py" "$WD_ROOT/bin/trash-scaduti.py" "$COPIA/"
rm -f "$M"; (cd "$COPIA" && ./collect-metrics.py --quiet >/dev/null 2>&1)
uguale "collect-metrics: funziona anche copiato fuori da bin/" \
  "$(python3 -c "import json;print(json.load(open('$M'))['claude']['conversazioni'])" 2>/dev/null)" "1"
uguale "collect-metrics: senza progetto non inventa una radice" \
  "$(python3 -c "import json;print(json.load(open('$M'))['progetto'])" 2>/dev/null)" "None"
# La copia legge il watchdog.conf che le sta accanto: prima tornava ai
# predefiniti e il pannello ignorava ogni soglia del file.
printf 'ALERT_WARN_PCT=60\nTRASH_RETENTION_DAYS=5\n' > "$COPIA/watchdog.conf"
rm -f "$M"; (cd "$COPIA" && ./collect-metrics.py --quiet >/dev/null 2>&1)
uguale "collect-metrics: la copia legge il watchdog.conf accanto" \
  "$(python3 -c "import json;print(json.load(open('$M'))['soglie']['attenzione'])" 2>/dev/null)" "60"
uguale "reclaim: la copia legge il watchdog.conf accanto" \
  "$(cd "$COPIA" && python3 -c "import reclaim;print(reclaim.giorni('trash'))")" "5"
rm -f "$COPIA/watchdog.conf"

# Una sessione aperta in una sottocartella del progetto: capita ogni volta che
# si lavora dentro un repository clonato li'. Deve restare dentro la radice e
# chiamarsi col percorso relativo, se no due «src» di progetti diversi
# sarebbero due righe con lo stesso nome.
prepara
mkdir -p "$SANDBOX/lavoro/progetto/sub"
d="$HOME/.claude/projects/-sotto"
mkdir -p "$d"
printf '{"type":"user","cwd":"%s","timestamp":"2026-09-01T10:00:00Z","message":{"role":"user","content":"x"}}\n{"type":"assistant","cwd":"%s","timestamp":"2026-09-01T10:00:01Z","message":{"role":"assistant"}}\n' \
  "$SANDBOX/lavoro/progetto/sub" "$SANDBOX/lavoro/progetto/sub" \
  > "$d/cccccccc-0000-0000-0000-000000000003.jsonl"
"$WD_ROOT/bin/collect-metrics.py" --quiet --radice-progetti "$SANDBOX/lavoro" >/dev/null 2>&1
uguale "collect-metrics: un progetto annidato porta il percorso relativo nel nome" \
  "$(python3 -c "
import json,sys
d=json.load(open('$M'))
n=[p['nome'] for p in d['claude']['progetti'] if p['percorso'].endswith('/progetto/sub')]
print(n[0] if n else 'assente')")" "progetto/sub"

# La radice non deve farsi avvelenare dalle sottocartelle. Due sessioni aperte
# in `progetto/src` e `progetto/docs` votano per `progetto`, che cosi' verrebbe
# eletto radice: i progetti fratelli finirebbero tutti «fuori dai progetti» e
# ogni sottocartella di `progetto` comparirebbe come progetto a zero sessioni.
# La sandbox sta sotto la home finta e non sotto /tmp, che la deduzione scarta.
prepara
mkdir -p "$HOME/L/a/src" "$HOME/L/a/docs" "$HOME/L/b" "$HOME/L/mai-usato"
i=0
for cwd in "$HOME/L/a" "$HOME/L/b" "$HOME/L/a/src" "$HOME/L/a/docs"; do
  i=$((i+1)); dd="$HOME/.claude/projects/-vot$i"; mkdir -p "$dd"
  printf '{"type":"user","cwd":"%s","timestamp":"2026-09-01T10:00:00Z","message":{"role":"user","content":"x"}}\n{"type":"assistant","cwd":"%s","timestamp":"2026-09-01T10:00:01Z","message":{"role":"assistant"}}\n' \
    "$cwd" "$cwd" > "$dd/9000000$i-0000-0000-0000-00000000000$i.jsonl"
done
"$WD_ROOT/bin/collect-metrics.py" --quiet >/dev/null 2>&1
uguale "radice: le sottocartelle non fanno eleggere il progetto come radice" \
  "$(python3 -c "
import json;d=json.load(open('$M'))
r=d['radiceProgetti'] or ''
print(r.rsplit('/',1)[-1] if r else 'nessuna')")" "L"
uguale "radice: il progetto fratello resta dentro" \
  "$(python3 -c "
import json;d=json.load(open('$M'))
n=[p for p in d['claude']['progetti'] if p['percorso'].endswith('/L/b')]
print(n[0]['dentroRadice'] if n else 'assente')")" "True"
uguale "radice: le cartelle senza conversazioni portano dentroRadice" \
  "$(python3 -c "
import json;d=json.load(open('$M'))
z=[p for p in d['claude']['progetti'] if p['sessioni']==0]
print(all('dentroRadice' in p for p in z) if z else 'nessuna')")" "True"

# Senza radice dedotta il campo non si emette, se no la sezione «Progetti» si
# svuoterebbe mentre il «+» continua a proporre la home.
prepara
"$WD_ROOT/bin/collect-metrics.py" --quiet >/dev/null 2>&1
uguale "radice: senza radice dedotta non si scrive dentroRadice" \
  "$(python3 -c "
import json;d=json.load(open('$M'))
print(d['radiceProgetti'] is None and not any('dentroRadice' in p for p in d['claude']['progetti']))")" "True"

# Il ripiegamento dei candidati annidati deve essere condizionale: si ripiega
# un candidato solo se e' ESSO STESSO la cartella di lavoro di un progetto.
# Senza la condizione, una sessione aperta in una cartella sorella (Scaricati)
# sposterebbe la radice un livello piu' su e il pannello elencherebbe
# Scaricati e Immagini come progetti.
prepara
mkdir -p "$HOME/D/Claude/a" "$HOME/D/Claude/b" "$HOME/D/Claude/c" "$HOME/D/Scaricati"
i=0
for cwd in "$HOME/D/Claude/a" "$HOME/D/Claude/b" "$HOME/D/Claude/c" "$HOME/D/Scaricati"; do
  i=$((i+1)); dd="$HOME/.claude/projects/-sor$i"; mkdir -p "$dd"
  printf '{"type":"user","cwd":"%s","timestamp":"2026-09-01T10:00:00Z","message":{"role":"user","content":"x"}}\n{"type":"assistant","cwd":"%s","timestamp":"2026-09-01T10:00:01Z","message":{"role":"assistant"}}\n' \
    "$cwd" "$cwd" > "$dd/8000000$i-0000-0000-0000-00000000000$i.jsonl"
done
"$WD_ROOT/bin/collect-metrics.py" --quiet >/dev/null 2>&1
uguale "radice: una sessione in una cartella sorella non la sposta piu' su" \
  "$(python3 -c "
import json;d=json.load(open('$M'))
r=d['radiceProgetti'] or ''
print('/'.join(r.rsplit('/',2)[-2:]) if r else 'nessuna')")" "D/Claude"

# La deduzione della radice, caso per caso e su cartelle vere. Tre versioni di
# questa regola hanno sbagliato: contare i genitori dei cwd non basta, e
# nemmeno ripiegare i candidati annidati. Si contano i PROGETTI che ogni
# possibile radice avrebbe, cioe' le sue figlie diritte che contengono un cwd.
prepara
uguale "radice: la regola su tutti i casi noti" \
  "$(python3 - "$WD_ROOT" "$SANDBOX/rad" <<'EOF'
import importlib.util as u, os, sys
from pathlib import Path
s = u.spec_from_file_location("cm", sys.argv[1] + "/bin/collect-metrics.py")
m = u.module_from_spec(s); s.loader.exec_module(m)
base = sys.argv[2]
casi = [
  ("progetti e sottocartelle di uno",      ["L/a","L/b","L/a/src","L/a/docs"], "L"),
  ("sessioni SOLO nelle sottocartelle",    ["L2/a/src","L2/a/docs","L2/b"],    "L2"),
  ("una sessione in una cartella sorella", ["D/Claude/a","D/Claude/b","D/Claude/c","D/Scaricati"], "D/Claude"),
  ("catena profonda",                      ["K/b/c/x","K/b/c","K/d"],          "K"),
  ("un progetto solo, non si indovina",    ["S/uno"],                          None),
]
# Una cartella SOPRA la home: nella sandbox e' il livello che contiene la home
# finta. Farebbe due «progetti» (la home e la cartella accanto) ed essendo meno
# profonda vincerebbe il pareggio. Niente che stia sopra la home e' una radice.
sopra = os.path.dirname(os.environ["HOME"])
assoluti = [
  ("cartelle sopra la home fuori gara",
   [f"{os.environ['HOME']}/D/Cl/a", f"{os.environ['HOME']}/D/Cl/b",
    f"{sopra}/accanto/cliente"],
   f"{os.environ['HOME']}/D/Cl"),
]
rotti = []
for nome, rel, atteso in casi:
    for r in rel:
        os.makedirs(f"{base}/{r}", exist_ok=True)
    got = m.radice_progetti(None, [{"percorso": f"{base}/{r}"} for r in rel])
    att = f"{base}/{atteso}" if atteso else None
    if (str(got) if got else None) != att:
        rotti.append(nome)
for nome, percorsi, atteso in assoluti:
    for pc in percorsi:
        os.makedirs(pc, exist_ok=True)
    got = m.radice_progetti(None, [{"percorso": pc} for pc in percorsi])
    if (str(got) if got else None) != atteso:
        rotti.append(nome)
print(",".join(rotti) if rotti else "tutti")
EOF
)" "tutti"

# Limite noto, fissato apposta: quando UN progetto ha piu' sottocartelle con
# sessioni di quanti progetti abbia la radice, vince il progetto. Con
# `L/a/src`, `L/a/docs`, `L/a/test` e `L/b`, `L/a` fa 3 e `L` fa 2. Dai soli
# dati le due letture sono equivalenti; si risolve scrivendo la radice nelle
# preferenze. La prova sta qui perche' il giorno che la regola cambia si
# sappia che questo comportamento cambia con lei.
uguale "radice: limite noto, un progetto con piu' sottocartelle della radice" \
  "$(python3 - "$WD_ROOT" "$SANDBOX/lim" <<'EOF'
import importlib.util as u, os, sys
s = u.spec_from_file_location("cm", sys.argv[1] + "/bin/collect-metrics.py")
m = u.module_from_spec(s); s.loader.exec_module(m)
base = sys.argv[2]
rel = ["L/a/src", "L/a/docs", "L/a/test", "L/b"]
for r in rel:
    os.makedirs(f"{base}/{r}", exist_ok=True)
got = m.radice_progetti(None, [{"percorso": f"{base}/{r}"} for r in rel])
print(str(got).replace(base + "/", ""))
EOF
)" "L/a"

# La regola «dentro la radice», caso per caso. Sta in Python apposta per
# poterla provare: in extension.js non si poteva, e sbagliarla ha fatto
# comparire un progetto vero fra quelli «fuori dai progetti».
uguale "dentro-radice: figlia diretta" \
  "$(python3 -c "
import sys;sys.path.insert(0,'$WD_ROOT/bin')
import importlib.util as u
s=u.spec_from_file_location('cm','$WD_ROOT/bin/collect-metrics.py');m=u.module_from_spec(s);s.loader.exec_module(m)
from pathlib import Path
print(m.dentro_radice('/casa/Claude/progetto', Path('/casa/Claude')))")" "True"
uguale "dentro-radice: annidata in profondita'" \
  "$(python3 -c "
import importlib.util as u
s=u.spec_from_file_location('cm','$WD_ROOT/bin/collect-metrics.py');m=u.module_from_spec(s);s.loader.exec_module(m)
from pathlib import Path
print(m.dentro_radice('/casa/Claude/prog/src/interno', Path('/casa/Claude')))")" "True"
uguale "dentro-radice: non si fa ingannare da un nome che inizia uguale" \
  "$(python3 -c "
import importlib.util as u
s=u.spec_from_file_location('cm','$WD_ROOT/bin/collect-metrics.py');m=u.module_from_spec(s);s.loader.exec_module(m)
from pathlib import Path
print(m.dentro_radice('/casa/Claude-vecchio/prog', Path('/casa/Claude')))")" "False"
uguale "dentro-radice: fuori del tutto" \
  "$(python3 -c "
import importlib.util as u
s=u.spec_from_file_location('cm','$WD_ROOT/bin/collect-metrics.py');m=u.module_from_spec(s);s.loader.exec_module(m)
from pathlib import Path
print(m.dentro_radice('/tmp/prog', Path('/casa/Claude')))")" "False"
uguale "dentro-radice: senza radice nota non afferma niente" \
  "$(python3 -c "
import importlib.util as u
s=u.spec_from_file_location('cm','$WD_ROOT/bin/collect-metrics.py');m=u.module_from_spec(s);s.loader.exec_module(m)
print(m.dentro_radice('/casa/Claude/prog', None))")" "False"

# Cartelle di progetto senza conversazioni. La sandbox lavora sotto /tmp, che
# la deduzione scarta apposta: lì dentro ci sono decine di cartelle che non
# sono progetti di nessuno.
prepara
"$WD_ROOT/bin/collect-metrics.py" --quiet >/dev/null 2>&1
uguale "collect-metrics: non deduce una radice dai progetti in /tmp" \
  "$(python3 -c "import json;print(json.load(open('$M'))['radiceProgetti'])")" "None"

# Con la radice passata dall'estensione, le cartelle senza conversazioni
# compaiono con zero sessioni accanto a quelle vere.
mkdir -p "$SANDBOX/lavoro/appena-creato" "$SANDBOX/lavoro/.nascosta"
"$WD_ROOT/bin/collect-metrics.py" --quiet --radice-progetti "$SANDBOX/lavoro" >/dev/null 2>&1
uguale "collect-metrics: elenca le cartelle senza conversazioni" \
  "$(python3 -c "import json;d=json.load(open('$M'));print(sorted(p['nome'] for p in d['claude']['progetti'] if p['sessioni']==0))")" \
  "['appena-creato', 'progetto']"
uguale "collect-metrics: salta le cartelle nascoste" \
  "$(python3 -c "import json;d=json.load(open('$M'));print(any(p['nome'].startswith('.') for p in d['claude']['progetti']))")" "False"

# Una radice che non esiste non deve far saltare la raccolta né inventare voci.
"$WD_ROOT/bin/collect-metrics.py" --quiet --radice-progetti "$SANDBOX/non-esiste" >/dev/null 2>&1
uguale "collect-metrics: una radice inesistente non aggiunge niente" \
  "$(python3 -c "import json;d=json.load(open('$M'));print(d['radiceProgetti'], sum(1 for p in d['claude']['progetti'] if p['sessioni']==0))")" \
  "None 0"

# --------------------------------------------------- session-purge.py ---
prepara
uguale "session-purge: rifiuta un id non valido" \
  "$("$WD_ROOT/bin/session-purge.py" '../../etc' --json >/dev/null 2>&1; echo $?)" "2"
n=$("$WD_ROOT/bin/session-purge.py" aaaaaaaa-0000-0000-0000-000000000001 --json 2>/dev/null \
    | python3 -c 'import json,sys;print(len(json.load(sys.stdin)["voci"]))')
[[ "$n" -ge 2 ]] && ok "session-purge: trova trascrizione e ambiente" \
                 || ko "session-purge: trova trascrizione e ambiente" "trovati $n elementi"

# --------------------------------------------------- project-purge.py ---
prepara
out=$("$WD_ROOT/bin/project-purge.py" /tmp/progetto --json 2>/dev/null)
uguale "project-purge: non elenca la cartella di lavoro" \
  "$(echo "$out" | python3 -c 'import json,sys;print(any("/tmp/progetto"==v["percorso"] for v in json.load(sys.stdin)["voci"]))')" "False"

# ------------------------------------------------ project-relocate.py ---
prepara
out=$("$WD_ROOT/bin/project-relocate.py" /tmp/progetto "$SANDBOX/lavoro/progetto" --json 2>/dev/null)
uguale "project-relocate: riconosce la cartella giusta dalle prove" \
  "$(echo "$out" | python3 -c 'import json,sys;print(json.load(sys.stdin)["verdetto"])')" "sicuro"
out=$("$WD_ROOT/bin/project-relocate.py" /tmp/progetto "$SANDBOX/lavoro" --json 2>/dev/null)
uguale "project-relocate: rifiuta la cartella sbagliata" \
  "$(echo "$out" | python3 -c 'import json,sys;print(json.load(sys.stdin)["verdetto"])')" "no"

# La codifica deve essere la stessa ovunque: due implementazioni divergenti
# facevano cercare la trascrizione nella cartella sbagliata.
uguale "codifica cartelle: coerente fra gli script" \
  "$(python3 - <<'PY'
import importlib.util, sys, pathlib
sys.dont_write_bytecode = True
def carica(n, p):
    s = importlib.util.spec_from_file_location(n, p); m = importlib.util.module_from_spec(s)
    s.loader.exec_module(m); return m
import os
R = os.environ['WD_ROOT']
cu = carica('cu', f'{R}/bin/collect-usage.py')
pr = carica('pr', f'{R}/bin/project-relocate.py')
fc = carica('fc', f'{R}/bin/fix-cwd.py')
p = '/home/tizio/Progetti/roba_mia.v2'
print(len({pr.codifica(p), fc.codifica(p)}) == 1)
PY
)" "True"

# ------------------------------------------------------ trash-scaduti ---
prepara
mkdir -p "$HOME/.local/share/Trash/files" "$HOME/.local/share/Trash/info"
echo x > "$HOME/.local/share/Trash/files/vecchio.txt"
touch -d '2020-01-01' "$HOME/.local/share/Trash/files/vecchio.txt"   # mtime antico
printf '[Trash Info]\nPath=/home/tizio/vecchio.txt\nDeletionDate=%s\n' \
  "$(date -d 'yesterday' +%Y-%m-%dT%H:%M:%S)" > "$HOME/.local/share/Trash/info/vecchio.txt.trashinfo"
uguale "trash-scaduti: non pota un file buttato ieri (anche se vecchio)" \
  "$("$WD_ROOT/bin/trash-scaduti.py" 30 | wc -l)" "0"
printf '[Trash Info]\nPath=/home/tizio/vecchio.txt\nDeletionDate=%s\n' \
  "$(date -d '60 days ago' +%Y-%m-%dT%H:%M:%S)" > "$HOME/.local/share/Trash/info/vecchio.txt.trashinfo"
uguale "trash-scaduti: pota un file buttato due mesi fa" \
  "$("$WD_ROOT/bin/trash-scaduti.py" 30 | wc -l)" "1"

# ------------------------------------------------------------ clean.sh ---
prepara
uguale "clean.sh: rifiuta un target sconosciuto" \
  "$("$WD_ROOT/bin/clean.sh" pippo >/dev/null 2>&1; echo $?)" "2"
uguale "clean.sh: senza --apply non cancella niente" \
  "$("$WD_ROOT/bin/clean.sh" claude-stubs 2>/dev/null | grep -c 'comando:')" "1"

# ------------------------------------------------------ watchface-hook ---
# Gira a ogni passo di Claude: niente output (per PermissionRequest lo stdout
# e' una risposta), uscita sempre 0, nessun percorso fuori dalla sua cartella.
prepara
export XDG_RUNTIME_DIR="$SANDBOX/run"
mkdir -p "$XDG_RUNTIME_DIR"
# Le prove possono girare dentro Claude Code, che esporta l'entrypoint.
unset CLAUDE_CODE_ENTRYPOINT WATCHFACE_IGNORA CLAUDE_PID
WF="$XDG_RUNTIME_DIR/claude-code-watchdog/watchface"
hook() { # hook EVENTO SESSIONE [CWD]
  printf '{"session_id":"%s","transcript_path":"/x.jsonl","cwd":"%s","hook_event_name":"%s","tool_name":"Bash"}' \
    "$2" "${3:-/lavoro/prog}" "$1" | "$WD_ROOT/bin/watchface-hook" "$1"
}
campo() { cut -f"$2" "$WF/$1" 2>/dev/null; }
uscita=$(hook PreToolUse s1; echo "rc=$?")
uguale "watchface-hook: nessun output, uscita 0" "$uscita" "rc=0"
uguale "watchface-hook: scrive evento e cartella" "$(campo s1 1)|$(campo s1 5)" "PreToolUse|/lavoro/prog"
WATCHFACE_IGNORA=1 hook SessionStart quota
uguale "watchface-hook: ignora le sessioni del watchdog (lettura quota)" \
  "$([[ -e $WF/quota ]] && echo c-e || echo assente)" "assente"
CLAUDE_CODE_ENTRYPOINT=sdk-cli hook SessionStart automatica
CLAUDE_CODE_ENTRYPOINT=cli hook SessionStart terminale
uguale "watchface-hook: ignora le sessioni avviate da un programma, non quelle nel terminale" \
  "$([[ -e $WF/automatica ]] && echo c-e || echo assente)|$([[ -e $WF/terminale ]] && echo c-e || echo assente)" "assente|c-e"
CLAUDE_PID=4321 hook PreToolUse conpid
CLAUDE_PID='12; rm -rf /' hook PreToolUse pidstorto
uguale "watchface-hook: scrive il pid di claude, e solo se e' un numero" \
  "$(campo conpid 6)|$(campo pidstorto 6)" "4321|"
# Un bash senza EPOCHSECONDS (prima della 5.0): l'ora resta quella vera.
printf '{"session_id":"vecchiobash","cwd":"/lavoro/prog"}' \
  | bash -c 'unset EPOCHSECONDS; . "$0" PreToolUse' "$WD_ROOT/bin/watchface-hook"
uguale "watchface-hook: scrive l'ora giusta anche senza EPOCHSECONDS" \
  "$(( $(date +%s) - $(campo vecchiobash 2) < 5 ))" "1"
hook PreToolUse '../../fuori' >/dev/null
uguale "watchface-hook: rifiuta un id con ../" \
  "$(find "$SANDBOX" -name fuori | wc -l)" "0"
for i in 1 2 3; do hook PostToolUseFailure s1; done
uguale "watchface-hook: conta i fallimenti di fila" "$(campo s1 3)" "3"
hook PreToolUse s1
uguale "watchface-hook: PreToolUse non azzera i fallimenti" "$(campo s1 3)" "3"
hook PostToolUse s1
uguale "watchface-hook: un successo li azzera" "$(campo s1 3)" "0"
hook SubagentStart s1; hook SubagentStart s1; hook SubagentStop s1
uguale "watchface-hook: senza agent_id conta gli aiutanti" "$(campo s1 4)" "1"
hook SubagentStop s1; hook SubagentStop s1
uguale "watchface-hook: gli aiutanti non scendono sotto zero" "$(campo s1 4)" "0"
# Con agent_id si conta per id. I casi, dagli eventi veri del 2026-10-03:
# Claude Code manda SubagentStop per agenti interni mai partiti, e un aiutante
# che si risveglia da un lavoro in background manda di nuovo SubagentStart.
aiuto() { # aiuto EVENTO SESSIONE AGENT_ID
  printf '{"session_id":"%s","cwd":"/lavoro/prog","agent_id":"%s","agent_type":"x","hook_event_name":"%s"}' \
    "$2" "$3" "$1" | "$WD_ROOT/bin/watchface-hook" "$1"
}
hook SessionStart s4
aiuto SubagentStart s4 a1; aiuto SubagentStop s4 interno
uguale "watchface-hook: lo Stop di un agente mai partito non toglie un aiutante" "$(campo s4 4)" "1"
aiuto SubagentStart s4 a1
uguale "watchface-hook: lo stesso aiutante avviato due volte conta uno" "$(campo s4 4)" "1"
aiuto SubagentStop s4 a1; aiuto SubagentStart s4 a1
uguale "watchface-hook: un aiutante che si risveglia torna" "$(campo s4 4)" "1"
aiuto SubagentStart s4 a2; aiuto SubagentStop s4 a2
uguale "watchface-hook: finisce quello giusto" \
  "$(campo s4 4)|$(cut -f1 "$WF/s4.aiutanti")" "1|a1"
hook SessionStart s4
uguale "watchface-hook: SessionStart azzera l'elenco" "$(campo s4 4)" "0"
for i in $(seq 12); do aiuto SubagentStart s4 "p$i" & done; wait
uguale "watchface-hook: dodici aiutanti in parallelo sono dodici" "$(campo s4 4)" "12"
# Un aiutante che finisce senza che il suo Stop arrivi qui resterebbe contato
# per sempre: succede perche' gli aiutanti in background girano in processi
# `claude` figli, con un session_id loro, e lo Stop finisce nel file del
# figlio. Il 2026-10-06 una sessione ne mostrava sette, fermi da quattro ore.
# Si potano per eta', a ogni evento, non solo ai Subagent*.
_ora=$(date +%s)
hook SessionStart s5
printf 'vecchio1\t%s\nvecchio2\t%s\nfresco\t%s\n' \
  $((_ora-14400)) $((_ora-14400)) $((_ora-60)) > "$WF/s5.aiutanti"
hook PostToolUse s5
uguale "watchface-hook: gli aiutanti fermi da ore non si contano piu'" \
  "$(campo s5 4)|$(cut -f1 "$WF/s5.aiutanti" | tr '\n' ' ')" "1|fresco "
aiuto SubagentStart s5 nuovo
hook PostToolUse s5; hook Stop s5
uguale "watchface-hook: un aiutante appena avviato sopravvive agli altri eventi" \
  "$(campo s5 4)" "2"
# Elenco del formato vecchio, senza epoca: si butta invece di tenerlo per
# sempre. Il conto si rifa' dagli eventi nuovi.
hook SessionStart s6
printf 'a263612d89aecb2ef\na780b916e6c0751be\n' > "$WF/s6.aiutanti"
hook PostToolUse s6
uguale "watchface-hook: l'elenco senza epoca si scarta" "$(campo s6 4)" "0"
# Lo Stop di un aiutante porta il suo rapporto: se agent_id cade oltre la
# testa letta, non si trova e l'aiutante resta contato per sempre. Riprodotto
# il 2026-10-06 con un payload da 9 KB.
hook SessionStart s7
aiuto SubagentStart s7 lungo
_zeppa=$(head -c 9000 /dev/zero | tr '\0' 'x')
printf '{"session_id":"s7","cwd":"/lavoro/prog","result":"%s","agent_id":"lungo"}' "$_zeppa" \
  | "$WD_ROOT/bin/watchface-hook" SubagentStop
uguale "watchface-hook: uno Stop con un rapporto lungo toglie l'aiutante" "$(campo s7 4)" "0"
# Il campo «riserva» (settimo): lo scrive l'hook una volta sola, all'avvio
# della sessione, leggendo la riga di comando del processo. Serve perche' il
# processo muore mentre la riga resta visibile per ore, e una riserva morta
# ricompariva nel pannello come riga doppia. Qui si prova che, una volta
# scritto, resta: il riconoscimento vero vuole un /proc finto.
hook SessionStart s8
uguale "watchface-hook: una sessione normale non e' una riserva" "$(campo s8 7)" ""
printf 'PreToolUse\t%s\t0\t0\t/lavoro/prog\t0\t1\n' "$(date +%s)" > "$WF/s8"
hook PostToolUse s8
uguale "watchface-hook: il campo riserva sopravvive agli eventi" "$(campo s8 7)" "1"
hook Stop s8; hook PreToolUse s8
uguale "watchface-hook: e non si perde nemmeno dopo uno Stop" "$(campo s8 7)" "1"
# Il riconoscimento vero, con processi veri invece di un /proc finto: la riga
# di comando si fa con `exec -a`, la cartella con un `cd`. Serve perche' la
# riga di comando da sola non distingue una riserva libera da una **ceduta** a
# una sessione di una persona — l'8 ott 2026 il pid 3152601 era ancora
# `claude bg-spare` e ospitava una conversazione vera, e il pannello la
# nascondeva come tubatura.
_spare_dir="$SANDBOX/cc-daemon-1000/41f0c96d/spare"
mkdir -p "$_spare_dir" "$SANDBOX/lavoro-vero"
( cd "$_spare_dir" && exec -a 'claude bg-spare --bg-spare x.claim.sock' sleep 30 ) &
_pid_libera=$!
( cd "$SANDBOX/lavoro-vero" && exec -a 'claude bg-spare --bg-spare x.claim.sock' sleep 30 ) &
_pid_ceduta=$!
# Il processo deve esistere in /proc prima che l'hook lo guardi.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [[ -r /proc/$_pid_libera/cmdline && -r /proc/$_pid_ceduta/cmdline ]] && break
  sleep 0.05
done
CLAUDE_PID=$_pid_libera hook SessionStart s9
uguale "watchface-hook: una riserva nella cartella del demone si dichiara" "$(campo s9 7)" "1"
CLAUDE_PID=$_pid_ceduta hook SessionStart s10
uguale "watchface-hook: una riserva ceduta a una sessione vera non si dichiara" \
  "$(campo s10 7)" ""
# E se il SessionStart arrivasse prima del cambio di cartella, la riga si
# corregge al primo evento che vede la cartella vera.
printf 'PreToolUse\t%s\t0\t0\t/lavoro/prog\t%s\t1\n' "$(date +%s)" "$_pid_ceduta" > "$WF/s11"
CLAUDE_PID=$_pid_ceduta hook PostToolUse s11
uguale "watchface-hook: la dichiarazione si ritira quando la riserva risulta ceduta" \
  "$(campo s11 7)" ""
# Una sessione normale, con un processo che non e' una riserva, non si dichiara
# e non si corregge.
CLAUDE_PID=$$ hook SessionStart s12
uguale "watchface-hook: un processo che non e' una riserva non si dichiara" "$(campo s12 7)" ""
kill "$_pid_libera" "$_pid_ceduta" 2>/dev/null
wait "$_pid_libera" "$_pid_ceduta" 2>/dev/null
# Processo morto: /proc non dice piu' niente e la dichiarazione resta, che e'
# il caso per cui il settimo campo esiste.
printf 'PreToolUse\t%s\t0\t0\t/lavoro/prog\t%s\t1\n' "$(date +%s)" "$_pid_libera" > "$WF/s13"
CLAUDE_PID=$_pid_libera hook PostToolUse s13
uguale "watchface-hook: con il processo morto la dichiarazione resta" "$(campo s13 7)" "1"

hook Stop s1; hook Notification s1
uguale "watchface-hook: Notification dopo Stop non cambia stato" "$(campo s1 1)" "Stop"
hook PermissionRequest s1
uguale "watchface-hook: PermissionRequest si registra" "$(campo s1 1)" "PermissionRequest"
# Un Write da qualche MB: l'hook legge la testa e scarta il resto senza
# bloccare chi scrive.
grosso=$( { printf '{"session_id":"s2","cwd":"/lavoro/grosso","hook_event_name":"PreToolUse","tool_input":{"content":"'
            head -c 3000000 /dev/zero | tr '\0' x; printf '"}}'; } \
          | timeout 10 "$WD_ROOT/bin/watchface-hook" PreToolUse; echo "rc=$?")
uguale "watchface-hook: un payload enorme non blocca" "$grosso" "rc=0"
uguale "watchface-hook: e lo stato si scrive lo stesso" "$(campo s2 5)" "/lavoro/grosso"
# Gli aiutanti partono in parallelo: venti avvii insieme sono venti, non otto.
hook SessionStart s3
for i in $(seq 20); do hook SubagentStart s3 & done; wait
uguale "watchface-hook: venti aiutanti in parallelo sono venti" "$(campo s3 4)" "20"
# A turno chiuso, la fine di un aiutante non riapre il lavoro e la
# Notification di inattivita' non diventa «aspetta te».
hook Stop s3; hook SubagentStop s3; hook Notification s3
uguale "watchface-hook: dopo Stop un aiutante che finisce non riapre il turno" \
  "$(campo s3 1)|$(campo s3 4)" "Stop|19"
hook StopFailure s3; hook Notification s3
uguale "watchface-hook: la Notification non copre un errore" "$(campo s3 1)" "StopFailure"
# Il /compact: PreCompact all'inizio, SessionStart(compact) alla fine, e il
# trigger c'e' solo nel primo (eventi registrati il 2026-10-04).
hookc() { # hookc EVENTO SESSIONE CAMPI-JSON-IN-PIU
  printf '{"session_id":"%s","cwd":"/lavoro/prog","hook_event_name":"%s",%s}' \
    "$2" "$1" "$3" | "$WD_ROOT/bin/watchface-hook" "$1"
}
hook Stop c1; hookc PreCompact c1 '"trigger":"manual"'
hookc PreCompact c2 '"trigger":"auto"'
uguale "watchface-hook: PreCompact ricorda se e' a mano o automatico" \
  "$(campo c1 1)|$(campo c2 1)" "PreCompact|PreCompactAuto"
hookc SessionStart c1 '"source":"compact"'
uguale "watchface-hook: finito il compact a mano tocca a te" "$(campo c1 1)" "Stop"
hookc SessionStart c2 '"source":"compact"'
uguale "watchface-hook: finito il compact automatico Claude riprende il turno" \
  "$(campo c2 1)" "PostToolUse"
hookc SubagentStart c3 '"agent_id":"a1"'; hookc PreCompact c3 '"trigger":"auto"'
hookc SubagentStart c3 '"agent_id":"a2"'
uguale "watchface-hook: un aiutante durante il compact si conta e non lo copre" \
  "$(campo c3 1)|$(campo c3 4)" "PreCompactAuto|2"
hookc SessionStart c3 '"source":"compact"'
uguale "watchface-hook: il compact non azzera gli aiutanti" "$(campo c3 4)" "2"
for i in 1 2 3; do hook PostToolUseFailure c4; done
hookc PreCompact c4 '"trigger":"auto"'; hookc SessionStart c4 '"source":"compact"'
hook PostToolUseFailure c5; hookc PreCompact c5 '"trigger":"manual"'
hookc SessionStart c5 '"source":"compact"'
uguale "watchface-hook: i fallimenti restano dopo un compact automatico, non dopo uno a mano" \
  "$(campo c4 3)|$(campo c5 3)" "3|0"
hook Stop c6; prima=$(cat "$WF/c6"); hookc SessionStart c6 '"source":"compact"'
uguale "watchface-hook: la fine di un compact mai visto iniziare non tocca niente" \
  "$(cat "$WF/c6")" "$prima"
uguale "watchface-hook: nessun temporaneo lasciato in giro" \
  "$(ls "$WF" | grep -c '\.[0-9]')" "0"
hook SessionEnd s1
hook SessionEnd s4
uguale "watchface-hook: SessionEnd toglie il file" \
  "$([[ -e $WF/s1 || -e $WF/s1.lock || -e $WF/s4.aiutanti ]] && echo c-e || echo tolto)" "tolto"
# Il temporaneo del mod: se una rinomina fallisse resterebbe in RAM per sempre,
# perche' il nome ha un punto e il pannello salta tutto quello che ne ha uno.
: > "$WF/s7.aiutanti.mod.tmp"; printf 'Stop\t%s\t0\t0\t/x\t\t\n' "$(date +%s)" > "$WF/s7"
hook SessionEnd s7
uguale "watchface-hook: SessionEnd toglie anche il temporaneo del mod" \
  "$([[ -e $WF/s7.aiutanti.mod.tmp ]] && echo c-e || echo tolto)" "tolto"
unset XDG_RUNTIME_DIR

# ---------------------------------------------------- watchface-hooks.py ---
# Tocca ~/.claude/settings.json, dove stanno anche le impostazioni
# dell'utente: backup prima, scrittura atomica, e un file che non si capisce
# non si riscrive mai.
prepara
S="$HOME/.claude/settings.json"
python3 - "$S" <<'EOF'
import json, sys
ev = ["SessionStart", "Stop", "PreToolUse"]
d = {"theme": "dark", "enabledPlugins": {"x@y": True},
     "hooks": {e: [{"hooks": [{"type": "command", "timeout": 10,
               "command": f"'/opt/coucou/bin/coucou-hook' {e}"}]}] for e in ev}}
json.dump(d, open(sys.argv[1], "w"), indent=2)
EOF
chmod 600 "$S"
WH="$WD_ROOT/bin/watchface-hooks.py"
stato() { "$WH" stato --json 2>/dev/null | python3 -c "import json,sys;d=json.load(sys.stdin);print($1)"; }
"$WH" installa >/dev/null 2>&1
uguale "watchface-hooks: installa i tredici eventi" "$(stato 'len(d["installati"])')" "13"
uguale "watchface-hooks: lascia gli hook degli altri" \
  "$(stato '[(a["programma"], len(a["eventi"])) for a in d["altri"]]')" "[('coucou-hook', 3)]"
uguale "watchface-hooks: lascia le altre impostazioni" \
  "$(python3 -c "import json;d=json.load(open('$S'));print(d['theme'], list(d['enabledPlugins']))")" "dark ['x@y']"
uguale "watchface-hooks: fa un backup prima" "$(stato 'len(d["backup"])')" "1"
uguale "watchface-hooks: conserva i permessi" "$(stat -c %a "$S")" "600"
"$WH" installa >/dev/null 2>&1
uguale "watchface-hooks: installare due volte non duplica" \
  "$(python3 -c "import json;d=json.load(open('$S'));print(sum('watchface-hook' in h['command'] for g in d['hooks']['Stop'] for h in g['hooks']))")" "1"
uguale "watchface-hooks: l'hook non fa fallire Claude se manca il file" \
  "$(python3 -c "import json;d=json.load(open('$S'));print([h['command'] for g in d['hooks']['Stop'] for h in g['hooks'] if 'watchface' in h['command']][0].split('/bin/')[-1])")" \
  "watchface-hook' Stop 2>/dev/null || true"
"$WH" rimuovi >/dev/null 2>&1
uguale "watchface-hooks: rimuovi toglie solo i nostri" \
  "$(stato 'len(d["installati"]), [a["programma"] for a in d["altri"]]')" "0 ['coucou-hook']"
"$WH" rimuovi-altro /opt/coucou/bin/coucou-hook >/dev/null 2>&1
uguale "watchface-hooks: rimuove gli hook di un altro programma" \
  "$(python3 -c "import json;d=json.load(open('$S'));print('hooks' in d, d['theme'])")" "False dark"
primo=$(stato 'd["backup"][-1]')
"$WH" ripristina "$primo" >/dev/null 2>&1
uguale "watchface-hooks: ripristina un backup" "$(cmp -s "$S" "$primo" && echo uguale || echo diverso)" "uguale"
echo '{"theme":"x"}' > "$SANDBOX/estraneo.json"
uguale "watchface-hooks: non ripristina un file fuori dai backup" \
  "$("$WH" ripristina "$SANDBOX/estraneo.json" >/dev/null 2>&1; echo $?)|$(grep -c '"x"' "$S")" "1|0"
echo '{"theme": "dark",' > "$S"
uguale "watchface-hooks: non riscrive un settings.json illeggibile" \
  "$("$WH" installa >/dev/null 2>&1; echo $?)|$(cat "$S")" '1|{"theme": "dark",'

# Revisione del 2026-10-03: un caso per rilievo.
prepara
S="$HOME/.claude/settings.json"
python3 - "$S" <<'PY'
import json, sys
d = {"hooks": {
    "Stop": [{"hooks": [{"type": "command", "command": "python3 /opt/a/hook.py"}]},
             {"hooks": [{"type": "command", "command": "python3 /home/io/guardia.py --forte"}]},
             {"hooks": [{"type": "prompt", "prompt": "controlla"}]}],
    "PreToolUse": {"strano": True},
    "PostToolUse": [{"matcher": "Bash", "senza_hooks": 1}]}}
json.dump(d, open(sys.argv[1], "w"), indent=2)
PY
uguale "watchface-hooks: gli altri si raggruppano per script, non per interprete" \
  "$(stato '[a["percorso"] for a in d["altri"]]')" "['/opt/a/hook.py', '/home/io/guardia.py']"
"$WH" rimuovi-altro /opt/a/hook.py >/dev/null 2>&1
uguale "watchface-hooks: togliere uno script lascia gli altri e i prompt" \
  "$(python3 -c "import json;d=json.load(open('$S'));print([h.get('command', h.get('type')) for g in d['hooks']['Stop'] for h in g['hooks']])")" \
  "['python3 /home/io/guardia.py --forte', 'prompt']"
"$WH" installa >/dev/null 2>&1
uguale "watchface-hooks: le forme che non conosce restano com'erano" \
  "$(python3 -c "import json;d=json.load(open('$S'));print(d['hooks']['PreToolUse'], d['hooks']['PostToolUse'][0])")" \
  "{'strano': True} {'matcher': 'Bash', 'senza_hooks': 1}"
# E non e' un modo di dire «non ho fatto niente»: gli altri undici ci sono.
uguale "watchface-hooks: una forma sconosciuta non blocca gli altri eventi" \
  "$(stato 'len(d["installati"])')" "12"
echo '{"hooks": []}' > "$S"
uguale "watchface-hooks: «hooks» che non e' un oggetto: rifiuta senza toccare" \
  "$("$WH" installa >/dev/null 2>&1; echo $?)|$(cat "$S")" '1|{"hooks": []}'

# Il mod va insieme agli hook: una cartella in env.CLAUDE_CODE_PLUGIN_DIRS.
# Tabella dei casi: env assente, env senza la chiave, chiave con le cartelle
# di altri, la nostra due volte, la rimozione in ognuno di quei casi, e le due
# forme che non si toccano.
prepara
S="$HOME/.claude/settings.json"
echo '{"theme": "dark"}' > "$S"
MODP="$WD_ROOT/mods/watchdog"
"$WH" installa >/dev/null 2>&1
uguale "mod: installa lo attiva, env nasce con la nostra cartella" \
  "$(python3 -c "import json;d=json.load(open('$S'));print(d['env']['CLAUDE_CODE_PLUGIN_DIRS'])")" "$MODP"
uguale "mod: lo stato lo dice" "$(stato 'd["modPresente"], d["modInstallato"], d["modAltri"]')" \
  "True True []"
"$WH" installa >/dev/null 2>&1
uguale "mod: installare due volte non duplica la cartella" \
  "$(python3 -c "import json,os;d=json.load(open('$S'));print(d['env']['CLAUDE_CODE_PLUGIN_DIRS'].count(os.pathsep))")" "0"
"$WH" rimuovi >/dev/null 2>&1
uguale "mod: rimuovi toglie la chiave, e «env» che resta vuoto sparisce" \
  "$(python3 -c "import json;d=json.load(open('$S'));print('env' in d, d['theme'])")" "False dark"

# Con le cartelle di altri dentro: la nostra si aggiunge in coda e si toglie
# da sola, le loro non si toccano mai.
prepara
S="$HOME/.claude/settings.json"
python3 - "$S" <<'PY2'
import json, sys
json.dump({"env": {"ALTRO": "1",
                   "CLAUDE_CODE_PLUGIN_DIRS": "/opt/suo:/opt/altro-suo"}},
          open(sys.argv[1], "w"), indent=2)
PY2
"$WH" installa >/dev/null 2>&1
uguale "mod: si aggiunge in coda alle cartelle di plugin degli altri" \
  "$(python3 -c "import json;d=json.load(open('$S'));print(d['env']['CLAUDE_CODE_PLUGIN_DIRS'])")" \
  "/opt/suo:/opt/altro-suo:$MODP"
uguale "mod: lo stato elenca le cartelle degli altri senza confonderle" \
  "$(stato 'd["modInstallato"], d["modAltri"]')" "True ['/opt/suo', '/opt/altro-suo']"
"$WH" rimuovi >/dev/null 2>&1
uguale "mod: rimuovi lascia le cartelle degli altri e l'altra variabile" \
  "$(python3 -c "import json;d=json.load(open('$S'));print(d['env']['CLAUDE_CODE_PLUGIN_DIRS'], d['env']['ALTRO'])")" \
  "/opt/suo:/opt/altro-suo 1"

# L'interruttore del solo mod: gli hook sono la base e devono restare anche
# quando si spegne il miglioramento.
prepara
S="$HOME/.claude/settings.json"
echo '{}' > "$S"
"$WH" installa >/dev/null 2>&1
"$WH" mod-disattiva >/dev/null 2>&1
uguale "mod: disattivarlo da solo lascia tutti gli hook" \
  "$(stato 'len(d["installati"]), d["modInstallato"]')" "13 False"
"$WH" mod-attiva >/dev/null 2>&1
uguale "mod: riattivarlo da solo non tocca gli hook" \
  "$(stato 'len(d["installati"]), d["modInstallato"]')" "13 True"

# Le due forme che non si capiscono: non si riscrivono, come per «hooks».
prepara
S="$HOME/.claude/settings.json"
# **Si controlla il messaggio, non solo che il file sia intatto.** Un file
# «rimasto com'era» lo lascia anche un programma che muore prima di scrivere:
# togliendo il controllo da leggi() queste due prove passavano su un
# traceback invece che su un rifiuto (mutazione, 2026-10-08).
rifiuto() {
  local err; err=$("$WH" installa 2>&1 >/dev/null)
  if [[ $err == *Traceback* ]]; then echo schianta
  elif [[ $err == *"non lo modifico"* ]]; then echo rifiuta
  else echo muto; fi
}
echo '{"env": []}' > "$S"
uguale "mod: «env» che non e' un oggetto: rifiuta senza toccare" \
  "$("$WH" installa >/dev/null 2>&1; echo $?)|$(rifiuto)|$(cat "$S")" \
  '1|rifiuta|{"env": []}'
echo '{"env": {"CLAUDE_CODE_PLUGIN_DIRS": ["/opt/suo"]}}' > "$S"
uguale "mod: una cartella che non e' una stringa: rifiuta senza toccare" \
  "$("$WH" installa >/dev/null 2>&1; echo $?)|$(rifiuto)|$(grep -c 'opt/suo' "$S")" \
  "1|rifiuta|1"

# Il mod che non c'e' non deve impedire gli hook: meta' e' meglio di niente.
prepara
S="$HOME/.claude/settings.json"
echo '{}' > "$S"
mkdir -p "$SANDBOX/senza-mod"
cp "$WD_ROOT/bin/watchface-hooks.py" "$SANDBOX/senza-mod/"
cp "$WD_ROOT/bin/watchface-hook" "$SANDBOX/senza-mod/"
"$SANDBOX/senza-mod/watchface-hooks.py" installa >/dev/null 2>&1
uguale "mod: se manca, gli hook si installano comunque" \
  "$(python3 -c "import json;d=json.load(open('$S'));print(len(d['hooks']), 'env' in d)")" "13 False"

# Un settings.json che e' un collegamento resta un collegamento.
prepara
mkdir -p "$HOME/dotfiles"
echo '{"theme": "dark"}' > "$HOME/dotfiles/settings.json"
ln -sf "$HOME/dotfiles/settings.json" "$HOME/.claude/settings.json"
"$WD_ROOT/bin/watchface-hooks.py" installa >/dev/null 2>&1
uguale "watchface-hooks: scrive attraverso un collegamento senza sostituirlo" \
  "$([[ -L $HOME/.claude/settings.json ]] && echo link || echo file)|$(grep -c watchface-hook "$HOME/dotfiles/settings.json")" "link|13"

# Ripristinare il backup piu' vecchio quando sono gia' dieci: prima lo si
# cancellava potando, e poi non c'era piu' niente da copiare.
prepara
echo '{"theme": "primo"}' > "$HOME/.claude/settings.json"
for i in $(seq 11); do "$WD_ROOT/bin/watchface-hooks.py" rimuovi >/dev/null 2>&1; done
vecchio=$("$WD_ROOT/bin/watchface-hooks.py" stato --json | python3 -c "import json,sys;print(json.load(sys.stdin)['backup'][0])")
echo '{"theme": "ultimo"}' > "$HOME/.claude/settings.json"
"$WD_ROOT/bin/watchface-hooks.py" ripristina "$vecchio" >/dev/null 2>&1
uguale "watchface-hooks: ripristina anche il backup piu' vecchio" \
  "$(python3 -c "import json;print(json.load(open('$HOME/.claude/settings.json'))['theme'])")" "primo"
uguale "watchface-hooks: i backup restano dieci e in ordine" \
  "$("$WD_ROOT/bin/watchface-hooks.py" stato --json | python3 -c "import json,sys;b=json.load(sys.stdin)['backup'];print(len(b), b==sorted(b))")" "10 True"

# La quota alta colora la sua barra: un avviso testuale in piu' era un doppione.
prepara
mkdir -p "$HOME/.local/share/claude-code-watchdog"
printf '{"letteIl":"%s","limiti":[{"tipo":"session","gruppo":"session","percento":95}],"extra":{}}' \
  "$(date -u +%Y-%m-%dT%H:%M:%S+00:00)" > "$HOME/.local/share/claude-code-watchdog/usage.json"
"$WD_ROOT/bin/collect-metrics.py" --quiet >/dev/null 2>&1
uguale "collect-metrics: la quota alta non genera avvisi" \
  "$(python3 -c "
import json
d=json.load(open('$HOME/.local/share/claude-code-watchdog/metrics.json'))
print(d['quota']['limiti'][0]['percento'], [a for a in d['allarmi'] if 'uota' in a])")" "95 []"

# ----------------------------------------------------------- reclaim.py ---
# E' lo script che viaggia dentro l'estensione: deve fare le stesse cose di
# clean.sh sui target portabili, senza dipendere dal checkout del progetto.
prepara
mkdir -p "$HOME/.claude/jobs"
head -c 100000 /dev/zero > "$HOME/.claude/jobs/vecchio.bin"
touch -d "60 days ago" "$HOME/.claude/jobs/vecchio.bin"
echo recente > "$HOME/.claude/jobs/nuovo.bin"

# La cache di Claude sta in ~/.cache, non in ~/.claude: due cartelle diverse,
# e il target non deve pescare quella del browser che sta li' accanto.
mkdir -p "$HOME/.cache/claude-cli-nodejs/progetto" "$HOME/.cache/google-chrome"
echo log > "$HOME/.cache/claude-cli-nodejs/progetto/mcp.log"
touch -d "30 days ago" "$HOME/.cache/claude-cli-nodejs/progetto/mcp.log"
echo x > "$HOME/.cache/google-chrome/roba"
touch -d "30 days ago" "$HOME/.cache/google-chrome/roba"
"$WD_ROOT/bin/reclaim.py" --apply claude-cache >/dev/null 2>&1
uguale "reclaim: toglie i log di Claude scaduti" \
  "$([[ -f "$HOME/.cache/claude-cli-nodejs/progetto/mcp.log" ]] && echo intatto || echo sparito)" "sparito"
uguale "reclaim: non tocca la cache del browser" \
  "$([[ -f "$HOME/.cache/google-chrome/roba" ]] && echo intatto || echo sparito)" "intatto"

uguale "reclaim: rifiuta un target sconosciuto" \
  "$("$WD_ROOT/bin/reclaim.py" --apply pippo >/dev/null 2>&1; echo $?)" "2"
uguale "reclaim: senza target non fa niente" \
  "$("$WD_ROOT/bin/reclaim.py" --apply >/dev/null 2>&1; echo $?)" "2"
uguale "reclaim: senza --apply non cancella niente" \
  "$("$WD_ROOT/bin/reclaim.py" claude-jobs >/dev/null 2>&1
     [[ -f "$HOME/.claude/jobs/vecchio.bin" ]] && echo intatto || echo sparito)" "intatto"
uguale "reclaim: conta lo spazio anche a vuoto" \
  "$("$WD_ROOT/bin/reclaim.py" --json claude-jobs 2>/dev/null \
     | python3 -c 'import json,sys;print(json.load(sys.stdin)["voci"][0]["file"])')" "1"

"$WD_ROOT/bin/reclaim.py" --apply claude-jobs >/dev/null 2>&1
uguale "reclaim: toglie i file oltre la scadenza" \
  "$([[ -f "$HOME/.claude/jobs/vecchio.bin" ]] && echo intatto || echo sparito)" "sparito"
uguale "reclaim: lascia stare quelli recenti" \
  "$([[ -f "$HOME/.claude/jobs/nuovo.bin" ]] && echo intatto || echo sparito)" "intatto"

# Versioni di Claude Code. Quella in uso non si deduce dal numero piu' alto:
# si risolve il link, perche' `claude install` puo' averlo riportato indietro.
prepara
mkdir -p "$HOME/.local/share/claude/versions" "$HOME/.local/bin"
for v in 2.0.1 2.0.2 2.0.3 2.0.4; do
  head -c 1000 /dev/zero > "$HOME/.local/share/claude/versions/$v"
  chmod +x "$HOME/.local/share/claude/versions/$v"
done
touch -d "4 days ago" "$HOME/.local/share/claude/versions/2.0.1"
touch -d "3 days ago" "$HOME/.local/share/claude/versions/2.0.2"
touch -d "2 days ago" "$HOME/.local/share/claude/versions/2.0.3"
touch -d "1 day ago"  "$HOME/.local/share/claude/versions/2.0.4"

# Senza sapere quale gira, non si tocca niente: e' il caso di chi ha Claude
# installato altrove, o di un PATH che non lo risolve.
uguale "reclaim: senza sapere quale gira non tocca le versioni" \
  "$("$WD_ROOT/bin/reclaim.py" --json claude-versions 2>/dev/null \
     | python3 -c 'import json,sys;print(json.load(sys.stdin)["voci"][0]["file"])')" "0"

ln -sf "$HOME/.local/share/claude/versions/2.0.4" "$HOME/.local/bin/claude"
uguale "reclaim: tiene le due versioni piu' recenti" \
  "$(PATH="$HOME/.local/bin:$PATH" "$WD_ROOT/bin/reclaim.py" --json claude-versions 2>/dev/null \
     | python3 -c 'import json,sys;print(json.load(sys.stdin)["voci"][0]["file"])')" "2"

# Il link punta alla piu' vecchia: quella non deve sparire, e al suo posto
# ne esce di scena un'altra.
ln -sf "$HOME/.local/share/claude/versions/2.0.1" "$HOME/.local/bin/claude"
PATH="$HOME/.local/bin:$PATH" "$WD_ROOT/bin/reclaim.py" --apply claude-versions >/dev/null 2>&1
uguale "reclaim: non tocca la versione a cui punta il link" \
  "$([[ -f "$HOME/.local/share/claude/versions/2.0.1" ]] && echo intatta || echo sparita)" "intatta"

# Segnalazioni: la coda, i rifiuti, e il fatto che il target agisca solo su
# cio' che e' davvero in coda.
prepara
mkdir -p "$HOME/roba-da-buttare"
echo x > "$HOME/roba-da-buttare/file"
uguale "segnala: rifiuta un percorso fuori dalla home" \
  "$("$WD_ROOT/bin/segnala.py" /etc >/dev/null 2>&1; echo $?)" "1"
uguale "segnala: rifiuta quello che sta sotto ~/.claude" \
  "$("$WD_ROOT/bin/segnala.py" "$HOME/.claude" >/dev/null 2>&1; echo $?)" "1"
uguale "segnala: accetta e mette in coda" \
  "$("$WD_ROOT/bin/segnala.py" "$HOME/roba-da-buttare" >/dev/null 2>&1; echo $?)" "0"
uguale "segnala: segnalare non cancella" \
  "$([[ -d "$HOME/roba-da-buttare" ]] && echo intatta || echo sparita)" "intatta"
uguale "reclaim: un id non in coda non tocca niente" \
  "$("$WD_ROOT/bin/reclaim.py" --apply segnalato:000000000000 --json 2>/dev/null \
     | python3 -c 'import json,sys;print(json.load(sys.stdin)["voci"][0]["file"])')" "0"

# Una segnalazione fatta quando il percorso era innocuo, e nel frattempo li'
# dentro e' nato un progetto. Il controllo va rifatto al momento di
# cancellare, non solo al momento di segnalare.
prepara
mkdir -p "$SANDBOX/lavoro/diventa-progetto"
"$WD_ROOT/bin/segnala.py" "$SANDBOX/lavoro/diventa-progetto" >/dev/null 2>&1
d="$HOME/.claude/projects/-diventato"
mkdir -p "$d"
printf '{"type":"user","cwd":"%s","timestamp":"2026-09-01T10:00:00Z","message":{"role":"user","content":"x"}}\n{"type":"assistant","cwd":"%s","timestamp":"2026-09-01T10:00:01Z","message":{"role":"assistant"}}\n' \
  "$SANDBOX/lavoro/diventa-progetto" "$SANDBOX/lavoro/diventa-progetto" \
  > "$d/dddddddd-0000-0000-0000-000000000004.jsonl"
"$WD_ROOT/bin/collect-metrics.py" --quiet >/dev/null 2>&1
sigla=$(python3 -c "
import importlib.util as u
s=u.spec_from_file_location('rc','$WD_ROOT/bin/reclaim.py');m=u.module_from_spec(s);s.loader.exec_module(m)
from pathlib import Path
print(m.ident(Path('$SANDBOX/lavoro/diventa-progetto')))")
"$WD_ROOT/bin/reclaim.py" --apply "segnalato:$sigla" >/dev/null 2>&1
uguale "reclaim: rifiuta una segnalazione diventata cartella di lavoro" \
  "$([[ -d "$SANDBOX/lavoro/diventa-progetto" ]] && echo intatta || echo sparita)" "intatta"

# Un progetto annidato si purga da solo: project-purge abbina per cwd esatto,
# quindi la riga del figlio non deve portarsi via le sessioni del padre.
prepara
d1="$HOME/.claude/projects/-padre"; d2="$HOME/.claude/projects/-figlio"
mkdir -p "$d1" "$d2" "$SANDBOX/lavoro/prog/sub"
printf '{"type":"user","cwd":"%s","timestamp":"2026-09-01T10:00:00Z","message":{"role":"user","content":"x"}}\n{"type":"assistant","cwd":"%s","timestamp":"2026-09-01T10:00:01Z","message":{"role":"assistant"}}\n' \
  "$SANDBOX/lavoro/prog" "$SANDBOX/lavoro/prog" > "$d1/eeeeeeee-0000-0000-0000-000000000005.jsonl"
printf '{"type":"user","cwd":"%s","timestamp":"2026-09-01T10:00:00Z","message":{"role":"user","content":"x"}}\n{"type":"assistant","cwd":"%s","timestamp":"2026-09-01T10:00:01Z","message":{"role":"assistant"}}\n' \
  "$SANDBOX/lavoro/prog/sub" "$SANDBOX/lavoro/prog/sub" > "$d2/ffffffff-0000-0000-0000-000000000006.jsonl"
uguale "project-purge: la riga del figlio non tocca le sessioni del padre" \
  "$("$WD_ROOT/bin/project-purge.py" "$SANDBOX/lavoro/prog/sub" --json 2>/dev/null \
     | python3 -c "import json,sys;v=json.load(sys.stdin)['voci'];print(sum(1 for x in v if 'eeeeeeee' in x['percorso']))")" "0"
uguale "project-purge: la riga del figlio trova la propria sessione" \
  "$("$WD_ROOT/bin/project-purge.py" "$SANDBOX/lavoro/prog/sub" --json 2>/dev/null \
     | python3 -c "import json,sys;print(len(json.load(sys.stdin)['sessioni']))")" "1"

# La rete che impedisce di cancellare lavoro vero. Sbaglia solo in eccesso.
prepara
mkdir -p "$SANDBOX/lavoro/vero/dentro" "$SANDBOX/lavoro/vero-vecchio"
ln -sfn "$SANDBOX/lavoro/vero" "$SANDBOX/lavoro/collegamento"
pp() { python3 -c "
import importlib.util as u
s=u.spec_from_file_location('pp','$WD_ROOT/bin/project-purge.py');m=u.module_from_spec(s);s.loader.exec_module(m)
print(m.dentro_cartella_di_lavoro('$1','$2'))"; }
uguale "rete: la cartella di lavoro stessa non si tocca" \
  "$(pp "$SANDBOX/lavoro/vero" "$SANDBOX/lavoro/vero")" "True"
uguale "rete: quello che ci sta dentro non si tocca" \
  "$(pp "$SANDBOX/lavoro/vero/dentro" "$SANDBOX/lavoro/vero")" "True"
uguale "rete: riconosce il lavoro raggiunto per collegamento" \
  "$(pp "$SANDBOX/lavoro/collegamento/dentro" "$SANDBOX/lavoro/vero")" "True"
uguale "rete: un nome che inizia uguale non è dentro" \
  "$(pp "$SANDBOX/lavoro/vero-vecchio" "$SANDBOX/lavoro/vero")" "False"
uguale "rete: i dati di Claude non sono dentro la cartella di lavoro" \
  "$(pp "$HOME/.claude/projects/-x" "$SANDBOX/lavoro/vero")" "False"

# I file del cruscotto non si possono segnalare. Cestinare metrics.json non
# toglierebbe solo un dato: cartelle_di_lavoro() lo legge, e senza quello la
# protezione sui progetti smette di scattare per tutto il resto del giro.
prepara
"$WD_ROOT/bin/collect-metrics.py" --quiet >/dev/null 2>&1
uguale "segnala: rifiuta i file del cruscotto" \
  "$("$WD_ROOT/bin/segnala.py" "$HOME/.local/share/claude-code-watchdog/metrics.json" >/dev/null 2>&1; echo $?)" "1"
uguale "segnala: rifiuta anche la cartella dati" \
  "$("$WD_ROOT/bin/segnala.py" "$HOME/.local/share/claude-code-watchdog" >/dev/null 2>&1; echo $?)" "1"

# Il temporaneo della scrittura atomica non deve mai essere leggibile a tutti,
# nemmeno per l'istante fra la creazione e il chmod: dentro ci sono i nomi dei
# progetti. Si prova osservando il file mentre viene scritto.
uguale "scrittura atomica: il temporaneo nasce gia' riservato" \
  "$(python3 -c "
import importlib.util as u, os, threading, time
from pathlib import Path
s=u.spec_from_file_location('fc','$WD_ROOT/bin/fix-cwd.py');m=u.module_from_spec(s);s.loader.exec_module(m)
d=Path('$SANDBOX/tmpmode'); d.mkdir(parents=True, exist_ok=True)
f=d/'t.jsonl'; f.write_text('a'); f.chmod(0o600)
visti=[]
def spia():
    for _ in range(4000):
        for x in d.iterdir():
            if x.name.endswith('.tmp'):
                try: visti.append(x.stat().st_mode & 0o777)
                except OSError: pass
th=threading.Thread(target=spia); th.start()
m.scrivi_atomico(f, 'b'*2_000_000)
th.join()
print('tutti-riservati' if all(v == 0o600 for v in visti) else f'esposto: {set(visti)}')")" "tutti-riservati"

# Il caso che il 2026-09-16 stava per far perdere dati: una cartella di
# projects/ con sessioni di cwd diversi. Deve elencare i SINGOLI FILE, mai la
# cartella, se no cancellare il progetto A porta via le conversazioni di B.
prepara
mkdir -p "$SANDBOX/lavoro/alfa" "$SANDBOX/lavoro/beta"
dc="$HOME/.claude/projects/-condivisa"; mkdir -p "$dc"
for par in "alfa:11111111" "beta:22222222"; do
  n=${par%%:*}; i=${par##*:}
  printf '{"type":"user","cwd":"%s","timestamp":"2026-09-01T10:00:00Z","message":{"role":"user","content":"x"}}\n{"type":"assistant","cwd":"%s","timestamp":"2026-09-01T10:00:01Z","message":{"role":"assistant"}}\n' \
    "$SANDBOX/lavoro/$n" "$SANDBOX/lavoro/$n" > "$dc/$i-0000-0000-0000-000000000007.jsonl"
done
uguale "project-purge: in una cartella condivisa elenca i file, non la cartella" \
  "$("$WD_ROOT/bin/project-purge.py" "$SANDBOX/lavoro/alfa" --json 2>/dev/null \
     | python3 -c "
import json,sys
v=json.load(sys.stdin)['voci']
print('cartella' if any(x['tipo']=='cartella' and x['percorso'].endswith('-condivisa') for x in v) else 'file')")" "file"
uguale "project-purge: in una cartella condivisa non tocca le sessioni altrui" \
  "$("$WD_ROOT/bin/project-purge.py" "$SANDBOX/lavoro/alfa" --json 2>/dev/null \
     | python3 -c "
import json,sys
v=json.load(sys.stdin)['voci']
print(sum(1 for x in v if '22222222' in x['percorso']))")" "0"

# Le finestre di scadenza stanno in due file: qui si calcolano i MB mostrati
# nel pannello, li' si cancella. Divergere vorrebbe dire annunciare un numero
# e liberarne un altro.
uguale "reclaim: stesse scadenze di collect-metrics" \
  "$(python3 -c '
import re, sys, pathlib
b = pathlib.Path(sys.argv[1])
cm = (b / "collect-metrics.py").read_text()
rc = (b / "reclaim.py").read_text()
a = {m[0]: int(m[1]) for m in re.findall(r"num\(\"([A-Z_]+)\",\s*(\d+)\)", cm)}
c = {m[0]: int(m[1]) for m in re.findall(r"\(\"([A-Z_]+)\",\s*(\d+)\)", rc)}
comuni = sorted(set(a) & set(c))
diverse = [k for k in comuni if a[k] != c[k]]
print(",".join(diverse) if diverse else "coerenti", len(comuni))
' "$WD_ROOT/bin")" "coerenti 6"

echo
if (( fallite )); then
  printf '\033[31m%d prove fallite\033[0m su %d\n' "$fallite" "$((passate+fallite))"
  exit 1
fi
printf '\033[32mTutte le %d prove passano.\033[0m\n' "$passate"
