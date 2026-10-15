#!/bin/bash
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Node.js is not installed. Download it from https://nodejs.org"; read -p "Press Enter"; exit 1; }
[ -d node_modules ] || npm install
node server.js
