#!/usr/bin/env bash
# Installs the x86_64 APK on the CI emulator, starts it and checks that the embedded SillyTavern
# server answers, the web UI loads (Extensionz logs its version to the console) and the "open folder"
# button leads to the built-in file manager. Prints STAT lines and a small screenshot as base64.
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
for i in $(seq 1 200); do
    CODE=$(http_code)
    [ "$CODE" = 200 ] && break
    if [ $((i % 10)) -eq 0 ]; then
        NODE_PID=$(adb shell pidof libstnode.so 2>/dev/null | tr -d '\r')
        echo "... $(( $(date +%s) - T0 ))s: http=$CODE node_pid=${NODE_PID:-none} | $(adb logcat -d -s TavernNode:* | tail -1 | cut -c1-160)"
        # Fail fast when the server clearly died instead of waiting for the timeout.
        if [ -z "$NODE_PID" ] && adb logcat -d -s TavernNode:* | grep -qE "CANNOT LINK|Server failed|exit code|Error:|not found"; then
            echo "Server process is gone, stopping early"
            break
        fi
    fi
    sleep 2
done
echo "STAT first_start_http=$CODE after $(( $(date +%s) - T0 ))s"
if [ "$CODE" != 200 ]; then
    echo "----- server log (TavernNode) -----"; adb logcat -d -s TavernNode:* | tail -120
    echo "----- app errors -----"; adb logcat -d AndroidRuntime:E ActivityManager:W '*:S' | tail -40
    shot failure
    exit 1
fi

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

# ---- "Open folder" button in the web UI -> built-in file manager (FolderActivity)
WEB_PID=$(adb shell pidof $PKG | tr -d '\r')
adb forward tcp:9222 localabstract:webview_devtools_remote_$WEB_PID
cdp() { node android/ci/cdp.mjs 9222 "$1"; }
echo "STAT folder_buttons=$(cdp 'document.querySelectorAll(".stx-folder-btn").length')"
cdp 'document.querySelector(".stx-folder-btn[data-folder=characters]").click(); "clicked"'
sleep 4
FOCUS=$(adb shell dumpsys activity activities | grep -m1 -E 'topResumedActivity|mResumedActivity' | sed 's/^ *//' | cut -c1-140)
echo "STAT folder_activity=$FOCUS"
FOLDER_OK=0
echo "$FOCUS" | grep -q FolderActivity && FOLDER_OK=1
shot folder-characters
adb shell input keyevent KEYCODE_BACK
sleep 3
echo "STAT folder_back=$(adb shell dumpsys activity activities | grep -m1 -E 'topResumedActivity|mResumedActivity' | sed 's/^ *//' | cut -c1-140)"
cdp 'SillyTavern.getContext().executeSlashCommandsWithOptions("/folder"); "popup"'
sleep 3
shot folders-popup
cdp 'document.querySelector(".popup-button-ok, .popup-button-cancel")?.click(); "closed"'

# ---- is SillyTavern listed in the system file picker's side menu?
adb shell am start -a android.intent.action.GET_CONTENT -t '*/*' -c android.intent.category.OPENABLE >/dev/null
sleep 5
PICKER=$(adb shell dumpsys activity activities | grep -m1 -E 'topResumedActivity|mResumedActivity' | sed 's/^ *//' | cut -c1-140)
echo "STAT picker=$PICKER"
adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
MENU=$(adb shell cat /sdcard/ui.xml | grep -oE 'content-desc="Show roots"[^>]*bounds="\[[0-9]+,[0-9]+\]' | grep -oE '[0-9]+,[0-9]+\]$' | tr -d ']' | tr ',' ' ')
[ -n "$MENU" ] && adb shell input tap $MENU && sleep 2
adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1
if echo "$PICKER" | grep -q documentsui; then
    echo "STAT files_sidebar_has_sillytavern=$(adb shell cat /sdcard/ui.xml | grep -c 'text="SillyTavern"')"
else
    echo "STAT files_sidebar_has_sillytavern=unknown (the picker did not open)"
fi
shot files-sidebar
adb shell input keyevent KEYCODE_BACK
adb shell input keyevent KEYCODE_BACK
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

[ "$CODE" = 200 ] && [ "$UI" -ge 1 ] && [ "$CODE2" = 200 ] && [ "$FOLDER_OK" = 1 ]
