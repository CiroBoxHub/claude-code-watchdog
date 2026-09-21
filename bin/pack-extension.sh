#!/usr/bin/env bash
# Crea lo zip installabile dell'estensione.
#
#   ./bin/pack-extension.sh
#
# Produce dist/claude-code-watchdog@cirobox.local.shell-extension.zip
# Su un altro PC:
#   gnome-extensions install --force <file>.zip
#   poi logout/login, e: gnome-extensions enable claude-code-watchdog@cirobox.local
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

UUID="claude-code-watchdog@cirobox.local"
SRC="$WD_ROOT/gnome-extension/$UUID"
DIST="$WD_ROOT/dist"

[[ -d "$SRC" ]] || { echo "sorgente mancante: $SRC" >&2; exit 1; }

if [[ -x "$WD_ROOT/bin/verifica-estensione.sh" ]]; then
  "$WD_ROOT/bin/verifica-estensione.sh" >/dev/null || {
    echo "I controlli statici falliscono: niente pacchetto." >&2; exit 1; }
fi

# Gli script di raccolta viaggiano dentro il pacchetto: senza, su un PC che non
# ha il progetto claude-code-watchdog l'estensione non avrebbe nulla da leggere.
for s in claude-sessions.py collect-metrics.py collect-usage.py session-purge.py project-purge.py project-relocate.py reclaim.py trash-scaduti.py; do
  cp -a "$WD_ROOT/bin/$s" "$SRC/$s"
  chmod +x "$SRC/$s"
done

mkdir -p "$DIST"
rm -f "$DIST/$UUID.shell-extension.zip"

# gnome-extensions pack include da sé solo extension.js, metadata.json,
# stylesheet.css e schemas/. Tutto il resto va elencato: senza, le icone e gli
# script Python restano fuori dal pacchetto e l'estensione non parte.
EXTRA=()
for f in "$SRC"/*.py; do EXTRA+=(--extra-source="$(basename "$f")"); done
[[ -d "$SRC/icons" ]] && EXTRA+=(--extra-source=icons)
[[ -f "$SRC/prefs.js" ]] && EXTRA+=(--extra-source=prefs.js)

gnome-extensions pack "$SRC" --force --out-dir="$DIST" "${EXTRA[@]}"

ZIP="$DIST/$UUID.shell-extension.zip"
echo "Pacchetto: $ZIP"
echo "Dimensione: $(du -h "$ZIP" | cut -f1)"
echo
echo "Contenuto:"
unzip -l "$ZIP" | sed -n '4,40p'
echo
echo "Per installarlo su un altro PC:"
echo "    gnome-extensions install --force $ZIP"
echo "    # poi logout/login"
echo "    gnome-extensions enable $UUID"
