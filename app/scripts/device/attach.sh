#!/bin/sh
# Point CDP port 9333 at the app's WebView on the phone (through the adb
# server given by ADB, e.g. "adb -H 127.0.0.1 -P 5038 -s SERIAL").
ADB=${ADB:-adb}
PID=$($ADB shell pidof city.reclaimchennai.cam | tr -d '\r')
[ -z "$PID" ] && { $ADB shell am start -n city.reclaimchennai.cam/.MainActivity >/dev/null; sleep 6; PID=$($ADB shell pidof city.reclaimchennai.cam | tr -d '\r'); }
$ADB forward --remove-all
$ADB forward tcp:${CDP_PORT:-9333} localabstract:webview_devtools_remote_$PID >/dev/null && echo "attached to pid $PID"
