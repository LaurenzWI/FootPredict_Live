#!/bin/sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo 'Bitte zuerst Node.js 18+ installieren: https://nodejs.org/'
  exit 1
fi
printf 'Browser-Adresse: http://localhost:3000\n'
exec node server.js
