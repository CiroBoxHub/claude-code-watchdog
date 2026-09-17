#!/usr/bin/env bash
# Funzioni condivise dagli script del watchdog. Nessun effetto collaterale:
# questo file si limita a definire variabili e funzioni.

WD_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WD_CONF="$WD_ROOT/config/watchdog.conf"
[[ -f "$WD_CONF" ]] && source "$WD_CONF"

CLAUDE_DIR="$HOME/.claude"

# Espande le tilde/variabili rimaste nei valori di config
CLAUDE_ARCHIVE_DIR="${CLAUDE_ARCHIVE_DIR:-$HOME/Documenti/Claude/_archivio-trascrizioni}"

h1() { printf '\n## %s\n\n' "$*"; }
h2() { printf '\n### %s\n\n' "$*"; }
row() { printf '| %s | %s |\n' "$1" "$2"; }
table_head() { printf '| %s | %s |\n|---|---|\n' "$1" "$2"; }

# Dimensione di un percorso in MB (0 se non esiste)
size_mb() {
  [[ -e "$1" ]] || { echo 0; return; }
  du -sm --one-file-system "$1" 2>/dev/null | cut -f1
}

# Dimensione leggibile (— se non esiste)
size_h() {
  [[ -e "$1" ]] || { echo "—"; return; }
  du -sh --one-file-system "$1" 2>/dev/null | cut -f1
}

# Somma in MB dei file sotto $1 più vecchi di $2 giorni
stale_mb() {
  local path="$1" days="$2"
  [[ -d "$path" ]] || { echo 0; return; }
  find "$path" -type f -mtime "+$days" -printf '%s\n' 2>/dev/null \
    | awk '{t+=$1} END {printf "%d", t/1048576}'
}

# Conta i file sotto $1 più vecchi di $2 giorni
stale_count() {
  local path="$1" days="$2"
  [[ -d "$path" ]] || { echo 0; return; }
  find "$path" -type f -mtime "+$days" 2>/dev/null | wc -l
}

# Segnala una soglia superata: alert "etichetta" valore soglia "unità"
alert() {
  local label="$1" val="$2" thr="$3" unit="${4:-}"
  if (( val > thr )); then
    printf -- '- ⚠️  **%s**: %s%s (soglia %s%s)\n' "$label" "$val" "$unit" "$thr" "$unit"
    return 0
  fi
  return 1
}
