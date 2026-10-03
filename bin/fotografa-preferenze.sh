#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 CiroBoxHub
# Fotografa ogni pagina delle preferenze, in tema chiaro e scuro.
#
#   bin/fotografa-preferenze.sh [CARTELLA]   (predefinito: grafica/foto-preferenze/)
#
# Esiste perche' nella shell annidata il clic simulato non arriva alla
# finestra delle preferenze (2026-10-03): si fotografava solo la prima pagina,
# e un menu' che non mostrava la scelta fatta e' arrivato fino all'utente.
# Qui la finestra la apre un processo nostro, che sceglie la pagina da solo e
# la disegna in un PNG con GTK — niente puntatore.
#
# Gira dentro una shell annidata headless (serve un display Wayland) con una
# HOME FINTA e dati inventati: dconf e' condiviso con la sessione vera, e le
# pagine mostrano percorsi e progetti.
# La classe base di GNOME (ExtensionPreferences) vive nel processo delle
# estensioni e si porta dietro il suo servizio D-Bus: al suo posto una
# copia minima che da' a prefs.js le stesse tre cose che usa — metadata, path
# e getSettings().
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

UUID="claude-code-watchdog@cirobox.local"
SRC="$WD_ROOT/gnome-extension/$UUID"
OUT=$(realpath -m "${1:-$WD_ROOT/grafica/foto-preferenze}")
mkdir -p "$OUT"
for c in gnome-shell dbus-run-session gjs glib-compile-schemas; do
  command -v "$c" >/dev/null || { echo "$c non disponibile"; exit 0; }
done

# Breve, in /tmp: il socket Wayland della shell di prova non accetta percorsi
# oltre i 108 caratteri.
P=$(mktemp -d)
trap 'fusermount3 -u "$P/run/doc" 2>/dev/null; fusermount -u "$P/run/doc" 2>/dev/null; rm -rf "$P" 2>/dev/null' EXIT
H="$P/home"
E="$P/estensione"
mkdir -p "$P/run" "$H/.cache" "$H/.config"
chmod 700 "$P/run"
cp -a "$SRC" "$E"
cp -a "$WD_ROOT/bin/watchface-hook" "$WD_ROOT/bin/watchface-hooks.py" "$E/"
glib-compile-schemas "$E/schemas"
python3 "$WD_ROOT/bin/dati-demo.py" "$H" >/dev/null

sed "s|'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js'|'./base-prova.js'|" \
  "$E/prefs.js" > "$E/prefs-prova.js"
cat > "$E/base-prova.js" <<'JS'
import Gio from 'gi://Gio';
export class ExtensionPreferences {
    constructor(metadata) {
        this.metadata = metadata;
        this.path = metadata.path;
        this.dir = metadata.dir;
        this.uuid = metadata.uuid;
    }
    getSettings() {
        const fonte = Gio.SettingsSchemaSource.new_from_directory(
            `${this.path}/schemas`, Gio.SettingsSchemaSource.get_default(), false);
        return new Gio.Settings({
            settings_schema: fonte.lookup(this.metadata['settings-schema'], true)});
    }
}
JS
cat > "$P/scatta.js" <<'JS'
import Gtk from 'gi://Gtk?version=4.0';
import Adw from 'gi://Adw?version=1';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

const [dir, out] = System.programArgs;
const pausa = ms => new Promise(r => GLib.timeout_add(0, ms, () => { r(); return false; }));
const app = new Adw.Application({application_id: 'org.prova.Preferenze'});
app.connect('activate', () => {
    app.hold();
    (async () => {
        const metadata = JSON.parse(new TextDecoder().decode(
            GLib.file_get_contents(`${dir}/metadata.json`)[1]));
        const modulo = await import(`file://${dir}/prefs-prova.js`);
        const prefs = new modulo.default({...metadata, dir: Gio.File.new_for_path(dir), path: dir});
        for (const tema of ['chiaro', 'scuro']) {
            Adw.StyleManager.get_default().color_scheme = tema === 'scuro'
                ? Adw.ColorScheme.FORCE_DARK : Adw.ColorScheme.FORCE_LIGHT;
            // Come la apre GNOME: ricerca spenta, poi decide prefs.js.
            const finestra = new Adw.PreferencesWindow({application: app,
                                                        title: metadata.name,
                                                        search_enabled: false});
            const pagine = [];
            const aggiungi = finestra.add.bind(finestra);
            finestra.add = p => {
                pagine.push(p);
                aggiungi(p);
            };
            await prefs.fillPreferencesWindow(finestra);
            // Alta, per vedere le pagine intere senza scorrere.
            finestra.set_default_size(680, 1900);
            finestra.present();
            await pausa(2500);
            for (const [i, p] of pagine.entries()) {
                finestra.visible_page = p;
                await pausa(900);
                const [w, h] = [finestra.get_width(), finestra.get_height()];
                const s = new Gtk.Snapshot();
                new Gtk.WidgetPaintable({widget: finestra}).snapshot(s, w, h);
                const nome = (p.title || `pagina${i}`).toLowerCase().replace(/[^a-z0-9]+/g, '-');
                finestra.get_renderer().render_texture(s.to_node(), null)
                    .save_to_png(`${out}/${i + 1}-${nome}-${tema}.png`);
            }
            // Il «?» di un gruppo: deve aprire la guida alla sua sezione.
            // Si chiama la stessa funzione del pulsante, senza clic.
            if (prefs._vaiAllaGuida) {
                prefs._vaiAllaGuida('progetti');
                await pausa(900);
                const [w, h] = [finestra.get_width(), finestra.get_height()];
                const s = new Gtk.Snapshot();
                new Gtk.WidgetPaintable({widget: finestra}).snapshot(s, w, h);
                finestra.get_renderer().render_texture(s.to_node(), null)
                    .save_to_png(`${out}/9-salto-alla-guida-${tema}.png`);
            }
            finestra.close();
            await pausa(500);
        }
        print('FOTO FATTE');
    })().catch(e => print(`FOTO FALLITE ${e}\n${e.stack}`)).finally(() => app.quit());
});
app.run([]);
JS

timeout 150 env -i PATH=/usr/bin:/bin HOME="$H" XDG_CONFIG_HOME="$H/.config" \
  XDG_DATA_HOME="$H/.local/share" XDG_CACHE_HOME="$H/.cache" XDG_RUNTIME_DIR="$P/run" \
  LANG="${LANG:-it_IT.UTF-8}" dbus-run-session -- bash -c "
    gsettings set org.gnome.shell welcome-dialog-last-shown-version '999'
    gnome-shell --headless --virtual-monitor 1600x2000 >'$P/shell.log' 2>&1 &
    S=\$!; sleep 8
    WAYLAND_DISPLAY=wayland-0 gjs -m '$P/scatta.js' '$E' '$OUT' >'$P/foto.log' 2>&1
    kill \$S; wait \$S" >/dev/null 2>&1
if grep -q "FOTO FATTE" "$P/foto.log"; then
  echo "foto in $OUT: $(ls "$OUT" | wc -l) pagine"
else
  echo "foto non riuscite:"; head -20 "$P/foto.log"
fi
grep -hE "JS ERROR|Gjs-CRITICAL|TypeError|ReferenceError" "$P/foto.log" | head -8
