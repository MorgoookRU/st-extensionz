package ru.morgoook.tavern;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;

/** window.TavernApp: lets the web UI (Extensionz "Folders" module) talk to the Android app. */
final class AppBridge {
    static final String NAME = "TavernApp";

    private final Activity activity;

    AppBridge(Activity activity) {
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

    /** Opens a folder of the SillyTavern user data (e.g. "characters") in the system file manager. */
    @JavascriptInterface
    public boolean openFolder(String relative) {
        File base = Installer.userDir(activity);
        File target = relative == null || relative.trim().isEmpty() ? base : new File(base, relative);
        try {
            String basePath = base.getCanonicalPath();
            String targetPath = target.getCanonicalPath();
            if (!targetPath.equals(basePath) && !targetPath.startsWith(basePath + File.separator)) return false;
        } catch (IOException e) {
            return false;
        }
        //noinspection ResultOfMethodCallIgnored
        target.mkdirs();

        Uri document = DocumentsContract.buildDocumentUri(DataDocumentsProvider.AUTHORITY, target.getAbsolutePath());
        Uri root = DocumentsContract.buildRootUri(DataDocumentsProvider.AUTHORITY, DataDocumentsProvider.ROOT_ID);
        Intent[] attempts = {
            new Intent(Intent.ACTION_VIEW).setDataAndType(document, DocumentsContract.Document.MIME_TYPE_DIR),
            new Intent("android.provider.action.BROWSE").setData(root),
            new Intent(Intent.ACTION_VIEW).setDataAndType(root, "vnd.android.document/root"),
            new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).putExtra(DocumentsContract.EXTRA_INITIAL_URI, document),
        };
        activity.runOnUiThread(() -> {
            for (Intent intent : attempts) {
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
                try {
                    activity.startActivity(intent);
                    return;
                } catch (ActivityNotFoundException | SecurityException ignored) {
                    // try the next way
                }
            }
            Toast.makeText(activity, R.string.folder_failed, Toast.LENGTH_LONG).show();
        });
        return true;
    }
}
