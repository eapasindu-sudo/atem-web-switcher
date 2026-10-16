#!/bin/sh
# Builds sony-bridge against the pretend SDK (Linux). Needs the Sony SDK headers:
#   SONY_SDK=/path/to/sdk build/sony-bridge/mock/build-mock.sh
set -e
here=$(cd "$(dirname "$0")/.." && pwd)
inc="${SONY_SDK:?set SONY_SDK to the Sony SDK folder}/app/CRSDK"
out="${OUT:-$here/mock/sony-bridge-mock}"
g++ -std=c++17 -O1 -w -I"$inc" "$here/sony_bridge.cpp" "$here/mock/mock_sdk.cpp" -o "$out" -lpthread
echo "built $out"
