#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-2.0-or-later
# Copyright (C) 2026 CiroBoxHub
"""Disegna la mascotte di Watchface e le sue comparse.

    grafica/mascotte.py               rigenera tutte le icone dell'estensione
    grafica/mascotte.py --anteprima   anche grafica/anteprima.svg e .png

Serve Inkscape. Le icone si modificano nei sorgenti, mai in icons/: la
mascotte qui sotto, le altre in grafica/sorgenti/, che sono leggibili e
disegnate a tratto.

**La shell non ricolora i tratti.** Fotografato il 2026-10-03 in una shell
annidata: delle icone -symbolic forza il RIEMPIMENTO di ogni forma, ellissi
comprese, al colore del testo, e lascia i contorni del colore scritto nel
file. Un'icona disegnata a tratto esce quindi piena e con il bordo grigio
fisso — com'era successo a tutte quelle del pannello senza che nessuno se ne
accorgesse. Per questo le -symbolic si consegnano convertite in sole forme
piene (Inkscape: oggetto in tracciato, tratto in tracciato).

Due famiglie:
- *-symbolic.svg, 16x16, per il pannello: GNOME le ricolora con il colore del
  testo forzando il riempimento di ogni forma. Per questo niente maschere —
  la ricolorazione colpirebbe anche quelle e la bocca sparirebbe — ma buchi
  nel tracciato (fill-rule evenodd). L'unico colore ammesso e' l'ambra di
  «aspetta te», con la classe `warning`, che la shell rispetta.
- *.svg a colori, per il popup e le notifiche.
"""
import re, shutil, subprocess, sys
from pathlib import Path

QUI = Path(__file__).resolve().parent
ICONE = QUI.parent / "gnome-extension" / "claude-code-watchdog@cirobox.local" / "icons"
G = "#8a8a8a"          # il ripiego delle icone del progetto, leggibile sui due fondi
AMBRA = "#B77B1A"      # attenzione, la stessa delle barre
PELLE, SCURO = "#F1C9A0", "#1b1b1b"

CAPELLI = ("M3.0 6.4 C2.8 4.3 4.1 2.8 5.8 2.3 L6.3 1.0 L7.4 1.9 L8.5 0.7 L9.1 1.9 "
           "L10.5 1.3 L10.6 2.5 C12.0 3.1 13.2 4.5 13.0 6.4 C12.0 5.4 10.3 4.9 8 4.9 "
           "C5.7 4.9 4.0 5.4 3.0 6.4Z")
BARBA = ("M3.0 9.0 C3.1 12.6 5.2 15.0 8 15.0 C10.8 15.0 12.9 12.6 13.0 9.0 "
         "C12.6 11.0 11.7 11.9 10.5 11.6 C9.6 11.3 8.7 10.8 8 11.1 "
         "C7.3 10.8 6.4 11.3 5.5 11.6 C4.3 11.9 3.4 11.0 3.0 9.0Z")

# Per ogni stato: occhi (tratti o pallini) e bocca (un buco nella barba).
STATI = {
    "dorme": ('<path d="M5.1 8.1 Q6 8.9 6.9 8.1"/><path d="M9.1 8.1 Q10 8.9 10.9 8.1"/>',
              "M6.8 12.2 H9.2 A0.5 0.5 0 0 1 9.2 13.2 H6.8 A0.5 0.5 0 0 1 6.8 12.2Z"),
    "lavora": ('<circle cx="6" cy="8.1" r="0.85" stroke="none" fill="{c}"/>'
               '<circle cx="10" cy="8.1" r="0.85" stroke="none" fill="{c}"/>',
               "M6.5 12.05 H9.5 A0.55 0.55 0 0 1 9.5 13.15 H6.5 A0.55 0.55 0 0 1 6.5 12.05Z"),
    "aspetta": ('<circle cx="6" cy="7.8" r="1" stroke="none" fill="{c}"/>'
                '<circle cx="10" cy="7.8" r="1" stroke="none" fill="{c}"/>',
                "M6.85 12.9 A1.15 1.35 0 1 0 9.15 12.9 A1.15 1.35 0 1 0 6.85 12.9Z"),
    "finito": ('<path d="M5.1 8.5 Q6 7.3 6.9 8.5"/><path d="M9.1 8.5 Q10 7.3 10.9 8.5"/>',
               "M5.9 11.9 Q8 14.6 10.1 11.9Z"),
}


def faccina(stato: str, colore: bool = False, c: str = G) -> str:
    occhi, bocca = STATI[stato]
    scuro = SCURO if colore else c
    parti = []
    if colore:
        parti.append(f'<ellipse cx="3.1" cy="8.6" rx="0.9" ry="1.2" fill="{PELLE}"/>'
                     f'<ellipse cx="12.9" cy="8.6" rx="0.9" ry="1.2" fill="{PELLE}"/>'
                     f'<ellipse cx="8" cy="8.7" rx="5.0" ry="5.8" fill="{PELLE}"/>'
                     f'<g fill="none" stroke="{SCURO}" stroke-width="0.6" stroke-linecap="round">'
                     '<path d="M4.9 6.6 Q6 6.0 7.1 6.5"/><path d="M8.9 6.5 Q10 6.0 11.1 6.6"/></g>')
    else:
        parti.append(f'<ellipse cx="8" cy="8.7" rx="5.0" ry="5.8" fill="none" '
                     f'stroke="{c}" stroke-width="1.35"/>')
    parti.append(f'<path d="{CAPELLI}" fill="{scuro}"/>')
    parti.append(f'<path d="{BARBA} {bocca}" fill="{scuro}" fill-rule="evenodd"/>')
    if colore:
        # A colori la bocca si vede: un fondo chiaro dentro il buco.
        parti.append(f'<path d="{bocca}" fill="#f7f1ea"/>')
    parti.append(f'<g fill="none" stroke="{scuro}" stroke-width="1.15" '
                 f'stroke-linecap="round">{occhi.format(c=scuro)}</g>')
    if stato == "aspetta":
        parti.append(f'<circle class="warning" cx="13.9" cy="3.0" r="1.5" fill="{AMBRA}"/>')
    return "".join(parti)


def limone(colore: bool = False, c: str = G) -> str:
    buccia = "#F3D23C" if colore else "none"
    bordo = "#B8920F" if colore else c
    tratto = SCURO if colore else c
    bianco = "#ffffff" if colore else "none"
    denti = bianco if colore else tratto
    return (f'<g transform="rotate(-12 8 8)">'
            f'<path d="M0.7 8.2 L1.9 7.6 C2.4 4.7 5.0 3.0 8.0 3.0 C11.0 3.0 13.6 4.7 14.1 7.6 '
            f'L15.3 8.2 L14.1 8.8 C13.6 11.7 11.0 13.4 8.0 13.4 C5.0 13.4 2.4 11.7 1.9 8.8 Z" '
            f'fill="{buccia}" stroke="{bordo}" stroke-width="{1.0 if colore else 1.25}" '
            f'stroke-linejoin="round"/>'
            f'<circle cx="5.9" cy="7.0" r="1.6" fill="{bianco}" stroke="{tratto}" stroke-width="0.8"/>'
            f'<circle cx="10.1" cy="7.3" r="1.8" fill="{bianco}" stroke="{tratto}" stroke-width="0.8"/>'
            f'<circle cx="5.6" cy="6.25" r="0.7" fill="{tratto}"/>'
            f'<circle cx="10.7" cy="8.0" r="0.8" fill="{tratto}"/>'
            f'<path d="M5.0 10.6 C6.4 10.0 8.8 10.9 11.2 10.2" fill="none" stroke="{tratto}" '
            f'stroke-width="0.8" stroke-linecap="round"/>'
            f'<path d="M5.9 10.35 L6.2 11.3 L6.6 10.25Z M9.9 10.45 L10.25 11.4 L10.6 10.35Z" '
            f'fill="{denti}" stroke="{tratto if colore else "none"}" stroke-width="0.25"/>'
            f'</g>')


def robot(colore: bool = False, c: str = G) -> str:
    casco = SCURO if colore else c
    corpo = "#1F6E62" if colore else "none"
    bordo = "#174f47" if colore else c
    giunti = corpo if colore else c
    parti = [
        f'<path d="M4.2 7.4 C3.8 3.9 5.6 1.6 8.2 1.6 C10.8 1.6 12.6 3.6 12.3 6.4 L12.0 7.6 Z" '
        f'fill="{casco if colore else "none"}" stroke="{casco}" '
        f'stroke-width="{0 if colore else 1.2}" stroke-linejoin="round"/>',
        f'<path d="M6.2 3.9 C8.0 3.4 10.6 3.6 11.9 4.4 L11.7 6.3 C10.2 5.9 8.0 5.9 6.4 6.3 Z" '
        f'fill="{"#5d6670" if colore else c}" stroke="{"#3a3f45" if colore else c}" '
        f'stroke-width="{0.4 if colore else 0.6}" stroke-linejoin="round"/>',
    ]
    if colore:
        parti.append('<path d="M5.0 4.6 L6.2 3.2" stroke="#CE5A50" stroke-width="0.6" '
                     'stroke-linecap="round"/>')
    parti += [
        f'<rect x="5.3" y="8.3" width="5.8" height="5.2" rx="1.4" fill="{corpo}" '
        f'stroke="{bordo}" stroke-width="1.1"/>',
        f'<circle cx="8.2" cy="10.9" r="1.3" fill="none" '
        f'stroke="{"#0f3d37" if colore else bordo}" stroke-width="0.8"/>',
        f'<path d="M5.3 9.8 L3.0 11.6 M11.1 9.8 L13.4 11.6 M7.0 13.5 V14.9 M9.4 13.5 V14.9" '
        f'stroke="{bordo}" stroke-width="1.1" stroke-linecap="round"/>',
        f'<circle cx="2.8" cy="11.8" r="0.8" fill="{giunti}"/>',
        f'<circle cx="13.6" cy="11.8" r="0.8" fill="{giunti}"/>',
    ]
    return "".join(parti)


# I segni che lampeggiano sopra la mascotte. Sostituiscono il respiro del
# disco: una cosa che respira sempre non attira l'attenzione piu' di una
# ferma, mentre un segno che compare solo quando serve si vede.
ROSSO = "#CE5A50"      # gia' usato per la spia del robottino
GIALLO = "#F3D23C"     # la buccia del limone


def _interrogativo(cx: float, cy: float, s: float, c: str) -> str:
    """Un punto interrogativo centrato in (cx, cy), in unita' locali."""
    return (f'<g transform="translate({cx} {cy}) scale({s})">'
            f'<path d="M-1.45 -1.2 A1.5 1.5 0 1 1 0.15 0.5 L0.15 1.3" fill="none" '
            f'stroke="{c}" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>'
            f'<circle cx="0.15" cy="2.5" r="0.68" fill="{c}"/></g>')


def _esclamativo(cx: float, cy: float, s: float, c: str) -> str:
    return (f'<g transform="translate({cx} {cy}) scale({s})">'
            f'<path d="M0 -1.7 L0 0.9" fill="none" stroke="{c}" stroke-width="1.1" '
            f'stroke-linecap="round"/>'
            f'<circle cx="0" cy="2.5" r="0.68" fill="{c}"/></g>')


def segno(tipo: str, colore: bool = False, c: str = G) -> str:
    """Il segno di uno stato: due interrogativi, due esclamativi, o la
    lampadina. Due e non uno perche' uno solo, piccolo, si legge come un
    graffio sullo schermo; due dicono «sta chiedendo»."""
    if tipo == "domanda":
        t = AMBRA if colore else c
        return _interrogativo(9.4, 7.2, 1.9, t) + _interrogativo(4.3, 5.4, 1.2, t)
    if tipo == "errore":
        t = ROSSO if colore else c
        return _esclamativo(9.6, 7.2, 1.9, t) + _esclamativo(4.6, 5.4, 1.2, t)
    if tipo == "lampadina":
        vetro = GIALLO if colore else "none"
        bordo = "#B8920F" if colore else c
        tratto = SCURO if colore else c
        return (f'<path d="M3.4 11.2 L2.0 11.9 M12.6 11.2 L14.0 11.9 '
                f'M8 1.4 V0.2 M4.0 3.1 L3.0 2.2 M12.0 3.1 L13.0 2.2" fill="none" '
                f'stroke="{bordo}" stroke-width="1.0" stroke-linecap="round"/>'
                f'<path d="M8 1.9 C5.2 1.9 3.3 3.9 3.3 6.3 C3.3 8.2 4.6 9.3 5.3 10.4 '
                f'L10.7 10.4 C11.4 9.3 12.7 8.2 12.7 6.3 C12.7 3.9 10.8 1.9 8 1.9Z" '
                f'fill="{vetro}" stroke="{bordo}" stroke-width="1.2" stroke-linejoin="round"/>'
                f'<path d="M5.6 11.6 H10.4 M6.1 13.4 H9.9" fill="none" stroke="{tratto}" '
                f'stroke-width="1.3" stroke-linecap="round"/>'
                f'<path d="M6.6 10.4 L7.3 7.3 L8.7 8.6 L9.4 10.4" fill="none" '
                f'stroke="{tratto}" stroke-width="0.8" stroke-linejoin="round" '
                f'stroke-linecap="round"/>')
    raise KeyError(tipo)


def svg(corpo: str, lato: int = 16) -> str:
    return ('<?xml version="1.0" encoding="UTF-8"?>\n'
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{lato}" height="{lato}" '
            f'viewBox="0 0 16 16">{corpo}</svg>\n')


def tutte() -> dict[str, str]:
    """Nome file → contenuto, per tutte le icone della mascotte."""
    out = {}
    for s in STATI:
        out[f"fw-faccina-{s}-symbolic.svg"] = svg(faccina(s))
        out[f"fw-faccina-{s}.svg"] = svg(faccina(s, colore=True), 64)
    out["fw-limone-symbolic.svg"] = svg(limone())
    out["fw-limone.svg"] = svg(limone(colore=True), 64)
    out["fw-robot-symbolic.svg"] = svg(robot())
    out["fw-robot.svg"] = svg(robot(colore=True), 64)
    for s in ("domanda", "errore", "lampadina"):
        out[f"fw-segno-{s}-symbolic.svg"] = svg(segno(s))
        out[f"fw-segno-{s}.svg"] = svg(segno(s, colore=True), 64)
    return out


def anteprima() -> str:
    """Un foglio per guardarle tutte: grandi, a dimensione reale, a colori."""
    W, H = 1100, 620
    t = lambda x, y, s, size=16, col="#222", peso="normal": (
        f'<text x="{x}" y="{y}" font-family="Cantarell, sans-serif" '
        f'font-size="{size}" fill="{col}" font-weight="{peso}">{s}</text>')
    p = [f'<rect width="{W}" height="{H}" fill="#fff"/>',
         t(30, 40, "Watchface — la mascotte e le comparse", 24, peso="bold")]
    voci = [("dorme", "nessuna sessione"), ("lavora", "Claude lavora"),
            ("aspetta", "aspetta te"), ("finito", "ha finito"),
            ("limone", "qualcosa è storto"), ("robot", "un aiutante")]
    for i, (k, nome) in enumerate(voci):
        x = 30 + i * 178
        disegna = (lambda col=False, c=G: limone(col, c)) if k == "limone" else \
                  (lambda col=False, c=G: robot(col, c)) if k == "robot" else \
                  (lambda col=False, c=G, k=k: faccina(k, col, c))
        p.append(t(x, 80, nome, 16, peso="bold"))
        p.append(f'<rect x="{x}" y="95" width="160" height="160" rx="12" fill="#f4f4f4"/>')
        p.append(f'<g transform="translate({x + 8},103) scale(9)">{disegna()}</g>')
        for j, (fondo, colore) in enumerate((("#ebebeb", "#2e2e2e"), ("#1e1e1e", "#f0f0f0"))):
            p.append(f'<rect x="{x + j * 80}" y="270" width="76" height="34" rx="6" fill="{fondo}"/>')
            p.append(f'<g transform="translate({x + j * 80 + 14},279)">{disegna(c=colore)}</g>')
            p.append(f'<g transform="translate({x + j * 80 + 40},275) scale(1.5)">{disegna(c=colore)}</g>')
        p.append(f'<g transform="translate({x + 16},330) scale(8)">{disegna(True)}</g>')
        p.append(f'<g transform="translate({x + 16},480) scale(2)">{disegna(True)}</g>')
        p.append(f'<g transform="translate({x + 60},484) scale(1.5)">{disegna(True)}</g>')
    p.append(t(30, 590, "per ognuna: ingrandita · nel pannello chiaro e scuro (16 e 24 px) · "
                        "a colori grande · a colori piccola (32 e 24 px)", 14, "#666"))
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
            f'viewBox="0 0 {W} {H}">{"".join(p)}</svg>')


SORGENTI = QUI / "sorgenti"


def a_forme_piene(sorgente: Path, dest: Path) -> None:
    """Ogni tratto diventa una forma piena, cosi' la ricolorazione lo prende.

    Senza inkscape non si converte, e non si finge di averlo fatto: un'icona
    gia' in posto resta quella di prima (l'ha convertita chi lo strumento ce
    l'aveva), una nuova si scrive com'e'. Un tratto non convertito tiene il
    grigio di ripiego invece di prendere il colore del tema — si vede, ma si
    legge su tutti e due i fondi, ed e' meglio di un'icona che sparisce.
    Serve perche' questo progetto gira anche dove inkscape non c'e'.
    """
    if shutil.which("inkscape") is None:
        if dest.exists():
            print(f"  inkscape assente: {dest.name} resta la versione gia' convertita")
        else:
            dest.write_text(sorgente.read_text())
            print(f"  inkscape assente: {dest.name} scritta senza conversione dei tratti")
        return
    r = subprocess.run(
        ["inkscape", str(sorgente),
         "--actions=select-all:all;object-to-path;select-all:all;object-stroke-to-path",
         "--export-plain-svg", f"--export-filename={dest}"],
        capture_output=True, text=True, timeout=60)
    testo = dest.read_text() if dest.exists() else ""
    if r.returncode != 0 or "<path" not in testo:
        raise SystemExit(f"conversione fallita per {sorgente.name}: {r.stderr.strip()}")
    # I gruppi conservano gli attributi di tratto dei figli convertiti:
    # innocui, ma un figlio che li ereditasse avrebbe un bordo che non cambia
    # colore. Si tolgono, e poi non deve restarne nessuno.
    testo = re.sub(r'(<g\b[^>]*?)\s(?:stroke(?:-[a-z]+)?|fill)="[^"]*"',
                   lambda m: m.group(1), testo)
    while re.search(r'<g\b[^>]*\s(?:stroke(?:-[a-z]+)?|fill)="', testo):
        testo = re.sub(r'(<g\b[^>]*?)\s(?:stroke(?:-[a-z]+)?|fill)="[^"]*"',
                       lambda m: m.group(1), testo)
    if re.search(r'stroke="#|stroke:#', testo):
        raise SystemExit(f"{sorgente.name}: e' rimasto un tratto dopo la conversione")
    dest.write_text(testo)


def banner() -> str:
    """La testata del README: la mascotte nei suoi stati, il nome, una riga.

    Testo in SVG e non in un'immagine raster: resta nitido su ogni schermo, e
    GitHub lo mostra come qualunque altra immagine.
    """
    W, H = 1280, 400
    font = "Cantarell, 'Inter', 'Segoe UI', Helvetica, Arial, sans-serif"
    p = [f'''<defs>
  <linearGradient id="fondo" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#16233a"/><stop offset="1" stop-color="#1F4E5A"/>
  </linearGradient>
  <radialGradient id="luce" cx="0.28" cy="0.45" r="0.5">
    <stop offset="0" stop-color="#2F9284" stop-opacity="0.45"/>
    <stop offset="1" stop-color="#2F9284" stop-opacity="0"/>
  </radialGradient>
</defs>
<rect width="{W}" height="{H}" rx="28" fill="url(#fondo)"/>
<rect width="{W}" height="{H}" rx="28" fill="url(#luce)"/>''']
    # La faccina grande al centro della scena, le comparse ai lati.
    p.append(f'<g transform="translate(120,70) scale(16)">{faccina("finito", True)}</g>')
    # Un alone chiaro dietro le comparse: il casco del robottino e il bordo
    # del limone sono scuri, e sul fondo blu notte si perdevano.
    for cx, cy, r in ((96, 300, 62), (430, 296, 66)):
        p.append(f'<circle cx="{cx}" cy="{cy}" r="{r}" fill="#ffffff" fill-opacity="0.13"/>')
    p.append(f'<g transform="translate(44,248) scale(6.5)">{limone(True)}</g>')
    p.append(f'<g transform="translate(374,240) scale(7)">{robot(True)}</g>')
    # Gli stati, in fila, come li vedi nella barra.
    for i, st in enumerate(("dorme", "lavora", "aspetta", "finito")):
        x = 540 + i * 74
        p.append(f'<rect x="{x}" y="270" width="58" height="58" rx="14" fill="#ffffff" fill-opacity="0.08"/>')
        p.append(f'<g transform="translate({x + 9},279) scale(2.5)">{faccina(st, True)}</g>')
    p.append(f'<text x="538" y="150" font-family="{font}" font-size="56" font-weight="800" '
             f'fill="#ffffff">Claude Code Watchdog</text>')
    p.append(f'<text x="540" y="198" font-family="{font}" font-size="23" fill="#cfe6e2">'
             f'Disco, quota e progetti di Claude Code nella barra di GNOME,</text>')
    p.append(f'<text x="540" y="230" font-family="{font}" font-size="23" fill="#cfe6e2">'
             f'e una faccina che ti dice cosa sta facendo Claude adesso.</text>')
    p.append(f'<text x="842" y="306" font-family="{font}" font-size="19" fill="#9fc3bd">'
             f'dorme · lavora · aspetta te · ha finito</text>')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" '
            f'viewBox="0 0 {W} {H}">{"".join(p)}</svg>\n')


def main() -> int:
    SORGENTI.mkdir(parents=True, exist_ok=True)
    ICONE.mkdir(parents=True, exist_ok=True)
    for nome, contenuto in tutte().items():
        (SORGENTI / nome).write_text(contenuto)
    n = 0
    for f in sorted(SORGENTI.glob("*.svg")):
        if f.name.endswith("-symbolic.svg"):
            a_forme_piene(f, ICONE / f.name)
        else:
            (ICONE / f.name).write_text(f.read_text())
        n += 1
    print(f"{n} icone in {ICONE}")
    (QUI / "banner.svg").write_text(banner())
    if "--anteprima" in sys.argv:
        f = QUI / "anteprima.svg"
        f.write_text(anteprima())
        try:
            subprocess.run(["inkscape", str(f), "--export-type=png",
                            f"--export-filename={f.with_suffix('.png')}", "-w", "1100"],
                           capture_output=True, timeout=60)
            print(f"anteprima in {f.with_suffix('.png')}")
        except (OSError, subprocess.SubprocessError):
            print(f"anteprima in {f} (inkscape non disponibile per il png)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
