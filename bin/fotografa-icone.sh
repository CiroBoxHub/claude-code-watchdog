#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 CiroBoxHub
# Fotografa le icone -symbolic come le disegna davvero GNOME Shell.
#
#   bin/fotografa-icone.sh [FILE.png]     (predefinito: grafica/foto-icone.png)
#
# Esiste perche' la ricolorazione delle icone non si indovina: il 2026-10-03 si
# e' scoperto cosi' che la shell riempie ogni forma del colore del testo e
# lascia i tratti del colore del file, e che tutte le icone del pannello erano
# uscite piene e col bordo grigio fin dall'inizio.
#
# Gira in una shell annidata headless con una HOME FINTA: impostazioni,
# estensioni e dconf stanno in una cartella temporanea. Abilitare
# un'estensione qui dentro con la HOME vera la abiliterebbe anche nella
# sessione in corso, perche' dconf e' lo stesso.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ICONE="$WD_ROOT/gnome-extension/claude-code-watchdog@cirobox.local/icons"
FOTO=$(realpath -m "${1:-$WD_ROOT/grafica/foto-icone.png}")
for c in gnome-shell dbus-run-session gsettings; do
  command -v "$c" >/dev/null || { echo "$c non disponibile"; exit 0; }
done

P=$(mktemp -d)
# Il portale documenti della shell di prova monta un FUSE in run/doc: va
# smontato, se no la cartella non si cancella.
trap 'fusermount3 -u "$P/run/doc" 2>/dev/null; fusermount -u "$P/run/doc" 2>/dev/null; rm -rf "$P" 2>/dev/null' EXIT
E="$P/home/.local/share/gnome-shell/extensions/foto-icone@prova"
mkdir -p "$E" "$P/run"; chmod 700 "$P/run"
NOMI=$(cd "$ICONE" && ls *-symbolic.svg | sed 's/-symbolic.svg$//' \
       | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read().split()))')

echo '{"uuid":"foto-icone@prova","name":"foto","description":"-","shell-version":["48","49","50"]}' \
  > "$E/metadata.json"
cat > "$E/extension.js" <<EOF
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
Gio._promisify(Shell.Screenshot.prototype, 'screenshot_area');
export default class Foto extends Extension {
    enable() {
        const col = new St.BoxLayout({orientation: 1,
            style: 'background-color: #ffffff; padding: 12px; spacing: 10px;'});
        // Fondo chiaro e scuro, grandi per vedere e a 16 px come nel pannello.
        for (const [fondo, testo, lato] of [['#f0f0f0', '#2e2e2e', 48], ['#1e1e1e', '#f0f0f0', 48],
                                            ['#f0f0f0', '#2e2e2e', 16], ['#1e1e1e', '#f0f0f0', 16]]) {
            const riga = new St.BoxLayout({style: \`background-color: \${fondo}; padding: 8px; spacing: 12px;\`});
            for (const n of $NOMI)
                riga.add_child(new St.Icon({
                    gicon: Gio.icon_new_for_string('$ICONE/' + n + '-symbolic.svg'),
                    icon_size: lato, style: \`color: \${testo}; warning-color: #B77B1A;\`}));
            col.add_child(riga);
        }
        Main.uiGroup.add_child(col);
        GLib.timeout_add(0, 4000, () => {
            const [w, h] = col.get_size();
            const s = Gio.File.new_for_path('$FOTO').replace(null, false, 0, null);
            new Shell.Screenshot().screenshot_area(0, 0, Math.ceil(w), Math.ceil(h), s)
                .then(() => { s.close(null); console.log('FOTO FATTA'); })
                .catch(e => console.log('FOTO FALLITA ' + e));
            return GLib.SOURCE_REMOVE;
        });
    }
    disable() {}
}
EOF

timeout 90 env -i PATH=/usr/bin:/bin HOME="$P/home" XDG_CONFIG_HOME="$P/home/.config" \
  XDG_DATA_HOME="$P/home/.local/share" XDG_CACHE_HOME="$P/home/.cache" \
  XDG_RUNTIME_DIR="$P/run" dbus-run-session -- bash -c "
    gsettings set org.gnome.shell disable-user-extensions false
    gsettings set org.gnome.shell enabled-extensions \"['foto-icone@prova']\"
    gnome-shell --headless --virtual-monitor 1600x600 >'$P/log' 2>&1 &
    S=\$!; sleep 20; kill \$S; wait \$S" >/dev/null 2>&1

if grep -q "FOTO FATTA" "$P/log"; then
  echo "foto in $FOTO"
else
  echo "foto non riuscita:"; grep -E "FOTO|JS ERROR" "$P/log" | head -5
  exit 1
fi
