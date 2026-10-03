#!/usr/bin/env bash
# Fotografa la barra e il popup dell'estensione, in tema chiaro e scuro.
#
#   bin/fotografa-pannello.sh [CARTELLA]   (predefinito: grafica/foto/)
#
# Lo stesso trucco di fotografa-icone.sh: shell annidata headless con una HOME
# FINTA, cosi' dconf e le estensioni della sessione vera non si toccano. Dentro
# si installa la copia di lavoro dell'estensione, si copiano le preferenze
# dell'utente, e ~/.claude punta a quella vera in sola lettura: i numeri sono
# quelli veri, le scritture finiscono nella cartella temporanea.
# Per Watchface si scrivono due sessioni finte: una che aspetta te con due
# aiutanti, una che lavora.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

UUID="claude-code-watchdog@cirobox.local"
SRC="$WD_ROOT/gnome-extension/$UUID"
OUT=$(realpath -m "${1:-$WD_ROOT/grafica/foto}")
mkdir -p "$OUT"
for c in gnome-shell dbus-run-session gsettings dconf; do
  command -v "$c" >/dev/null || { echo "$c non disponibile"; exit 0; }
done

P=$(mktemp -d)
trap 'fusermount3 -u "$P/run/doc" 2>/dev/null; fusermount -u "$P/run/doc" 2>/dev/null; rm -rf "$P" 2>/dev/null' EXIT
H="$P/home"
EXT="$H/.local/share/gnome-shell/extensions"
mkdir -p "$EXT" "$P/run" "$H/.local/share" "$H/.cache" "$H/.config"
chmod 700 "$P/run"
cp -a "$SRC" "$EXT/$UUID"
for s in claude-sessions.py collect-metrics.py collect-usage.py session-purge.py \
         project-purge.py project-relocate.py reclaim.py trash-scaduti.py \
         watchface-hook watchface-hooks.py; do
  cp -a "$WD_ROOT/bin/$s" "$EXT/$UUID/$s"
done
glib-compile-schemas "$EXT/$UUID/schemas"
ln -s "$HOME/.claude" "$H/.claude"
# I dati del cruscotto copiati, non collegati: la shell di prova li riscrive.
mkdir -p "$H/.local/share/claude-code-watchdog"
cp -a "${XDG_DATA_HOME:-$HOME/.local/share}/claude-code-watchdog/"{metrics.json,usage.json,history.jsonl} \
  "$H/.local/share/claude-code-watchdog/" 2>/dev/null
PREF=$(dconf dump /org/gnome/shell/extensions/claude-code-watchdog/)

WF="$P/run/claude-code-watchdog/watchface"
mkdir -p "$WF"
ora=$(date +%s)
printf 'PermissionRequest\t%s\t0\t2\t%s\n' "$ora" "/home/utente/Documenti/sito-cliente" > "$WF/sessione-a"
printf 'PreToolUse\t%s\t0\t0\t%s\n' "$ora" "/home/utente/Documenti/claude-code-watchdog" > "$WF/sessione-b"

F="$EXT/foto-pannello@prova"
mkdir -p "$F"
echo '{"uuid":"foto-pannello@prova","name":"foto","description":"-","shell-version":["48","49","50"]}' > "$F/metadata.json"
cat > "$F/extension.js" <<EOF
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
Gio._promisify(Shell.Screenshot.prototype, 'screenshot_area');
async function foto(x, y, w, h, nome) {
    const s = Gio.File.new_for_path('$P/' + nome).replace(null, false, 0, null);
    await new Shell.Screenshot().screenshot_area(Math.max(0, Math.floor(x)), Math.max(0, Math.floor(y)),
                                                 Math.ceil(w), Math.ceil(h), s);
    s.close(null);
}
export default class Foto extends Extension {
    enable() {
        GLib.timeout_add(0, 9000, () => {
            (async () => {
                const ind = Main.panel.statusArea['$UUID'];
                if (!ind) { console.log('FOTO: indicatore assente'); return; }
                const [px, py] = ind.get_transformed_position();
                const [pw, ph] = ind.get_transformed_size();
                await foto(px - 60, 0, pw + 120, ph, 'barra.png');
                await foto(0, 0, global.stage.width, ph, 'barra-intera.png');
                ind.menu.open(false);
                await new Promise(r => GLib.timeout_add(0, 1500, () => { r(); return false; }));
                const a = ind.menu.actor;
                const [mx, my] = a.get_transformed_position();
                const [mw, mh] = a.get_transformed_size();
                await foto(mx, my, mw, mh, 'popup.png');
                ind.menu.close(false);
                // Le preferenze, aperte come le apre l'utente: e' un altro
                // processo, i suoi errori finiscono nel log della sessione.
                Main.overview.hide();
                Main.extensionManager.openExtensionPrefs('$UUID', '', {});
                await new Promise(r => GLib.timeout_add(0, 7000, () => { r(); return false; }));
                await foto(0, 0, global.stage.width, global.stage.height, 'preferenze.png');
                // La scheda «Watchface», con un puntatore virtuale: solo la
                // scheda, mai un pulsante — la pagina legge i settings veri.
                const fin = global.get_window_actors().map(a => a.meta_window)
                    .find(w => (w.get_wm_class() ?? '').includes('Extensions'));
                if (fin) {
                    const r = fin.get_frame_rect();
                    const seat = Clutter.get_default_backend().get_default_seat();
                    const ptr = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
                    const t = () => GLib.get_monotonic_time();
                    // Quinta di sette schede, sulla barra in fondo alla finestra.
                    ptr.notify_absolute_motion(t(), r.x + r.width * 9 / 14, r.y + r.height - 22);
                    ptr.notify_button(t(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED);
                    ptr.notify_button(t(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED);
                    await new Promise(r2 => GLib.timeout_add(0, 2500, () => { r2(); return false; }));
                    await foto(0, 0, global.stage.width, global.stage.height, 'preferenze-watchface.png');
                    console.log('FINESTRA ' + r.x + ',' + r.y + ' ' + r.width + 'x' + r.height);
                }
                console.log('FOTO FATTE');
            })().catch(e => console.log('FOTO FALLITE ' + e + ' ' + e.stack));
            return false;
        });
    }
    disable() {}
}
EOF

for tema in scuro chiaro; do
  schema=$([[ $tema == chiaro ]] && echo prefer-light || echo prefer-dark)
  rm -f "$P"/*.png
  timeout 120 env -i PATH=/usr/bin:/bin HOME="$H" XDG_CONFIG_HOME="$H/.config" \
    XDG_DATA_HOME="$H/.local/share" XDG_CACHE_HOME="$H/.cache" XDG_RUNTIME_DIR="$P/run" \
    LANG="${LANG:-it_IT.UTF-8}" dbus-run-session -- bash -c "
      gsettings set org.gnome.shell disable-user-extensions false
      gsettings set org.gnome.shell enabled-extensions \"['$UUID', 'foto-pannello@prova']\"
      gsettings set org.gnome.desktop.interface color-scheme '$schema'
      printf '%s\n' \"\$1\" | dconf load /org/gnome/shell/extensions/claude-code-watchdog/
      dconf write /org/gnome/shell/extensions/claude-code-watchdog/usage-enabled false
      gnome-shell --headless --virtual-monitor 1600x1000 >'$P/log-$tema' 2>&1 &
      S=\$!; sleep 32; kill \$S; wait \$S" _ "$PREF" >"$P/sessione-$tema" 2>&1
  if grep -q "FOTO FATTE" "$P/log-$tema"; then
    for f in barra barra-intera popup preferenze preferenze-watchface; do cp "$P/$f.png" "$OUT/$f-$tema.png"; done
    echo "tema $tema: foto in $OUT"
  else
    echo "tema $tema: foto non riuscite"
    grep -E "FOTO|JS ERROR|$UUID" "$P/log-$tema" | head -8
  fi
  grep -hE "JS ERROR|TypeError|ReferenceError|Gjs-CRITICAL|Gjs-WARNING" \
    "$P/log-$tema" "$P/sessione-$tema" | head -8
done
