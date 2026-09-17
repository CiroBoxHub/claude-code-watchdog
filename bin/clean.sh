#!/usr/bin/env bash
# Pulizia guidata. DRY-RUN PER DEFAULT: senza --apply non cancella niente,
# si limita a dire cosa farebbe e quanto libererebbe.
#
#   ./bin/clean.sh                  # elenca tutto quello che si può liberare
#   ./bin/clean.sh --apply          # esegue i target "sicuri"
#   ./bin/clean.sh dnf journal      # dry-run dei soli target indicati
#   ./bin/clean.sh --apply kernels  # esegue solo quel target
#   ./bin/clean.sh --list           # elenco dei target disponibili
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

APPLY=0
declare -a WANT=()

# Target inclusi nel giro "tutto". Quelli delicati stanno fuori e vanno
# chiesti per nome: cancellano roba che potrebbe essere un backup voluto.
SAFE_TARGETS=(dnf journal coredump logs trash usercache flatpak
              claude-stubs claude-jobs claude-snapshots claude-paste
              claude-filehistory)
RISKY_TARGETS=(kernels orphans claude-dups claude-projects)

usage() { sed -n '2,12p' "$0" | sed 's/^# \?//'; }

for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;;
    --list)
      echo "Target sicuri (inclusi nel giro completo):"
      printf '  %s\n' "${SAFE_TARGETS[@]}"
      echo "Target delicati (solo se li chiedi per nome):"
      printf '  %s\n' "${RISKY_TARGETS[@]}"
      exit 0 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "Opzione sconosciuta: $a" >&2; exit 2 ;;
    *) WANT+=("$a") ;;
  esac
done

(( ${#WANT[@]} == 0 )) && WANT=("${SAFE_TARGETS[@]}")

# Un target scritto male non deve passare in silenzio: senza questo controllo
# il giro finirebbe con "0 MB recuperabili" e sembrerebbe che non c'è niente.
for t in "${WANT[@]}"; do
  known=0
  for k in "${SAFE_TARGETS[@]}" "${RISKY_TARGETS[@]}"; do
    [[ "$t" == "$k" ]] && { known=1; break; }
  done
  (( known )) || { echo "Target sconosciuto: '$t' — \`--list\` per i nomi validi" >&2; exit 2; }
done

wants() { local t; for t in "${WANT[@]}"; do [[ "$t" == "$1" ]] && return 0; done; return 1; }

FREED_MB=0
note() { printf -- '  %s\n' "$*"; }
LAST_PLAN=0
plan() { # plan MB "descrizione"
  FREED_MB=$(( FREED_MB + $1 ))
  LAST_PLAN=$1
  local shown="$1"
  (( $1 == 0 )) && shown="<1"   # sotto il MB, "0 MB" sembrerebbe un errore
  printf -- '  → libera **%s MB**: %s\n' "$shown" "$2"
}
# Esegue il comando solo in modalità --apply; altrimenti lo mostra soltanto.
run() {
  if (( APPLY )); then
    if "$@"; then note "fatto: $*"; else note "⚠️ fallito: $*"; unplan; fi
  else
    note "comando: $*"
  fi
}
# Annulla l'ultima previsione: un comando fallito non ha liberato niente e
# lasciarlo nel totale darebbe un numero inventato.
unplan() {
  FREED_MB=$(( FREED_MB - LAST_PLAN ))
  (( LAST_PLAN > 0 )) && note "(i ${LAST_PLAN} MB previsti non sono stati liberati)"
  LAST_PLAN=0
}
# Come run(), ma il comando ha bisogno di sudo.
runroot() {
  if (( ! APPLY )); then
    note "comando: sudo $*"
    return
  fi
  # sudo senza password: la via più diretta.
  if sudo -n true 2>/dev/null; then
    if sudo "$@"; then note "fatto: sudo $*"; else note "⚠️ fallito: sudo $*"; unplan; fi
    return
  fi
  # Dentro Claude Code non c'è un terminale, quindi sudo non può chiedere la
  # password — nemmeno col prefisso `!`. Su una sessione grafica ci pensa
  # polkit, che mostra il dialogo di autenticazione di GNOME.
  if command -v pkexec >/dev/null && [[ -n "${WAYLAND_DISPLAY:-}${DISPLAY:-}" ]]; then
    note "serve l'autenticazione: compare una finestra sul desktop"
    if pkexec "$@"; then note "fatto: pkexec $*"; else note "⚠️ annullato o fallito: pkexec $*"; unplan; fi
    return
  fi
  note "⚠️ serve sudo con password — eseguilo tu in un terminale vero:"
  note "    sudo $*"
  unplan
}

if (( APPLY )); then
  echo "# Pulizia — ESECUZIONE REALE — $(date '+%Y-%m-%d %H:%M')"
else
  echo "# Pulizia — anteprima (dry-run) — $(date '+%Y-%m-%d %H:%M')"
  echo
  echo "_Niente viene toccato. Per eseguire davvero: \`./bin/clean.sh --apply\`_"
fi

# ---------------------------------------------------------------- sistema ---

if wants dnf; then
  h2 "Cache pacchetti"
  _mb=$(( $(size_mb /var/cache/libdnf5) + $(size_mb /var/cache/dnf) ))
  if (( _mb > 0 )); then
    plan "$_mb" "cache dnf (si riscarica da sola al prossimo aggiornamento)"
    runroot dnf5 clean all
  else
    note "già pulita"
  fi
fi

if wants journal; then
  h2 "Journal systemd"
  _cur_h=$(journalctl --disk-usage 2>/dev/null | grep -oP '[\d,.]+[KMG]' | tail -1)
  _cur=$(size_mb /var/log/journal)
  _cap=${JOURNAL_MAX_SIZE%[MG]}
  [[ "$JOURNAL_MAX_SIZE" == *G ]] && _cap=$(( _cap * 1024 ))
  note "ora: ${_cur_h:-?} · tetto configurato: $JOURNAL_MAX_SIZE"
  if (( _cur > _cap )); then
    plan "$(( _cur - _cap ))" "log di sistema oltre il tetto (i più vecchi)"
    runroot journalctl --vacuum-size="$JOURNAL_MAX_SIZE"
  else
    # Il vacuum sotto il tetto non è un errore: semplicemente non fa niente.
    note "sotto il tetto: il vacuum non libererebbe niente"
    note "per scendere davvero, abbassa JOURNAL_MAX_SIZE in config/watchdog.conf"
  fi
fi

if wants coredump; then
  h2 "Coredump"
  _tot=$(size_mb /var/lib/systemd/coredump)
  if (( _tot == 0 )); then
    note "nessun coredump"
  else
    # Attenzione: qui si cancella per ETÀ, non tutto. Riportare la dimensione
    # totale della cartella come "spazio liberato" sarebbe una promessa falsa.
    _mb=$(stale_mb /var/lib/systemd/coredump "$COREDUMP_RETENTION_DAYS")
    _n=$(stale_count /var/lib/systemd/coredump "$COREDUMP_RETENTION_DAYS")
    note "in archivio: ${_tot} MB · scaduti (>${COREDUMP_RETENTION_DAYS} gg): ${_n} file, ${_mb} MB"
    note "cosa è crashato:"
    coredumpctl list --no-pager --no-legend 2>/dev/null | tail -8 \
      | awk '{printf "      %s %s  %-34s %s\n", $1" "$2" "$3, $4, $(NF-1), $NF}'
    if (( _n > 0 )); then
      plan "$_mb" "$_n dump più vecchi di $COREDUMP_RETENTION_DAYS giorni"
      if (( APPLY )); then
        sudo find /var/lib/systemd/coredump -type f -mtime "+$COREDUMP_RETENTION_DAYS" -delete 2>/dev/null \
          && note "fatto"
      else
        note "comando: sudo find /var/lib/systemd/coredump -type f -mtime +$COREDUMP_RETENTION_DAYS -delete"
      fi
    else
      note "niente oltre i $COREDUMP_RETENTION_DAYS giorni: non si libera niente"
      note "per svuotare comunque tutto: sudo coredumpctl --vacuum-size=1K"
    fi
  fi
fi

if wants logs; then
  h2 "Log ruotati in /var/log"
  _mb=$(find /var/log -type f \( -name '*.gz' -o -name '*.old' -o -name '*.[0-9]' \) \
        -mtime +30 -printf '%s\n' 2>/dev/null | awk '{t+=$1} END {printf "%d", t/1048576}')
  if (( ${_mb:-0} > 0 )); then
    plan "$_mb" "log ruotati più vecchi di 30 giorni"
    if (( APPLY )); then
      sudo find /var/log -type f \( -name '*.gz' -o -name '*.old' -o -name '*.[0-9]' \) \
        -mtime +30 -delete 2>/dev/null && note "fatto"
    else
      note "comando: sudo find /var/log -type f \\( -name '*.gz' -o -name '*.old' -o -name '*.[0-9]' \\) -mtime +30 -delete"
    fi
  else
    note "niente da togliere"
  fi
fi

if wants trash; then
  h2 "Cestino"
  _t="$HOME/.local/share/Trash"
  # Si legge DeletionDate dai .trashinfo, NON l'mtime del file: un documento
  # modificato due anni fa e buttato ieri ha l'mtime vecchio, e potarlo per
  # quello lo distruggerebbe il giorno dopo averlo cestinato — l'opposto della
  # regola. Payload e .trashinfo vanno tolti insieme, o restano voci spaiate.
  mapfile -t _vecchi < <("$WD_ROOT/bin/trash-scaduti.py" "$TRASH_RETENTION_DAYS")
  if (( ${#_vecchi[@]} > 0 )); then
    _mb=0
    for f in "${_vecchi[@]}"; do
      [[ -e "$f" ]] && _mb=$(( _mb + $(du -sm "$f" 2>/dev/null | cut -f1) ))
    done
    plan "$_mb" "${#_vecchi[@]} elementi cestinati da più di $TRASH_RETENTION_DAYS giorni"
    note "(qui si cancella davvero: sono già nel cestino, non ce n'è un secondo)"
    if (( APPLY )); then
      for f in "${_vecchi[@]}"; do
        rm -rf -- "$f"
        rm -f -- "$_t/info/$(basename "$f").trashinfo"
      done
      note "fatto"
    else
      note "comando: rimozione di payload e .trashinfo appaiati"
    fi
  else
    note "niente cestinato da più di $TRASH_RETENTION_DAYS giorni"
  fi
fi

if wants usercache; then
  h2 "~/.cache"
  note "totale: $(size_h "$HOME/.cache")"
  _mb=$(stale_mb "$HOME/.cache" "$USER_CACHE_RETENTION_DAYS")
  _n=$(stale_count "$HOME/.cache" "$USER_CACHE_RETENTION_DAYS")
  if (( _n > 0 )); then
    plan "$_mb" "$_n file non toccati da più di $USER_CACHE_RETENTION_DAYS giorni"
    note "(le app se li rigenerano; al più il primo avvio è più lento)"
    if (( APPLY )); then
      find "$HOME/.cache" -type f -mtime "+$USER_CACHE_RETENTION_DAYS" -delete 2>/dev/null
      find "$HOME/.cache" -type d -empty -delete 2>/dev/null
      note "fatto"
    else
      note "comando: find ~/.cache -type f -mtime +$USER_CACHE_RETENTION_DAYS -delete"
    fi
  else
    note "niente di stantio"
  fi
  echo
  note "i 5 divoratori:"
  du -sh "$HOME/.cache"/* 2>/dev/null | sort -rh | head -5 | sed 's/^/    /'
fi

if wants flatpak; then
  h2 "Flatpak"
  if command -v flatpak >/dev/null; then
    note "totale su disco: $(size_h /var/lib/flatpak)"
    if (( APPLY )); then
      flatpak uninstall --unused -y 2>&1 | tail -5 | sed 's/^/    /'
      note "fatto"
    else
      note "comando: flatpak uninstall --unused -y"
      note "(elenca e rimuove i runtime che nessuna app usa più)"
    fi
  else
    note "flatpak non installato"
  fi
fi

# ------------------------------------------------------------------ Claude ---

if wants claude-stubs; then
  h2 "Sessioni-fantasma di Claude"
  mapfile -t _stub < <("$WD_ROOT/bin/claude-sessions.py" --stubs 2>/dev/null)
  if (( ${#_stub[@]} > 0 )); then
    _b=0
    for f in "${_stub[@]}"; do _b=$(( _b + $(stat -c%s "$f" 2>/dev/null || echo 0) )); done
    plan "$(( _b / 1048576 ))" "${#_stub[@]} trascrizioni senza nessuna risposta dell'assistente"
    note "(scarti di invocazioni non interattive: statusline, hook, script SDK)"
    note "(vanno nel cestino: il criterio «nessuna risposta» può pescare anche"
    note " una conversazione vera interrotta prima della prima risposta)"
    if (( APPLY )); then
      # -0 con separatore nullo: un percorso con uno spazio o un apice
      # verrebbe spezzato da xargs nella forma normale.
      printf '%s\0' "${_stub[@]}" | xargs -r -0 gio trash -- && note "fatto"
    else
      note "comando: bin/claude-sessions.py --stubs | xargs -r -0 gio trash --"
    fi
  else
    note "nessuna"
  fi
fi

_claude_retention() { # _claude_retention nome sottocartella giorni
  local label="$1" sub="$2" days="$3" dir="$CLAUDE_DIR/$2"
  h2 "$label"
  local n b
  n=$(stale_count "$dir" "$days"); b=$(stale_mb "$dir" "$days")
  if (( n > 0 )); then
    plan "$b" "$n file più vecchi di $days giorni in \`~/.claude/$sub/\`"
    # Qui dentro può finirci roba pesante e non ovvia (dump di database,
    # export): meglio vederla prima che dopo.
    local big
    big=$(find "$dir" -type f -mtime "+$days" -size +10M \
          -printf '%s\t%p\n' 2>/dev/null | sort -rn | head -5)
    if [[ -n "$big" ]]; then
      note "file sopra i 10 MB che verrebbero tolti:"
      echo "$big" | awk -F'\t' '{printf "      %6.1f MB  %s\n", $1/1048576, $2}'
    fi
    if (( APPLY )); then
      find "$dir" -type f -mtime "+$days" -delete 2>/dev/null
      find "$dir" -mindepth 1 -type d -empty -delete 2>/dev/null
      note "fatto"
    else
      note "comando: find ~/.claude/$sub -type f -mtime +$days -delete"
    fi
  else
    note "niente oltre i $days giorni"
  fi
}

wants claude-jobs        && _claude_retention "Job Claude" jobs "$CLAUDE_JOBS_RETENTION_DAYS"
wants claude-snapshots   && _claude_retention "Shell snapshot" shell-snapshots "$CLAUDE_SHELL_SNAPSHOT_RETENTION_DAYS"
wants claude-paste       && _claude_retention "Paste cache" paste-cache "$CLAUDE_PASTE_CACHE_RETENTION_DAYS"
wants claude-filehistory && _claude_retention "File history" file-history "$CLAUDE_FILE_HISTORY_RETENTION_DAYS"

# --------------------------------------------------------------- delicati ---

if wants kernels; then
  h2 "Kernel vecchi  ⚠️ delicato"
  _n=$(rpm -q kernel 2>/dev/null | wc -l)
  note "installati: $_n · in uso: $(uname -r) · da tenere: $KEEP_KERNELS"
  if (( _n > KEEP_KERNELS )); then
    note "⚠️ tieni sempre almeno un kernel che sai avviarsi, oltre a quello in uso"
    runroot dnf5 remove --oldinstallonly -y
  else
    note "niente da rimuovere"
  fi
fi

if wants orphans; then
  h2 "Pacchetti orfani  ⚠️ delicato"
  note "dnf considera 'non necessario' anche roba che usi a mano (7zip, arj…)"
  note "elenco:"
  dnf5 repoquery --unneeded --quiet 2>/dev/null | head -30 | sed 's/^/    /'
  note "comando (dopo aver letto l'elenco): sudo dnf5 autoremove"
  (( APPLY )) && note "⚠️ NON eseguito in automatico: lancialo a mano se l'elenco ti convince"
fi

if wants claude-dups; then
  h2 "Trascrizioni duplicate  ⚠️ delicato"
  note "il README di ~/Documenti/Claude dice che le copie in projects/-tmp/"
  note "sono backup VOLUTI dei progetti spostati da /tmp. Guarda prima:"
  note "  bin/claude-sessions.py   (sezione «Trascrizioni duplicate»)"
  (( APPLY )) && note "⚠️ NON eseguito in automatico: richiede una scelta tua"
fi

if wants claude-projects; then
  h2 "Voci progetto orfane in ~/.claude.json  ⚠️ delicato"
  python3 - "$HOME/.claude.json" <<'PY'
import json, sys
from pathlib import Path
d = json.loads(Path(sys.argv[1]).read_text())
missing = [p for p in (d.get("projects") or {}) if not Path(p).is_dir()]
for p in missing:
    print(f"    {p}")
print(f"    ({len(missing)} voci)" if missing else "    nessuna")
PY
  note "⚠️ ~/.claude.json tiene anche i permessi accordati e la cronologia:"
  note "  non va editato mentre Claude Code gira. Chiudi tutte le sessioni prima."
  (( APPLY )) && note "⚠️ NON eseguito in automatico: chiedimelo e lo faccio con backup"
fi

# ----------------------------------------------------------------- totale ---

h1 "Totale"
if (( APPLY )); then
  echo "Spazio liberato (stima): **${FREED_MB} MB**"
  echo
  echo "Disco ora:"
  df -h / | tail -1 | sed 's/^/    /'
else
  echo "Recuperabili: **${FREED_MB} MB** sui target esaminati."
  echo
  echo "Per eseguire: \`./bin/clean.sh --apply\`"
  echo "Per un solo target: \`./bin/clean.sh --apply <nome>\` (\`--list\` per i nomi)"
fi

exit 0
