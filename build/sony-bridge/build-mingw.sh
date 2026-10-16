#!/bin/bash
# Builds dist/sony/ (sony-bridge.exe + the Sony SDK DLLs) on Linux with MinGW.
#   SONY_SDK=/path/to/RemoteCli build/sony-bridge/build-mingw.sh
# SONY_SDK is the unzipped RemoteCli folder from the Sony Camera Remote SDK (has app/CRSDK and external/crsdk).
# The SDK itself is not in this repository. Needs: apt install g++-mingw-w64-x86-64
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
sdk="${SONY_SDK:?set SONY_SDK to the Sony SDK RemoteCli folder}"
out="$here/../../dist/sony"
rm -rf "$out" && mkdir -p "$out"
x86_64-w64-mingw32-g++ -std=c++17 -O2 -w -DUNICODE -D_UNICODE -I"$sdk/app/CRSDK" "$here/sony_bridge.cpp" \
  -o "$out/sony-bridge.exe" -L"$sdk/external/crsdk" -lCr_Core -static -static-libgcc -static-libstdc++
x86_64-w64-mingw32-strip "$out/sony-bridge.exe"
cp -r "$sdk/external/crsdk/." "$out/"
rm -f "$out"/*.lib
cat > "$out/THIRD-PARTY.txt" <<'TXT'
This folder contains the Sony Camera Remote SDK runtime files (Cr_Core.dll, CrAdapter, monitor_protocol),
distributed under the Sony Camera Remote SDK license: http://www.sony.net/CameraRemoteSDK/

CrAdapter/libusb-1.0.dll is libusb, licensed under the GNU LGPL 2.1. Source code: https://libusb.info/
CrAdapter/libssh2.dll is libssh2, BSD license: https://libssh2.org/
TXT
echo "Built $out"
