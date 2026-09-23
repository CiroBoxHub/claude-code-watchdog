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
