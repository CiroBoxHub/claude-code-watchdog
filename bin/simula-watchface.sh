#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 CiroBoxHub
# Fa passare Watchface per tutti i suoi stati con tre sessioni finte, per
# guardarli a occhio: faccina nella barra, popup, notifiche o mascotte.
#
#   bin/simula-watchface.sh [PAUSA]     (secondi fra un passo e l'altro, predefinito 8)
#
# Scrive le stesse righe che scrive l'hook, nella stessa cartella, con nomi
# che cominciano per «simula-»: le sessioni vere non si toccano. Alla fine, o
# con Ctrl+C, le righe finte si tolgono.
#
# Gli avvisi non partono se la finestra in primo piano è un terminale (è
# voluto): dopo il via, passa a un'altra finestra.
set -uo pipefail

PAUSA=${1:-8}
[[ $PAUSA =~ ^[0-9]+$ ]] || { echo "PAUSA dev'essere un numero di secondi"; exit 2; }
DIR="${XDG_RUNTIME_DIR:-/run/user/$UID}/claude-code-watchdog/watchface"
mkdir -p -m 700 "$DIR"

pulisci() { rm -f -- "$DIR"/simula-a "$DIR"/simula-b "$DIR"/simula-c; }
trap 'pulisci; echo; echo "Sessioni finte tolte."; exit 0' INT TERM
trap pulisci EXIT

# riga SESSIONE EVENTO FALLIMENTI AIUTANTI PROGETTO — come watchface-hook,
# senza pid: un clic porta all'ultimo terminale usato.
riga() {
  printf '%s\t%s\t%s\t%s\t%s\t\n' "$2" "$(date +%s)" "$3" "$4" "$HOME/simulazione/$5" \
    > "$DIR/$1.tmp" && mv -f "$DIR/$1.tmp" "$DIR/$1"
}
passo() { echo "  $*"; sleep "$PAUSA"; }

echo "Fra 6 secondi si comincia: passa a una finestra che non sia il terminale."
sleep 6
riga simula-b PreToolUse 0 2 app-ricette
passo "1. app-ricette lavora, con 2 aiutanti        → occhi aperti, robottino ×2"
riga simula-c StopFailure 0 0 blog-cucina
passo "2. blog-cucina si inceppa                    → limone, rosso"
riga simula-a PermissionRequest 0 0 sito-vetrina
passo "3. sito-vetrina chiede un permesso           → bocca aperta, ambra"
riga simula-a PostToolUse 0 0 sito-vetrina
passo "4. hai dato il permesso                      → torna il limone"
riga simula-c UserPromptSubmit 0 0 blog-cucina
passo "5. blog-cucina riparte                       → occhi aperti"
# «Ha finito» si annuncia solo dopo un lavoro di almeno 30 secondi: se le
# pause sono corte, si aspetta il resto.
attesa=$(( 30 - 5 * PAUSA ))
(( attesa > 0 )) && { echo "     (aspetto ${attesa}s: «ha finito» vale dopo mezzo minuto di lavoro)"; sleep "$attesa"; }
# Le altre due si fermano senza dire niente: con una sessione che lavora, la
# faccina della barra mostrerebbe «lavora» e non il sorriso.
riga simula-a SessionStart 0 0 sito-vetrina
riga simula-c SessionStart 0 0 blog-cucina
riga simula-b Stop 0 2 app-ricette
passo "6. app-ricette ha finito                     → sorriso, verde"
riga simula-b PreCompact 0 0 app-ricette
passo "7. app-ricette fa /compact                   → limone, occhi in su, bordo blu"
riga simula-b Stop 0 0 app-ricette
passo "8. il compact è finito                       → sorriso (avviso solo dopo 30 s)"
riga simula-b SessionStart 0 0 app-ricette
passo "9. tutto fermo                               → dorme, grigio"
echo "Fine. Tolgo le sessioni finte."
