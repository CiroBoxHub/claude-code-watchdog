#!/usr/bin/env bash
# Fotografia del sistema. SOLA LETTURA: non modifica e non cancella nulla.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

echo "# Scan sistema — $(date '+%Y-%m-%d %H:%M')"
echo
echo "$(cat /etc/fedora-release 2>/dev/null) · kernel in uso $(uname -r) · uptime$(uptime -p | sed 's/^up//')"

h1 "Disco"
df -hT -x tmpfs -x devtmpfs -x efivarfs 2>/dev/null | sed 's/^/    /'

h1 "Memoria e carico"
free -h | sed 's/^/    /'
echo
echo "    load average:$(cut -d' ' -f1-3 /proc/loadavg | sed 's/^/ /')"

h1 "Spazio recuperabile"
table_head "Voce" "Occupato"
row "cache pacchetti (libdnf5/dnf)" "$(( $(size_mb /var/cache/libdnf5) + $(size_mb /var/cache/dnf) )) MB"
row "journal systemd" "$(journalctl --disk-usage 2>/dev/null | grep -oP '[\d,.]+[KMG]' | tail -1)"
row "cestino utente" "$(size_h "$HOME/.local/share/Trash")"
row "~/.cache" "$(size_h "$HOME/.cache")"
row "~/.cache non toccata da >${USER_CACHE_RETENTION_DAYS}gg" "$(stale_mb "$HOME/.cache" "$USER_CACHE_RETENTION_DAYS") MB"
row "coredump" "$(size_h /var/lib/systemd/coredump)"
row "vecchi log ruotati /var/log" "$(find /var/log -type f \( -name '*.gz' -o -name '*.old' -o -name '*.[0-9]' \) -printf '%s\n' 2>/dev/null | awk '{t+=$1} END {printf "%d MB", t/1048576}')"

h2 "Kernel installati"
rpm -q kernel 2>/dev/null | sed 's/^/    /'
echo
echo "    In uso: $(uname -r) · policy: tenerne $KEEP_KERNELS"

h2 "Pacchetti orfani (non richiesti da nessuno)"
_orph=$(dnf5 repoquery --unneeded --quiet 2>/dev/null | head -25)
if [[ -n "$_orph" ]]; then echo "$_orph" | sed 's/^/    /'; else echo "    nessuno"; fi

h2 "Flatpak"
if command -v flatpak >/dev/null; then
  echo "    app installate: $(flatpak list --app 2>/dev/null | wc -l) · runtime: $(flatpak list --runtime 2>/dev/null | wc -l) · totale su disco: $(size_h /var/lib/flatpak)"
  echo "    (i runtime inutilizzabili li calcola /watchdog-clean in dry-run)"
  flatpak list --columns=application,size 2>/dev/null | sort -k2 -hr | head -5 | sed 's/^/    /'
else
  echo "    non installato"
fi

h1 "Salute servizi"
_failed=$(systemctl --failed --no-legend --plain 2>/dev/null)
if [[ -n "$_failed" ]]; then
  echo "**Unità di sistema in errore:**"; echo '```'; echo "$_failed"; echo '```'
else
  echo "- Nessuna unità di sistema in errore"
fi
_ufailed=$(systemctl --user --failed --no-legend --plain 2>/dev/null)
if [[ -n "$_ufailed" ]]; then
  echo; echo "**Unità utente in errore:**"; echo '```'; echo "$_ufailed"; echo '```'
else
  echo "- Nessuna unità utente in errore"
fi

h2 "Errori nel journal (ultime 24h)"
# I coredump riversano decine di righe di stack trace nel journal: le filtro via
# e le riassumo a parte, altrimenti coprono ogni altro errore.
_errs=$(journalctl -p err --since '24 hours ago' --no-pager -q -o cat 2>/dev/null \
  | grep -vE '^\s*$|^\s*#[0-9]+ |^Stack trace of|^Found module|^Module .* from|^ELF object|^Metadata:|^\s+[A-Za-z]+: ' \
  | sed -E 's/[0-9a-f]{8}-[0-9a-f-]{27}/<uuid>/g; s/\b[0-9]{5,}\b/<n>/g' \
  | cut -c1-110 | sort | uniq -c | sort -rn | head -10)
if [[ -n "$_errs" ]]; then echo "$_errs" | sed 's/^/    /'; else echo "    nessun errore (o journal non leggibile senza privilegi)"; fi

h2 "Crash recenti (coredump)"
if command -v coredumpctl >/dev/null; then
  _cd=$(coredumpctl list --since '7 days ago' --no-pager --no-legend 2>/dev/null | awk '{print $NF, $10}' | sort | uniq -c | sort -rn | head -8)
  if [[ -n "$_cd" ]]; then echo "$_cd" | sed 's/^/    /'; else echo "    nessun crash negli ultimi 7 giorni"; fi
else
  echo "    coredumpctl non disponibile"
fi

h1 "Aggiornamenti"
_upd=$(dnf5 check-update --quiet 2>/dev/null | grep -c '^[a-zA-Z0-9]' )
echo "- Pacchetti aggiornabili: **${_upd:-?}**"
echo "- Ultimo aggiornamento sistema: $(rpm -qa --last 2>/dev/null | head -1 | sed 's/.* \([a-z].*\)/\1/')"

h1 "Allarmi"
_any=0
_pct=$(df --output=pcent / | tail -1 | tr -dc '0-9')
alert "Uso disco /" "$_pct" "$ALERT_WARN_PCT" "%" && _any=1
alert "~/.cache" "$(size_mb "$HOME/.cache")" "$ALERT_HOME_CACHE_MB" " MB" && _any=1
_nk=$(rpm -q kernel 2>/dev/null | wc -l)
alert "Kernel installati" "$_nk" "$KEEP_KERNELS" "" && _any=1
[[ -n "$_failed$_ufailed" ]] && { echo "- ⚠️  **Unità systemd in errore** (vedi sopra)"; _any=1; }
(( _any == 0 )) && echo "- ✅ Nessuna soglia superata"

# Uno scan che non trova nulla non è un errore: senza questo,
# l'ultima espressione aritmetica deciderebbe il codice di uscita.
exit 0
