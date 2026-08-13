#!/bin/bash
# Sincroniza el playbook: toma el export HTML de docs/playbook_html/ y el PDF
# de docs/playbook_btc_smith.pdf, los copia a public/playbook/ (lo que sirve
# el sitio) y deja el commit listo. No pushea solo: eso lo confirma quien
# corre el script.
#
# Uso: cuando haya una versión nueva del playbook, sobreescribí los mismos
# archivos en docs/playbook_html/ (el export completo: "Estrategia BTC
# Playbook.dc.html", doc-page.js, support.js, uploads/) y el PDF en
# docs/playbook_btc_smith.pdf, después corré:
#   npm run sync-playbook
set -euo pipefail
cd "$(dirname "$0")/../.."

SRC_HTML="docs/playbook_html/Estrategia BTC Playbook.dc.html"
SRC_UPLOADS="docs/playbook_html/uploads/"
SRC_PDF="docs/playbook_btc_smith.pdf"

DST_HTML="public/playbook/estrategia-btc-playbook.html"
DST_UPLOADS="public/playbook/uploads/"
DST_PDF="public/playbook/playbook_btc_smith.pdf"

for f in "$SRC_HTML" "$SRC_PDF"; do
  [ -f "$f" ] || { echo "Falta $f, no hay nada para sincronizar." >&2; exit 1; }
done

cp "$SRC_HTML" "$DST_HTML"
rsync -a "$SRC_UPLOADS" "$DST_UPLOADS"
cp "$SRC_PDF" "$DST_PDF"

git add "$SRC_HTML" "$SRC_UPLOADS" "$SRC_PDF" "$DST_HTML" "$DST_UPLOADS" "$DST_PDF"

if git diff --cached --quiet; then
  echo "Sin cambios: el playbook ya está al día."
  exit 0
fi

git commit -m "Playbook: sync desde docs/playbook_html"
echo
echo "Commit listo. Para publicar: git push origin main"
