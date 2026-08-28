#!/bin/bash
# Sincroniza el playbook: toma el export HTML standalone (self-contained, sin
# carpeta uploads/ ni doc-page.js/support.js separados) y el PDF desde docs/,
# los copia a public/playbook/ (lo que sirve el sitio) y deja el commit listo.
# No pushea solo: eso lo confirma quien corre el script.
#
# Uso: cuando haya una versión nueva del playbook, exportá de nuevo en modo
# standalone y sobreescribí estos dos archivos en docs/ (mismos nombres):
#   docs/Estrategia BTC Playbook (standalone).html
#   docs/playbook_btc_smith.pdf
# después corré:
#   npm run sync-playbook
set -euo pipefail
cd "$(dirname "$0")/../.."

SRC_HTML="docs/Estrategia BTC Playbook (standalone).html"
SRC_PDF="docs/playbook_btc_smith.pdf"

DST_HTML="public/playbook/estrategia-btc-playbook.html"
DST_PDF="public/playbook/playbook_btc_smith.pdf"

for f in "$SRC_HTML" "$SRC_PDF"; do
  [ -f "$f" ] || { echo "Falta $f, no hay nada para sincronizar." >&2; exit 1; }
done

cp "$SRC_HTML" "$DST_HTML"
cp "$SRC_PDF" "$DST_PDF"

git add "$DST_HTML" "$DST_PDF"

if git diff --cached --quiet -- "$DST_HTML" "$DST_PDF"; then
  echo "Sin cambios: el playbook ya está al día."
  exit 0
fi

git commit -m "Playbook: sync desde docs/ (standalone)"
echo
echo "Commit listo. Para publicar: git push origin main"
