#!/usr/bin/env bash
# Assemble dist/: the landing page at the root, the app under /app/.
set -euo pipefail
cd "$(dirname "$0")"
rm -rf dist
npm --prefix ../landing run build
if [ "${APP_PLACEHOLDER:-}" = 1 ]; then
  # Pre-launch: /app/ shows a short notice until the contracts and API are live.
  mkdir -p dist/app
  cat > dist/app/index.html <<'HTML'
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>StratosNotes app · launching soon</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#050b0a;color:#e9f3ef;font:16px/1.6 system-ui,sans-serif;padding:24px}
main{max-width:34rem}h1{font-size:1.6rem;margin:0 0 .5rem}p{color:#b4c7c0}a{color:#2dd4bf}</style></head>
<body><main><h1>The app is launching soon</h1>
<p>StratosNotes is being deployed to Arbitrum Sepolia and Robinhood Chain testnet. Until then, try the note explorer to see what each note does for issuers and investors.</p>
<p><a href="/#explore">Open the note explorer</a></p></main></body></html>
HTML
else
  (cd ../app && VITE_BASE=/app/ npx vite build --outDir ../web/dist/app --emptyOutDir)
fi
cp -r ../landing/dist/. dist/
echo "dist/: landing at /, app at /app/"
