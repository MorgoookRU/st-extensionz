#!/usr/bin/env bash
# Installs the x86_64 APK on the CI emulator, starts it and checks that the embedded SillyTavern
# server answers, the web UI loads (Extensionz logs its version to the console) and the SillyTavern
# folder opens in the system file manager. Prints STAT lines and a small screenshot as base64.
set -uo pipefail

PKG=ru.morgoook.tavern
APK=$(ls android/app/build/outputs/apk/release/*x86_64*.apk | head -1)
PORT=8123
echo "STAT apk_size=$(du -h "$APK" | cut -f1) ($APK)"

adb install -r -g "$APK" || exit 1
adb logcat -c
adb forward tcp:$PORT tcp:$PORT

http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$PORT/" || true; }

shot() {
    adb exec-out screencap -p > "$1.png"
    if command -v convert >/dev/null; then
        convert "$1.png" -resize 540x -quality 72 "$1.jpg"
        echo "SHOT_BEGIN $1"
        base64 -w 900 "$1.jpg" | sed 's/^/SHOT:/'
        echo "SHOT_END $1"
    fi
}

# ---- first start: unpack + first server start (builds the frontend once)
T0=$(date +%s)
adb shell am start -W -n $PKG/.MainActivity
CODE=000
for _ in $(seq 1 420); do
    CODE=$(http_code)
    [ "$CODE" = 200 ] && break
    sleep 2
done
echo "STAT first_start_http=$CODE after $(( $(date +%s) - T0 ))s"

UI=0
for _ in $(seq 1 120); do
    UI=$(adb logcat -d -s TavernWeb:* | grep -c "Extensionz\] v" || true)
    [ "$UI" -ge 1 ] && break
    sleep 2
done
echo "STAT first_ui_loaded=$UI after $(( $(date +%s) - T0 ))s"
sleep 10
shot first-start

echo "STAT memory (dumpsys meminfo $PKG):"
adb shell dumpsys meminfo $PKG | grep -E "TOTAL PSS|TOTAL RSS|Native Heap|Java Heap|TOTAL:" | head -8
echo "STAT processes (RSS in KB):"
adb shell "ps -A -o RSS,NAME" | grep -E "libstnode|$PKG|webview|sandboxed" || true

# ---- SillyTavern folder in the system file manager
adb shell am start -a android.intent.action.VIEW \
    -d "content://$PKG.documents/document/%2Fdata%2Fuser%2F0%2F$PKG%2Ffiles%2Fdata%2Fdefault-user%2Fcharacters" \
    -t vnd.android.document/directory >/dev/null 2>&1
sleep 6
echo "STAT folder_activity=$(adb shell dumpsys activity activities | grep -m1 -E 'topResumedActivity|mResumedActivity' | sed 's/^ *//')"
shot folder
adb shell am start -W -n $PKG/.MainActivity >/dev/null

# ---- warm start: the files are already unpacked and the frontend is cached
adb shell am force-stop $PKG
sleep 2
T1=$(date +%s)
adb shell am start -W -n $PKG/.MainActivity >/dev/null
CODE2=000
for _ in $(seq 1 180); do
    CODE2=$(http_code)
    [ "$CODE2" = 200 ] && break
    sleep 1
done
echo "STAT warm_start_http=$CODE2 after $(( $(date +%s) - T1 ))s"
sleep 12
shot warm-start

echo "----- server log (TavernNode) -----"
adb logcat -d -s TavernNode:* | tail -80
echo "----- web console (TavernWeb) -----"
adb logcat -d -s TavernWeb:* | grep -vE "favicon" | tail -40
echo "----- crashes -----"
adb logcat -d -b crash | tail -40

[ "$CODE" = 200 ] && [ "$UI" -ge 1 ] && [ "$CODE2" = 200 ]
