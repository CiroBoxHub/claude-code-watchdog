---
description: Mostra cosa si può liberare e, solo dopo conferma, lo libera
argument-hint: "[target ...]  (vuoto = tutti i target sicuri)"
allowed-tools: Bash(./bin/clean.sh:*), Bash(./bin/claude-sessions.py:*), Bash(df:*), Bash(du:*), Bash(coredumpctl list:*)
---

Pulizia guidata. **La regola è una: prima si guarda, poi si cancella.**

Target richiesti: `$1` (se vuoto, tutti quelli sicuri).

1. Lancia **sempre prima il dry-run**: `./bin/clean.sh $1`
   (senza `--apply` non tocca niente).
2. Presenta il risultato all'utente ordinato per spazio liberato, e per ogni
   voce di' in una riga **cosa si perde davvero** se la si cancella. Se lo
   script segnala file grossi che sparirebbero, riportali: un `dump.sql` da
   134 MB dentro `jobs/tmp/` è una cosa che uno vuole vedere prima.
3. **Fermati e chiedi quali target eseguire.** Non dare per scontato "tutti".
4. Solo dopo un sì esplicito: `./bin/clean.sh --apply <target scelti>`.
   I comandi con `sudo` chiederanno la password all'utente: è normale, dillo.
5. A fine giro, riporta lo spazio effettivamente liberato con `df -h /`.

Cose da non fare mai in automatico, nemmeno se l'utente dice "fai tutto":
- rimuovere kernel (`kernels`) senza aver detto quale resta e che è avviabile;
- `dnf autoremove` (`orphans`) senza aver letto l'elenco insieme — dnf ci
  mette dentro anche roba usata a mano, tipo `7zip` o `arj`;
- cancellare trascrizioni duplicate (`claude-dups`): in
  `~/.claude/projects/-tmp/` sono **backup voluti**, lo dice il README di
  `~/Documenti/Claude/`;
- toccare `~/.claude.json` (`claude-projects`) con Claude Code aperto: quel
  file tiene anche i permessi accordati, e viene riscritto alla chiusura.
