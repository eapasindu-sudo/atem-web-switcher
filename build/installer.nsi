; ATEM Switcher Windows installer (build with makensis)
Unicode true
!include "MUI2.nsh"

!define APPNAME "ATEM Switcher"
!define EXE "ATEM-Switcher.exe"
!define VERSION "1.4.0"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\ATEMSwitcher"

Name "${APPNAME}"
OutFile "ATEM-Switcher-Setup.exe"
InstallDir "$PROGRAMFILES64\${APPNAME}"
RequestExecutionLevel admin
SetCompressor /SOLID lzma

!define MUI_FINISHPAGE_RUN "$INSTDIR\${EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Start ATEM Switcher now"
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APPNAME}"
VIAddVersionKey "FileDescription" "${APPNAME} installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"

Section "Install"
  ; stop a running copy so the file can be replaced
  nsExec::Exec 'taskkill /F /IM ${EXE}'
  nsExec::Exec 'taskkill /F /IM sony-bridge.exe'
  SetOutPath "$INSTDIR"
  File "${EXE}"
!if /FileExists "sony\sony-bridge.exe"
  ; Sony camera control (CCU): bridge + Sony Camera Remote SDK files
  SetOutPath "$INSTDIR\sony"
  File /r "sony\*"
  SetOutPath "$INSTDIR"
  ; the Sony SDK needs the Microsoft Visual C++ runtime; fetch it once if this PC doesn't have it
  ReadRegDWORD $0 HKLM "SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\X64" "Installed"
  StrCmp $0 "1" vcDone
  DetailPrint "Downloading Microsoft Visual C++ runtime for Sony camera control..."
  nsExec::Exec 'curl.exe -sSfL -o "$TEMP\vc_redist.x64.exe" https://aka.ms/vs/17/release/vc_redist.x64.exe'
  Pop $1
  StrCmp $1 "0" 0 vcDone
  ExecWait '"$TEMP\vc_redist.x64.exe" /install /quiet /norestart'
  Delete "$TEMP\vc_redist.x64.exe"
  vcDone:
!endif
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk" "$INSTDIR\${EXE}"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\Uninstall ${APPNAME}.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\${EXE}"

  ; let phones on the network reach the switcher page (port 3000)
  nsExec::Exec 'netsh advfirewall firewall delete rule name="${APPNAME}"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="${APPNAME}" dir=in action=allow program="$INSTDIR\${EXE}" enable=yes profile=any'
  ; Sony cameras answer the camera search over the network
  nsExec::Exec 'netsh advfirewall firewall delete rule name="${APPNAME} Sony"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="${APPNAME} Sony" dir=in action=allow program="$INSTDIR\sony\sony-bridge.exe" enable=yes profile=any'

  WriteRegStr HKLM "${UNINST_KEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKLM "${UNINST_KEY}" "Publisher" "ATEM Switcher"
  WriteRegStr HKLM "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${EXE}"
  WriteRegStr HKLM "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKLM "${UNINST_KEY}" "NoRepair" 1

  ; auto-update runs the installer silently: start the new version when done
  IfSilent 0 +2
  Exec '"$INSTDIR\${EXE}"'
SectionEnd

Section "Uninstall"
  nsExec::Exec 'taskkill /F /IM ${EXE}'
  nsExec::Exec 'taskkill /F /IM sony-bridge.exe'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="${APPNAME}"'
  nsExec::Exec 'netsh advfirewall firewall delete rule name="${APPNAME} Sony"'
  RMDir /r "$INSTDIR\sony"
  Delete "$INSTDIR\${EXE}"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  Delete "$SMPROGRAMS\${APPNAME}\${APPNAME}.lnk"
  Delete "$SMPROGRAMS\${APPNAME}\Uninstall ${APPNAME}.lnk"
  RMDir "$SMPROGRAMS\${APPNAME}"
  Delete "$DESKTOP\${APPNAME}.lnk"
  DeleteRegKey HKLM "${UNINST_KEY}"
SectionEnd
