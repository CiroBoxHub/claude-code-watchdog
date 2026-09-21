#!/usr/bin/env python3
"""Mette in coda un percorso perché il pannello lo mostri fra le cose da
liberare.

Serve ai casi una tantum: roba che nessuna categoria conosce, trovata
guardando. Una cartella dati rimasta da una rinomina, un export dimenticato,
lo scarto di un esperimento. Il pannello non ha un campo dove digitare un
percorso — mostra soltanto quello che è già in coda, con nome e peso, e lo
cestina dopo che l'hai spuntato.

    segnala.py ~/.local/share/roba-vecchia  --motivo "residuo della rinomina"
    segnala.py --elenco                     # cosa c'è in coda
    segnala.py --togli ~/.local/share/roba-vecchia

Segnalare non cancella niente: scrive una riga in un file.
"""
import argparse, json, sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
# I controlli stanno in reclaim.py, che è anche chi cancella: due copie della
# stessa regola sono due copie che divergono, e qui divergere vorrebbe dire
# accettare in coda qualcosa che poi verrebbe rifiutato — o peggio il contrario.
import reclaim


def carica() -> list[dict]:
    """Le righe della coda così come stanno, senza filtrarle."""
    if not reclaim.SEGNALATI.is_file():
        return []
    out = []
    for riga in reclaim.SEGNALATI.read_text().splitlines():
        riga = riga.strip()
        if not riga:
            continue
        try:
            out.append(json.loads(riga))
        except ValueError:
            continue
    return out


def salva(voci: list[dict]) -> None:
    d = reclaim.SEGNALATI.parent
    d.mkdir(parents=True, exist_ok=True)
    d.chmod(0o700)
    reclaim.SEGNALATI.write_text(
        "".join(json.dumps(v, ensure_ascii=False) + "\n" for v in voci))
    # Un percorso può dire di chi è il progetto, quindi di chi è il cliente.
    reclaim.SEGNALATI.chmod(0o600)


def peso_leggibile(p: Path) -> str:
    mb = reclaim.peso([p]) / 1048576
    return f"{mb:.1f} MB" if mb >= 0.1 else "meno di 0,1 MB"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("percorso", nargs="?", help="cartella o file da segnalare")
    ap.add_argument("--motivo", default="", help="perché si può togliere")
    ap.add_argument("--elenco", action="store_true", help="mostra la coda")
    ap.add_argument("--togli", metavar="PERCORSO", help="toglie una voce dalla coda")
    ap.add_argument("--json", action="store_true", help="output per l'estensione")
    a = ap.parse_args()

    if a.elenco:
        voci = reclaim.segnalati()
        if a.json:
            print(json.dumps([{**v, "percorso": str(v["percorso"])} for v in voci],
                             ensure_ascii=False))
            return 0
        if not voci:
            print("  la coda è vuota")
            return 0
        for v in voci:
            print(f"  {peso_leggibile(v['percorso']):>14}  {v['percorso']}")
            if v["motivo"]:
                print(f"                  {v['motivo']}")
        return 0

    if a.togli:
        obiettivo = str(Path(a.togli).expanduser().resolve())
        rimaste = [v for v in carica() if v.get("percorso") != obiettivo]
        if len(rimaste) == len(carica()):
            print(f"non era in coda: {obiettivo}", file=sys.stderr)
            return 1
        salva(rimaste)
        print(f"  tolto dalla coda: {obiettivo}")
        return 0

    if not a.percorso:
        ap.print_help()
        return 2

    p = Path(a.percorso).expanduser()
    if not p.exists():
        print(f"non esiste: {p}", file=sys.stderr)
        return 1
    p = p.resolve()

    motivo_rifiuto = reclaim.ammissibile(p)
    if motivo_rifiuto:
        print(f"non si può segnalare {p}:\n  {motivo_rifiuto}", file=sys.stderr)
        return 1

    voci = carica()
    if any(v.get("percorso") == str(p) for v in voci):
        print(f"  già in coda: {p}")
        return 0

    voci.append({"percorso": str(p), "nome": p.name, "motivo": a.motivo,
                 "aggiuntoIl": datetime.now(timezone.utc).isoformat(timespec="seconds")})
    salva(voci)
    print(f"  in coda: {p}  ({peso_leggibile(p)})")
    print("  comparirà nel pannello alla prossima raccolta. Niente è stato "
          "cancellato.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
