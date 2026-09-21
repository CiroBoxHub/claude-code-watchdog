#!/usr/bin/env bash
# Installa (o reinstalla) l'estensione GNOME nella home dell'utente.
#
# Si usa una copia e non un symlink: GNOME Shell non segue i link simbolici
# quando enumera le estensioni. Va rilanciato dopo ogni modifica al sorgente.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

UUID="claude-code-watchdog@cirobox.local"
SRC="$WD_ROOT/gnome-extension/$UUID"
DST="$HOME/.local/share/gnome-shell/extensions/$UUID"

[[ -d "$SRC" ]] || { echo "sorgente mancante: $SRC" >&2; exit 1; }

# Non si installa qualcosa che non passa i controlli statici: un metodo
# cancellato per sbaglio si scopre qui, non dall'utente che clicca.
if [[ -x "$WD_ROOT/bin/verifica-estensione.sh" ]]; then
  "$WD_ROOT/bin/verifica-estensione.sh" || {
    echo "Installazione annullata." >&2; exit 1; }
  echo
fi

rm -rf "$DST"
mkdir -p "$(dirname "$DST")"
cp -a "$SRC" "$DST"

# Gli script viaggiano con l'estensione: così restano avviabili anche se la
# cartella dati viene cancellata e il JSON con il percorso del progetto sparisce.
for s in claude-sessions.py collect-metrics.py collect-usage.py session-purge.py project-purge.py project-relocate.py reclaim.py trash-scaduti.py; do
  cp -a "$WD_ROOT/bin/$s" "$DST/$s"
  chmod +x "$DST/$s"
done

# Gli schemi GSettings vanno compilati nella destinazione: senza
# gschemas.compiled l'estensione non parte proprio.
if [[ -d "$DST/schemas" ]]; then
  glib-compile-schemas "$DST/schemas" || {
    echo "compilazione degli schemi fallita" >&2; exit 1; }
fi

# Una prima raccolta, altrimenti al primo avvio il pannello mostrerebbe "?"
"$WD_ROOT/bin/collect-metrics.py" --quiet

echo "Installata in $DST"
echo
if gnome-extensions list 2>/dev/null | grep -qx "$UUID"; then
  echo "GNOME la vede già. Per attivarla:  gnome-extensions enable $UUID"
else
  echo "GNOME non la vede ancora: la shell enumera le estensioni all'avvio."
  echo "Su Wayland serve un logout/login. Al rientro:"
  echo "    gnome-extensions enable $UUID"
fi
