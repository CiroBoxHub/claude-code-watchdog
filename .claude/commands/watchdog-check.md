---
description: Report completo su stato del PC e di Claude Code, senza toccare niente
argument-hint: "[sistema|claude]  (vuoto = entrambi)"
allowed-tools: Bash(./bin/scan-system.sh:*), Bash(./bin/scan-claude.sh:*), Bash(./bin/claude-sessions.py:*), Bash(./bin/collect-metrics.py:*), Bash(mkdir:*), Bash(tee:*), Bash(date:*)
---

Fai il punto sullo stato della macchina. **Sola lettura: non cancellare e non
modificare niente**, nemmeno se qualcosa sembra ovvio da sistemare.

Ambito richiesto: `$1` (se vuoto, entrambi).

1. Lancia gli scan che servono, dalla radice del progetto:
   - sistema → `./bin/scan-system.sh`
   - claude  → `./bin/scan-claude.sh`
2. Lancia anche `./bin/collect-metrics.py --quiet`: aggiorna il cruscotto nel
   pannello GNOME e aggiunge un campione alla serie storica. Costa mezzo
   secondo e senza campioni il grafico dell'estensione resta vuoto.
3. Salva l'output grezzo in `reports/check-$(date +%Y-%m-%d-%H%M).md`, così
   si possono confrontare due momenti diversi.
4. Poi **riassumi tu**, non incollare l'output intero. Vale questo ordine:
   - Prima le cose che richiedono una decisione o che stanno peggiorando.
   - Poi lo spazio recuperabile, con il numero in MB.
   - Chiudi con una riga su cosa è a posto, senza elencarlo voce per voce.
5. Se c'è un report precedente in `reports/`, confronta e di' cosa è cambiato.
   È la parte più utile: un numero da solo dice poco, la sua direzione sì.
6. Se emerge qualcosa da pulire, **proponi** `/watchdog-clean` — non lanciarlo.

Scrivi in italiano, in modo asciutto. Niente allarmismi su numeri che non
sono un problema: 14% di disco usato non è una notizia.
