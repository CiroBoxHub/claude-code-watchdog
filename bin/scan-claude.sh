#!/usr/bin/env bash
# Stato di Claude Code: spazio, retention, salute della configurazione.
# SOLA LETTURA: non modifica e non cancella nulla.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

echo "# Scan Claude Code — $(date '+%Y-%m-%d %H:%M')"
echo
echo "Versione CLI: $(claude --version 2>/dev/null || echo '?') · "\
"totale su disco: **$(size_h "$CLAUDE_DIR")**"

h1 "Dove va lo spazio"
table_head "Cartella" "Peso"
while read -r sz path; do
  path="${path%/}"            # du stampa lo slash finale: va tolto prima
  row "\`${path##*/}/\`" "$sz"
done < <(du -sh "$CLAUDE_DIR"/*/ 2>/dev/null | sort -rh | head -12)
row "\`~/.claude.json\`" "$(size_h "$HOME/.claude.json")"
row "\`history.jsonl\`" "$(size_h "$CLAUDE_DIR/history.jsonl")"

h1 "Retention — cosa ha superato la scadenza"
echo "Soglie da \`config/watchdog.conf\`. Niente viene cancellato qui: è solo un elenco."
echo
table_head "Cosa" "Scaduto"
_stale_total_mb=0
_stale_total_n=0
_ret() { # _ret "etichetta" percorso giorni
  local n b
  n=$(stale_count "$2" "$3"); b=$(stale_mb "$2" "$3")
  _stale_total_mb=$(( _stale_total_mb + b ))
  _stale_total_n=$(( _stale_total_n + n ))
  row "$1 (>$3 gg)" "$n file · ${b} MB"
}
_ret "jobs" "$CLAUDE_DIR/jobs" "$CLAUDE_JOBS_RETENTION_DAYS"
_ret "shell-snapshots" "$CLAUDE_DIR/shell-snapshots" "$CLAUDE_SHELL_SNAPSHOT_RETENTION_DAYS"
_ret "file-history" "$CLAUDE_DIR/file-history" "$CLAUDE_FILE_HISTORY_RETENTION_DAYS"
_ret "paste-cache" "$CLAUDE_DIR/paste-cache" "$CLAUDE_PASTE_CACHE_RETENTION_DAYS"
_ret "trascrizioni" "$CLAUDE_DIR/projects" "$CLAUDE_TRANSCRIPT_RETENTION_DAYS"
echo
echo "**Totale scaduto: ${_stale_total_n} file · ${_stale_total_mb} MB**"

h2 "Trascrizioni oltre la scadenza"
_old=$("$WD_ROOT/bin/claude-sessions.py" --older-than "$CLAUDE_TRANSCRIPT_RETENTION_DAYS" 2>/dev/null)
if [[ "$_old" == *"Nessuna sessione"* ]]; then
  echo "Nessuna trascrizione più vecchia di $CLAUDE_TRANSCRIPT_RETENTION_DAYS giorni."
else
  echo "$_old" | head -4
  echo
  echo "_Elenco completo: \`bin/claude-sessions.py --older-than $CLAUDE_TRANSCRIPT_RETENTION_DAYS\`_"
fi

h1 "Salute configurazione"

h2 "File di configurazione"
for f in "$CLAUDE_DIR/settings.json" "$CLAUDE_DIR/settings.local.json" "$HOME/.claude.json"; do
  [[ -f "$f" ]] || continue
  if python3 -c "import json,sys; json.load(open(sys.argv[1]))" "$f" 2>/dev/null; then
    printf -- '- ✅ `%s` — JSON valido (%s)\n' "${f/#$HOME/\~}" "$(size_h "$f")"
  else
    printf -- '- ❌ `%s` — **JSON non valido**\n' "${f/#$HOME/\~}"
  fi
done

h2 "Plugin"
python3 - "$CLAUDE_DIR" <<'PY'
import json, sys
from pathlib import Path
cd = Path(sys.argv[1])
inst = cd / "plugins" / "installed_plugins.json"
settings = cd / "settings.json"
enabled = {}
if settings.exists():
    try:
        enabled = json.loads(settings.read_text()).get("enabledPlugins", {})
    except Exception:
        pass
if not inst.exists():
    print("- Nessun plugin installato")
else:
    data = json.loads(inst.read_text()).get("plugins", {})
    if not data:
        print("- Nessun plugin installato")
    for name, entries in data.items():
        for e in entries:
            p = Path(e.get("installPath", ""))
            on = enabled.get(name)
            state = "attivo" if on else ("disattivato" if on is False else "non elencato in settings.json")
            if not p.is_dir():
                print(f"- ❌ `{name}` — {state}, ma **la cartella non esiste**: `{p}`")
            else:
                print(f"- ✅ `{name}` — {state} · installato {e.get('installedAt','?')[:10]}")
    for name in enabled:
        if name not in data:
            print(f"- ⚠️  `{name}` — abilitato in settings.json ma **non installato**")
PY
echo
echo "_Nota: un plugin installato e attivo può comunque fallire la connessione"
echo "in sessione (es. un server MCP che non parte). Quello si vede solo"
echo "all'avvio di Claude Code, non da qui._"

h2 "Server MCP configurati"
python3 - "$HOME/.claude.json" <<'PY'
import json, sys
from pathlib import Path
p = Path(sys.argv[1])
if not p.exists():
    print("- `~/.claude.json` assente"); raise SystemExit
d = json.loads(p.read_text())
glob = d.get("mcpServers") or {}
print(f"- Globali: {', '.join(f'`{k}`' for k in glob) if glob else 'nessuno'}")
rows = []
for proj, v in (d.get("projects") or {}).items():
    srv = v.get("mcpServers") or {}
    if srv:
        rows.append((proj, list(srv)))
if rows:
    print("- Per progetto:")
    for proj, srv in rows:
        mark = "" if Path(proj).is_dir() else "  ⚠️ _cartella non esiste più_"
        print(f"  - `{proj}`: {', '.join(f'`{s}`' for s in srv)}{mark}")
else:
    print("- Per progetto: nessuno")
PY

h2 "Progetti registrati in ~/.claude.json che non esistono più"
python3 - "$HOME/.claude.json" <<'PY'
import json, sys
from pathlib import Path
d = json.loads(Path(sys.argv[1]).read_text())
missing = [p for p in (d.get("projects") or {}) if not Path(p).is_dir()]
if missing:
    for p in missing:
        print(f"- `{p}`")
    print(f"\n_{len(missing)} voci orfane: occupano poco, ma sporcano il "
          "selettore dei progetti._")
else:
    print("- Nessuno: tutte le cartelle registrate esistono")
PY

h2 "Cartelle trascrizioni orfane"
python3 - "$CLAUDE_DIR" <<'PY'
import json, sys
from pathlib import Path
# La codifica cartella<->percorso è cambiata tra le versioni di Claude Code
# (cliente_alfa è diventato cliente-alfa) e non è invertibile: il percorso vero
# si legge dal campo cwd dentro le trascrizioni.
proj = Path(sys.argv[1]) / "projects"
orphans = []
for d in sorted(proj.iterdir()) if proj.is_dir() else []:
    if not d.is_dir():
        continue
    cwd = None
    for f in d.glob("*.jsonl"):
        for raw in f.open("rb"):
            try:
                r = json.loads(raw)
            except Exception:
                continue
            if isinstance(r, dict) and r.get("cwd"):
                cwd = r["cwd"]; break
        if cwd:
            break
    if cwd and not Path(cwd).is_dir():
        sz = sum(f.stat().st_size for f in d.rglob("*") if f.is_file())
        orphans.append((d.name, cwd, sz))
if orphans:
    print("| Cartella in projects/ | Percorso originale (sparito) | Peso |")
    print("|---|---|---|")
    for name, cwd, sz in sorted(orphans, key=lambda r: -r[2]):
        print(f"| `{name}` | `{cwd}` | {sz/1048576:.1f} MB |")
    print("\n_Le conversazioni restano leggibili: è la cartella di lavoro a non "
          "esistere più. Vanno archiviate, non cancellate a cuor leggero._")
else:
    print("- Nessuna")
PY

h1 "Allarmi"
_any=0
alert "Dimensione ~/.claude" "$(size_mb "$CLAUDE_DIR")" "$ALERT_CLAUDE_MB" " MB" && _any=1
if (( _stale_total_mb > 50 )); then
  printf -- '- ⚠️  **Sottoprodotti scaduti**: %s MB in %s file — `/watchdog-clean` li elenca\n' \
    "$_stale_total_mb" "$_stale_total_n"
  _any=1
fi
(( _any == 0 )) && echo "- ✅ Nessuna soglia superata"

# Uno scan che non trova nulla non è un errore: senza questo,
# l'ultima espressione aritmetica deciderebbe il codice di uscita.
exit 0
