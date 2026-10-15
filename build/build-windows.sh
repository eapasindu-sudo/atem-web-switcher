#!/bin/bash
# Builds dist/ATEM-Switcher.exe (Node single executable) and dist/ATEM-Switcher-Setup.exe (NSIS installer).
# Needs: Node 22, makensis (apt install nsis), python3. Run from the repo root after `npm install`.
set -euo pipefail
NODE_VER=v22.22.0
mkdir -p dist && cd dist
for f in app admin; do cp ../public/$f.js ../public/$f.js.txt; done
cp ../public/manifest.json ../public/manifest.json.txt
npx --yes esbuild@0.24 ../build/exe-entry.js --bundle --platform=node --target=node22 \
  --loader:.html=text --loader:.css=text --loader:.txt=text --loader:.png=binary \
  --alias:@julusian/freetype2=../build/stub/freetype2.js --alias:threadedclass=../build/stub/threadedclass.js \
  --outfile=bundle.js
rm ../public/*.txt
echo '{"main":"bundle.js","output":"sea-prep.blob","disableExperimentalSEAWarning":true,"useCodeCache":false,"useSnapshot":false}' > sea-config.json
node --experimental-sea-config sea-config.json
[ -f node.exe ] || { curl -sSfLO https://nodejs.org/dist/$NODE_VER/node-$NODE_VER-win-x64.zip && unzip -qj node-$NODE_VER-win-x64.zip "*/node.exe"; }
cp node.exe ATEM-Switcher.exe
npx --yes postject@1.0.0-alpha.6 ATEM-Switcher.exe NODE_SEA_BLOB sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
python3 ../build/set-gui-subsystem.py ATEM-Switcher.exe
cp ../build/installer.nsi . && makensis -V2 installer.nsi
echo "Built dist/ATEM-Switcher-Setup.exe"
