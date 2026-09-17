---
description: Inventario delle sessioni e chat di Claude Code, con comando per riprenderle
argument-hint: "[--older-than GIORNI] [--min-msg N]"
allowed-tools: Bash(./bin/claude-sessions.py:*)
---

Inventario di tutte le conversazioni Claude Code sulla macchina.

1. Lancia `./bin/claude-sessions.py $ARGUMENTS`.
2. Mostra la tabella così com'è: è già il formato giusto, non riscriverla.
3. Aggiungi sotto solo quello che la tabella non dice da sola:
   - progetti la cui cartella di lavoro non esiste più (la conversazione è
     ancora leggibile, è il `cwd` a essere sparito);
   - conversazioni grosse e vecchie che varrebbe la pena archiviare;
   - se il numero di sessioni-fantasma è cresciuto molto, dillo: vuol dire
     che qualcosa invoca Claude in modo non interattivo a ripetizione.

Se l'utente chiede di **riprendere** una sessione, non lanciarla tu: dagli il
comando da incollare, perché va eseguito nel suo terminale interattivo e dalla
cartella giusta.
