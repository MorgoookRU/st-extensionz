package ru.morgoook.tavern;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.widget.Toast;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * File downloads for the WebView. SillyTavern exports chats, cards and backups by clicking an
 * <a download href="blob:..."> link and revoking the blob URL right away, which a WebView cannot
 * download on its own. The injected script keeps a reference to each Blob and streams it to Java in
 * chunks; files are saved to Downloads/SillyTavern.
 */
final class Downloads {
    static final String BRIDGE_NAME = "TavernAndroid";
    private static final String FOLDER = "SillyTavern";

    static final String INJECT_JS = "(function(){"
        + "if(window.__tavernDownloads)return;window.__tavernDownloads=true;"
        + "var blobs=new Map(),create=URL.createObjectURL,revoke=URL.revokeObjectURL;"
        + "URL.createObjectURL=function(o){var u=create.call(URL,o);if(o instanceof Blob){blobs.set(u,o);"
        + "if(blobs.size>64)blobs.delete(blobs.keys().next().value);}return u;};"
        + "URL.revokeObjectURL=function(u){setTimeout(function(){blobs.delete(u);},2000);return revoke.call(URL,u);};"
        + "function send(b,name){var id=TavernAndroid.begin(name||'download',b.type||'application/octet-stream');"
        + "var pos=0,CH=3*1024*1024;(function next(){if(pos>=b.size){TavernAndroid.finish(id);return;}"
        + "var r=new FileReader();r.onload=function(){var s=String(r.result);TavernAndroid.chunk(id,s.substring(s.indexOf(',')+1));pos+=CH;next();};"
        + "r.onerror=function(){TavernAndroid.fail(id,String(r.error));};r.readAsDataURL(b.slice(pos,pos+CH));})();}"
        + "function handle(a){var h=a.href||'',n=a.getAttribute('download')||'';"
        + "if(h.indexOf('blob:')===0){var b=blobs.get(h);if(b){send(b,n);return true;}}"
        + "if(h.indexOf('blob:')===0||h.indexOf('data:')===0){fetch(h).then(function(r){return r.blob();}).then(function(b){send(b,n);})"
        + ".catch(function(e){TavernAndroid.fail(-1,String(e));});return true;}return false;}"
        + "var click=HTMLAnchorElement.prototype.click;"
        + "HTMLAnchorElement.prototype.click=function(){if(this.hasAttribute('download')&&handle(this))return;return click.apply(this,arguments);};"
        + "document.addEventListener('click',function(e){var a=e.target&&e.target.closest?e.target.closest('a[download]'):null;"
        + "if(a&&handle(a))e.preventDefault();},true);"
        + "})();";

    private Downloads() {
    }

    /** JavaScript bridge. Methods run on the WebView's background bridge thread. */
    static final class Bridge {
        private final Activity activity;
        private final AtomicInteger ids = new AtomicInteger();
        private final Map<Integer, Pending> pending = new ConcurrentHashMap<>();

        Bridge(Activity activity) {
            this.activity = activity;
        }

        @JavascriptInterface
        public int begin(String name, String mime) {
            int id = ids.incrementAndGet();
            try {
                File temp = File.createTempFile("download", ".part", activity.getCacheDir());
                pending.put(id, new Pending(name, mime, temp, new FileOutputStream(temp)));
            } catch (IOException error) {
                toast(activity.getString(R.string.save_failed, error.getMessage()));
            }
            return id;
        }

        @JavascriptInterface
        public void chunk(int id, String base64) {
            Pending item = pending.get(id);
            if (item == null) return;
            try {
                item.out.write(Base64.decode(base64, Base64.DEFAULT));
            } catch (IOException | IllegalArgumentException error) {
                fail(id, String.valueOf(error.getMessage()));
            }
        }

        @JavascriptInterface
        public void finish(int id) {
            Pending item = pending.remove(id);
            if (item == null) return;
            try {
                item.out.close();
                String where = save(activity, item.name, item.mime, item.temp);
                toast(activity.getString(R.string.saved_to, where));
            } catch (IOException error) {
                toast(activity.getString(R.string.save_failed, error.getMessage()));
            } finally {
                //noinspection ResultOfMethodCallIgnored
                item.temp.delete();
            }
        }

        @JavascriptInterface
        public void fail(int id, String message) {
            Pending item = pending.remove(id);
            if (item != null) {
                try {
                    item.out.close();
                } catch (IOException ignored) {
                    // nothing to do
                }
                //noinspection ResultOfMethodCallIgnored
                item.temp.delete();
            }
            toast(activity.getString(R.string.save_failed, message));
        }

        private void toast(String text) {
            activity.runOnUiThread(() -> Toast.makeText(activity, text, Toast.LENGTH_LONG).show());
        }
    }

    private static final class Pending {
        final String name;
        final String mime;
        final File temp;
        final OutputStream out;

        Pending(String name, String mime, File temp, OutputStream out) {
            this.name = name;
            this.mime = mime;
            this.temp = temp;
            this.out = out;
        }
    }

    /** Handles plain http(s) downloads (Content-Disposition: attachment) with the WebView's cookies. */
    static void downloadUrl(Activity activity, String url, String userAgent, String contentDisposition, String mime) {
        new Thread(() -> {
            File temp = null;
            try {
                HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
                String cookies = CookieManager.getInstance().getCookie(url);
                if (cookies != null) connection.setRequestProperty("Cookie", cookies);
                if (userAgent != null) connection.setRequestProperty("User-Agent", userAgent);
                temp = File.createTempFile("download", ".part", activity.getCacheDir());
                try (InputStream in = connection.getInputStream(); OutputStream out = new FileOutputStream(temp)) {
                    copy(in, out);
                }
                String name = URLUtil.guessFileName(url, contentDisposition, mime);
                String where = save(activity, name, mime, temp);
                activity.runOnUiThread(() -> Toast.makeText(activity, activity.getString(R.string.saved_to, where), Toast.LENGTH_LONG).show());
            } catch (IOException error) {
                activity.runOnUiThread(() -> Toast.makeText(activity, activity.getString(R.string.save_failed, error.getMessage()), Toast.LENGTH_LONG).show());
            } finally {
                //noinspection ResultOfMethodCallIgnored
                if (temp != null) temp.delete();
            }
        }, "tavern-download").start();
    }

    private static String save(Activity activity, String rawName, String mime, File source) throws IOException {
        String name = rawName == null || rawName.trim().isEmpty() ? "download" : rawName.replaceAll("[\\\\/:*?\"<>|]", "_");
        String type = mime == null || mime.isEmpty() ? "application/octet-stream" : mime;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ContentResolver resolver = activity.getContentResolver();
            ContentValues values = new ContentValues();
            values.put(MediaStore.Downloads.DISPLAY_NAME, name);
            values.put(MediaStore.Downloads.MIME_TYPE, type);
            values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS + "/" + FOLDER);
            values.put(MediaStore.Downloads.IS_PENDING, 1);
            Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
            if (uri == null) throw new IOException("MediaStore insert failed");
            try (OutputStream out = resolver.openOutputStream(uri); InputStream in = new FileInputStream(source)) {
                if (out == null) throw new IOException("Cannot open " + uri);
                copy(in, out);
            }
            values.clear();
            values.put(MediaStore.Downloads.IS_PENDING, 0);
            resolver.update(uri, values, null, null);
            return Environment.DIRECTORY_DOWNLOADS + "/" + FOLDER + "/" + name;
        }
        File dir = new File(activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), FOLDER);
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        File target = new File(dir, name);
        try (InputStream in = new FileInputStream(source); OutputStream out = new FileOutputStream(target)) {
            copy(in, out);
        }
        return target.getAbsolutePath();
    }

    private static void copy(InputStream in, OutputStream out) throws IOException {
        byte[] buffer = new byte[1 << 16];
        int read;
        while ((read = in.read(buffer)) > 0) out.write(buffer, 0, read);
    }
}
