#!/usr/bin/env bash
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

# ------------------------------------------------- collect-metrics.py ---
prepara
"$WD_ROOT/bin/collect-metrics.py" --quiet >/dev/null 2>&1
M="$HOME/.local/share/claude-code-watchdog/metrics.json"
[[ -f "$M" ]] && ok "collect-metrics: scrive metrics.json" || ko "collect-metrics: scrive metrics.json"
uguale "collect-metrics: conta le conversazioni" \
  "$(python3 -c "import json;print(json.load(open('$M'))['claude']['conversazioni'])")" "1"
uguale "collect-metrics: scompone lo spazio" \
  "$(python3 -c "import json;print('scomposizione' in json.load(open('$M'))['claude'])")" "True"
uguale "collect-metrics: pubblica le soglie" \
  "$(python3 -c "import json;print(json.load(open('$M'))['soglie']['attenzione'])")" "75"

# La copia dentro l'estensione deve funzionare come quella nel progetto:
# è il difetto che faceva riportare una macchina vuota.
COPIA="$SANDBOX/finta-estensione"; mkdir -p "$COPIA"
cp "$WD_ROOT/bin/collect-metrics.py" "$WD_ROOT/bin/claude-sessions.py" "$COPIA/"
rm -f "$M"; (cd "$COPIA" && ./collect-metrics.py --quiet >/dev/null 2>&1)
uguale "collect-metrics: funziona anche copiato fuori da bin/" \
  "$(python3 -c "import json;print(json.load(open('$M'))['claude']['conversazioni'])" 2>/dev/null)" "1"
uguale "collect-metrics: senza progetto non inventa una radice" \
  "$(python3 -c "import json;print(json.load(open('$M'))['progetto'])" 2>/dev/null)" "None"

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

# ----------------------------------------------------------- reclaim.py ---
# E' lo script che viaggia dentro l'estensione: deve fare le stesse cose di
# clean.sh sui target portabili, senza dipendere dal checkout del progetto.
prepara
mkdir -p "$HOME/.claude/jobs"
head -c 100000 /dev/zero > "$HOME/.claude/jobs/vecchio.bin"
touch -d "60 days ago" "$HOME/.claude/jobs/vecchio.bin"
echo recente > "$HOME/.claude/jobs/nuovo.bin"

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
