#!/usr/bin/env python3
"""Allinea il campo `cwd` delle trascrizioni alla cartella in cui si trovano.

    fix-cwd.py                elenca i disallineamenti
    fix-cwd.py --json         per l'estensione
    fix-cwd.py --apply        corregge

Claude Code archivia ogni trascrizione in una cartella di ~/.claude/projects/
il cui nome deriva dalla cwd della sessione. Quando un progetto viene spostato,
può succedere che il file finisca nella cartella del percorso nuovo ma conservi
dentro di sé la cwd vecchia: da fuori sembra appartenere ancora al vecchio
posto, e gli inventari lo classificano lì.

Qui non si sposta niente: il file è già dove deve stare. Si riscrive solo il
campo `cwd`, tenendo una copia dell'originale nel cestino.

La cartella non si «decodifica» — la codifica non è invertibile. Si fa il
contrario: si codificano le cartelle che esistono davvero sul disco e si cerca
quella che produce esattamente quel nome.
"""
import json, os, re, shutil, subprocess, sys, tempfile, argparse
from pathlib import Path

HOME = Path.home()
PROJECTS = HOME / ".claude" / "projects"


def codifica(percorso) -> str:
    return re.sub(r"[^A-Za-z0-9-]", "-", str(percorso))


def mappa_cartelle(profondita: int = 2) -> dict[str, str]:
    """Nome codificato → percorso reale, per le cartelle plausibili."""
    radici = [HOME, HOME / "Documenti", Path("/tmp")]
    # la radice dei progetti, se il watchdog sa dov'è
    try:
        dati = json.loads((Path(os.environ.get("XDG_DATA_HOME", HOME / ".local/share"))
                           / "fedora-watchdog" / "metrics.json").read_text())
        if dati.get("progetto"):
            radici.append(Path(dati["progetto"]).parent)
    except Exception:
        pass

    mappa: dict[str, str] = {}
    # Si ricorda a CHE profondità residua una cartella è stata visitata: se la
    # si reincontra come radice con più margine bisogna riscenderci, altrimenti
    # una cartella toccata di sfuggita blocca l'esplorazione dei suoi figli.
    visti: dict[str, int] = {}

    def aggiungi(d: Path, giu: int):
        if not d.is_dir():
            return
        chiave = str(d)
        if visti.get(chiave, -1) >= giu:
            return
        visti[chiave] = giu
        mappa.setdefault(codifica(d), chiave)
        if giu <= 0:
            return
        try:
            for f in d.iterdir():
                if f.is_dir() and not f.name.startswith("."):
                    aggiungi(f, giu - 1)
        except OSError:
            pass

    for r in radici:
        aggiungi(r, profondita)
    return mappa


def cwd_del_file(f: Path) -> str | None:
    try:
        for riga in f.open("rb"):
            try:
                d = json.loads(riga)
            except Exception:
                continue
            if isinstance(d, dict) and d.get("cwd"):
                return d["cwd"]
    except OSError:
        pass
    return None


def prove(f: Path, vecchia: str, nuova: str) -> tuple[int, int]:
    """(file citati che esistono nella cartella nuova, citati in tutto)."""
    rx = re.compile(re.escape(vecchia) + r"/[\w./-]+")
    citati = set()
    try:
        for riga in f.open("rb"):
            for m in rx.findall(riga.decode("utf-8", "replace")):
                rel = m[len(vecchia) + 1:].rstrip("./")
                if len(rel) > 2 and "." in Path(rel).name:
                    citati.add(rel)
    except OSError:
        pass
    trovati = sum(1 for r in citati if (Path(nuova) / r).exists())
    return trovati, len(citati)


def citata_nel_readme(sessione: str, cartella: str) -> bool:
    """Vero se un README dentro la cartella candidata nomina questa sessione.

    È la prova più forte disponibile: qualcuno ha documentato a mano quale
    conversazione appartiene a quale progetto. Batte il confronto sui file
    citati, che qui fallisce perché quei file di lavoro sono andati persi
    insieme a /tmp.
    """
    d = Path(cartella)
    if not d.is_dir():
        return False
    for nome in ("README.md", "readme.md", "STATO_LAVORO.md"):
        f = d / nome
        if not f.is_file():
            continue
        try:
            if sessione in f.read_text(errors="replace"):
                return True
        except OSError:
            continue
    return False


def analizza() -> list[dict]:
    mappa = mappa_cartelle()
    fuori = []
    if not PROJECTS.is_dir():
        return fuori
    for d in sorted(PROJECTS.iterdir()):
        if not d.is_dir():
            continue
        vero = mappa.get(d.name)
        if not vero:
            continue                      # non si sa a che percorso corrisponda
        for f in sorted(d.glob("*.jsonl")):
            cwd = cwd_del_file(f)
            if not cwd or cwd == vero:
                continue                  # già allineato, o file di soli metadati
            if codifica(cwd) == d.name:
                continue                  # coerente: la cartella deriva da questa cwd
            t, c = prove(f, cwd, vero)
            documentata = citata_nel_readme(f.stem, vero)
            fuori.append({
                "file": str(f), "cartella": d.name,
                "sessione": f.stem,
                "cwdAttuale": cwd, "cwdCorretta": vero,
                "cwdAttualeEsiste": Path(cwd).is_dir(),
                "fileRitrovati": t, "fileCitati": c,
                "documentata": documentata,
                "byte": f.stat().st_size,
            })
    return fuori


def correggi(v: dict) -> str | None:
    """Riscrive la cwd. Ritorna il messaggio d'errore, o None se è andata."""
    f = Path(v["file"])
    try:
        righe = []
        cambiate = 0
        for riga in f.open("rb"):
            try:
                d = json.loads(riga)
            except Exception:
                righe.append(riga.decode("utf-8", "replace").rstrip("\n"))
                continue
            if isinstance(d, dict) and d.get("cwd") == v["cwdAttuale"]:
                d["cwd"] = v["cwdCorretta"]
                cambiate += 1
            righe.append(json.dumps(d, ensure_ascii=False))
        if not cambiate:
            return "nessuna riga da cambiare"

        # Copia di sicurezza nel cestino PRIMA di toccare l'originale: il file
        # resta al suo posto, quindi non basta spostarlo come fanno gli altri
        # strumenti.
        # La copia va creata sul filesystem della home, NON in /tmp: lì è un
        # filesystem in memoria e `gio trash` rifiuta con «spostamento nel
        # cestino sui montaggi interni di sistema non supportato».
        appoggio = Path.home() / ".cache" / "fedora-watchdog"
        appoggio.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=appoggio) as tmp:
            copia = Path(tmp) / f.name
            shutil.copy2(f, copia)
            r = subprocess.run(["gio", "trash", str(copia)],
                               capture_output=True, text=True, timeout=30)
            if r.returncode != 0:
                return f"copia di sicurezza fallita: {(r.stderr or '').strip()}"

        f.write_text("\n".join(righe) + "\n")
        return None
    except (OSError, subprocess.SubprocessError) as e:
        return str(e)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    voci = analizza()

    if args.apply:
        errori = []
        for v in voci:
            e = correggi(v)
            if e:
                errori.append(f"{Path(v['file']).name}: {e}")
        if args.json:
            json.dump({"voci": voci, "errori": errori, "eseguito": True},
                      sys.stdout, ensure_ascii=False)
            print()
        else:
            print(f"Corrette {len(voci)-len(errori)} trascrizioni su {len(voci)}.")
            for e in errori:
                print(f"  ⚠️ {e}")
            if len(voci) > len(errori):
                print("\nLe copie originali sono nel cestino.")
        return 1 if errori else 0

    if args.json:
        json.dump({"voci": voci, "eseguito": False}, sys.stdout, ensure_ascii=False)
        print()
        return 0

    if not voci:
        print("Nessun disallineamento: ogni trascrizione dichiara la cartella in cui sta.")
        return 0

    print(f"{len(voci)} trascrizioni dichiarano una cwd diversa dalla cartella "
          f"in cui sono archiviate.\n")
    for v in voci:
        stato = "esiste ancora" if v["cwdAttualeEsiste"] else "non esiste più"
        if v["documentata"]:
            prova = "il README del progetto nomina questa sessione"
        elif v["fileCitati"]:
            prova = f"{v['fileRitrovati']}/{v['fileCitati']} file citati ritrovati"
        else:
            prova = "nessuna prova indipendente"
        print(f"  {Path(v['file']).name[:8]}  {v['byte']/1048576:>5.1f} MB")
        print(f"      dichiara: {v['cwdAttuale']}  ({stato})")
        print(f"      archiviata in una cartella che significa: {v['cwdCorretta']}")
        print(f"      prove: {prova}")
    print("\nPer correggere: fix-cwd.py --apply")
    print("Una copia di ogni originale finisce nel cestino.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
