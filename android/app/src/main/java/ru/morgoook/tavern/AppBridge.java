package ru.morgoook.tavern;

import android.webkit.JavascriptInterface;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;

/** window.TavernApp: lets the web UI (Extensionz "Folders" module) talk to the Android app. */
final class AppBridge {
    static final String NAME = "TavernApp";

    private final MainActivity activity;

    AppBridge(MainActivity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public String info() {
        try {
            return new JSONObject()
                .put("platform", "android")
                .put("version", BuildConfig.VERSION_NAME)
                .put("dataDir", Installer.userDir(activity).getAbsolutePath())
                .put("folders", true)
                .toString();
        } catch (JSONException e) {
            return "{}";
        }
    }

    /** Opens a folder of the SillyTavern user data (e.g. "characters") in the built-in file manager. */
    @JavascriptInterface
    public boolean openFolder(String relative) {
        File base = Installer.userDir(activity);
        String path = relative == null ? "" : relative.trim();
        try {
            String basePath = base.getCanonicalPath();
            String targetPath = new File(base, path).getCanonicalPath();
            if (!targetPath.equals(basePath) && !targetPath.startsWith(basePath + File.separator)) return false;
        } catch (IOException e) {
            return false;
        }
        activity.runOnUiThread(() -> activity.openFolder(path));
        return true;
    }
}
