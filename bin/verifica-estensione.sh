#!/usr/bin/env bash
# Controlli statici sull'estensione, da passare PRIMA di installarla.
#
# Esiste per un motivo preciso: il 2026-09-17 una riscrittura ha cancellato il
# metodo _apriTerminale, e «Riprendi» ha smesso di funzionare con un errore
# visibile solo nel journal — scoperto dall'utente, non da noi.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SRC="$WD_ROOT/gnome-extension/claude-code-watchdog@cirobox.local"
ko=0

echo "Verifica di $SRC"
echo

for f in extension.js prefs.js; do
  printf '  %-34s ' "$f: sintassi"
  if gjs -m "$SRC/$f" 2>&1 | grep -qi syntaxerror; then echo "✗"; ko=1; else echo "ok"; fi
done

printf '  %-34s ' "schema GSettings"
if glib-compile-schemas --dry-run "$SRC/schemas" 2>/dev/null; then echo "ok"; else echo "✗"; ko=1; fi

printf '  %-34s ' "icone: XML valido"
# In una sotto-shell: un exit dentro il for ucciderebbe l'intero script e i
# controlli sotto — quelli per cui questo file esiste — non girerebbero.
# nullglob perché senza SVG il glob resterebbe letterale.
_n=$(shopt -s nullglob; set -- "$SRC"/icons/*.svg; echo $#)
if ( shopt -s nullglob
     for i in "$SRC"/icons/*.svg; do
       python3 -c "import xml.etree.ElementTree as E;E.parse('$i')" || exit 1
     done ); then echo "ok ($_n)"; else echo "✗"; ko=1; fi

# I due controlli che contano davvero: riferimenti che non esistono.
printf '  %-34s ' "metodi chiamati ma non definiti"
_m=$(python3 - "$SRC/extension.js" <<'PY'
import re, sys, pathlib
s = pathlib.Path(sys.argv[1]).read_text()
definiti = set(re.findall(r'^\s{4}(?:get )?([A-Za-z_]\w*)\s*\(', s, re.M))
chiamati = set(re.findall(r'this\.(_[A-Za-z]\w*)\(', s))
print(' '.join(sorted(c for c in chiamati if c not in definiti)))
PY
)
if [[ -z "$_m" ]]; then echo "ok"; else echo "✗ $_m"; ko=1; fi

printf '  %-34s ' "chiavi GSettings inesistenti"
_k=$(python3 - "$SRC" <<'PY'
import re, sys, pathlib, subprocess
src = pathlib.Path(sys.argv[1])
# Si cerca il file, non lo si nomina: rinominare l'estensione cambia il nome
# dello schema, e un controllo che lo cabla smette di funzionare in silenzio.
schemi = list((src / 'schemas').glob('*.gschema.xml'))
if not schemi:
    print('NESSUNO-SCHEMA'); raise SystemExit
schema = schemi[0].read_text()
esistenti = set(re.findall(r'<key name="([\w-]+)"', schema))
# Solo le chiavi lette dal NOSTRO oggetto impostazioni: l'estensione legge
# anche il profilo di Ptyxis, che ha uno schema suo e chiavi diverse.
usate = set()
for f, prefissi in (('extension.js', (r'this\._settings\.',)),
                    ('prefs.js', (r'\bs\.',))):
    t = (src / f).read_text()
    for pre in prefissi:
        usate |= set(re.findall(
            pre + r"(?:get_boolean|get_int|get_string|get_strv|set_int|set_strv|bind)\('([\w-]+)'", t))
        # connect('changed', ...) senza chiave non nomina nulla: si prende solo
        # la forma changed::<chiave>
        usate |= set(re.findall(pre + r"connect\('changed::([\w-]+)'", t))
print(' '.join(sorted(u for u in usate if u not in esistenti)))
PY
)
if [[ -z "$_k" ]]; then echo "ok"; else echo "✗ $_k"; ko=1; fi

printf '  %-34s ' "classi CSS usate ma non definite"
_c=$(python3 - "$SRC" <<'PY'
import re, sys, pathlib
src = pathlib.Path(sys.argv[1])
css = set(re.findall(r'^\.([\w-]+)', (src / 'stylesheet.css').read_text(), re.M))
js = (src / 'extension.js').read_text()
usate = set()
for m in re.findall(r"style_class: '([^']+)'", js): usate |= set(m.split())
for m in re.findall(r"style_class = '([^']+)'", js): usate |= set(m.split())
for m in re.findall(r"_style_class_name\('([^']+)'\)", js): usate.add(m)
ignora = {'system-status-icon', 'popup-menu-item'}
print(' '.join(sorted(u for u in usate - ignora if u not in css)))
PY
)
if [[ -z "$_c" ]]; then echo "ok"; else echo "✗ $_c"; ko=1; fi

# Gli script devono esistere in bin/ E essere nelle liste che li copiano
# dentro l'estensione: install e pack hanno due liste separate, e dimenticarne
# una lascia il pacchetto senza uno script che il codice chiama.
printf '  %-34s ' "script citati, presenti e copiati"
_s=$(grep -o "_percorsoScript('[^']*')" "$SRC/extension.js" | grep -o "'[^']*'" | tr -d "'" | sort -u)
_manca=""
for x in $_s; do
  [[ -f "$WD_ROOT/bin/$x" ]] || _manca="$_manca $x(assente)"
  grep -q "$x" "$WD_ROOT/bin/install-extension.sh" || _manca="$_manca $x(non installato)"
  grep -q "$x" "$WD_ROOT/bin/pack-extension.sh" || _manca="$_manca $x(non impacchettato)"
done
if [[ -z "$_manca" ]]; then echo "ok ($(echo "$_s" | wc -w))"; else echo "✗$_manca"; ko=1; fi

# Gli script bundled si chiamano anche fra loro: reclaim.py ha bisogno di
# trash-scaduti.py, collect-metrics.py di claude-sessions.py. Chi arriva
# dentro l'estensione senza le sue dipendenze fallisce solo a pulsante
# premuto, e nel journal.
printf '  %-34s ' "dipendenze fra script bundled"
_d=$(grep -hoE '(_script\(|SCRIPT_DIR / )"[a-z-]+\.py"' "$WD_ROOT"/bin/*.py \
     | grep -oE '"[a-z-]+\.py"' | tr -d '"' | sort -u)
_manca=""
for x in $_d; do
  [[ -f "$WD_ROOT/bin/$x" ]] || _manca="$_manca $x(assente)"
  grep -q "$x" "$WD_ROOT/bin/install-extension.sh" || _manca="$_manca $x(non installato)"
  grep -q "$x" "$WD_ROOT/bin/pack-extension.sh" || _manca="$_manca $x(non impacchettato)"
done
if [[ -z "$_manca" ]]; then echo "ok ($(echo "$_d" | wc -w))"; else echo "✗$_manca"; ko=1; fi

echo
if (( ko )); then echo "NON installare finché non è tutto a posto."; else echo "Tutto a posto."; fi
exit $ko
