#!/usr/bin/env bash
# Carica l'estensione in una GNOME Shell vera e guarda se esplode.
#
# È l'unico collaudo che esegue extension.js per intero. `prova-js.sh` prende
# le funzioni pure; qui parte tutto: enable(), la costruzione del pannello, il
# timer, il sottoprocesso del raccoglitore.
#
# Serve perché su Wayland la shell tiene in cache il modulo ES già importato:
# un difetto introdotto adesso si vedrebbe solo dopo logout e login, cioè ore
# dopo, e nel frattempo si continua a lavorarci sopra. Una shell annidata
# headless, su un monitor virtuale, non tocca la sessione in corso.
#
# NON cambia impostazioni: dconf è condiviso con la sessione vera, e una prova
# che modifica le preferenze dell'utente è una prova che fa danni.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

UUID="claude-code-watchdog@cirobox.local"
ATTESA="${1:-45}"          # secondi di esecuzione dopo l'attivazione

for c in gnome-shell dbus-run-session; do
  command -v "$c" >/dev/null || { echo "$c non disponibile: prova saltata"; exit 0; }
done
[[ -d "$HOME/.local/share/gnome-shell/extensions/$UUID" ]] \
  || { echo "estensione non installata: lancia prima install-extension.sh"; exit 2; }

LOG=$(mktemp -t watchdog-shell-XXXXXX.log)
# File separato per lo stato: gnome-shell tiene il suo log aperto in scrittura
# non-append, quindi continua a scrivere al PROPRIO offset e si mangia quello
# che gli aggiungeremmo in coda. Costato una prova che diceva «non attiva»
# mentre l'estensione lo era.
STATO=$(mktemp -t watchdog-stato-XXXXXX.txt)
trap 'rm -f "$LOG" "$STATO"' EXIT

echo "Carico l'estensione in una shell annidata headless (${ATTESA}s)"
echo

# La data del file dati prima: se il timer parte davvero, dopo sarà più recente.
PRIMA=$(stat -c %Y "$HOME/.local/share/claude-code-watchdog/metrics.json" 2>/dev/null || echo 0)

timeout $((ATTESA + 45)) dbus-run-session -- bash -c "
  gnome-shell --headless --virtual-monitor 1280x720 >'$LOG' 2>&1 &
  SH=\$!
  sleep 12
  gnome-extensions enable '$UUID' 2>>'$LOG'
  # Otto secondi e non quattro: enable() ritorna prima che la shell abbia
  # finito di attivare, e interrogare troppo presto legge lo stato vecchio.
  sleep 8
  gnome-extensions info '$UUID' 2>&1 | grep -iE '^ *(stato|state) *:' >'$STATO'
  sleep $ATTESA
  kill \$SH 2>/dev/null
  wait \$SH 2>/dev/null
" >/dev/null 2>&1

ko=0
printf '  %-38s ' "l'estensione si attiva"
_stato=$(tr -d '\n' < "$STATO")
if [[ "$_stato" == *ACTIVE* || "$_stato" == *ATTIV* ]]; then
  echo "ok"
else
  echo "✗ letto: ${_stato:-niente}"; ko=1
fi

printf '  %-38s ' "nessun errore JavaScript"
# Non solo «JS ERROR»: un'eccezione dentro enable() arriva come stack nudo,
# e la mutazione di prova la lasciava passare per «ok».
_err=$(grep -cE "JS ERROR|TypeError|ReferenceError|is not a function|is null" "$LOG" || true)
if [[ "$_err" == "0" ]]; then
  echo "ok"
else
  echo "✗ $_err"; grep -E "JS ERROR" "$LOG" | head -5 | sed 's/^/      /'; ko=1
fi

printf '  %-38s ' "niente stack che nomini il nostro codice"
_nostri=$(grep -cE "$UUID/(extension|prefs)\.js" "$LOG" || true)
if [[ "$_nostri" == "0" ]]; then
  echo "ok"
else
  echo "✗ $_nostri"; grep -E "$UUID/(extension|prefs)\.js" "$LOG" | head -5 | sed 's/^/      /'; ko=1
fi

printf '  %-38s ' "dati riscritti durante la prova (indizio)"
DOPO=$(stat -c %Y "$HOME/.local/share/claude-code-watchdog/metrics.json" 2>/dev/null || echo 0)
# NON è una prova: l'estensione della sessione vera gira in parallelo e
# riscrive lo stesso file, quindi il dato nuovo può essere suo. Si mostra come
# indizio e non concorre all'esito — dichiarare verificato ciò che non lo è
# vale meno di non verificarlo.
if (( DOPO > PRIMA )); then
  echo "sì (può essere la sessione vera)"
else
  echo "no entro ${ATTESA}s"
fi

echo
if (( ko )); then echo "NON installare finché non è tutto a posto."; else echo "Tutto a posto."; fi
exit $ko
