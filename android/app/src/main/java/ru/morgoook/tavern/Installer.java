package ru.morgoook.tavern;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.res.AssetFileDescriptor;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Unpacks the bundled SillyTavern (assets/st.zip) into the app's private storage.
 * User data lives in a separate directory, so app updates replace the program but keep chats.
 */
final class Installer {
    interface Progress {
        void onProgress(int percent);
    }

    private static final String MARKER = ".installed";

    private Installer() {
    }

    static File stDir(Context context) {
        return new File(context.getFilesDir(), "st");
    }

    static File dataDir(Context context) {
        File dir = new File(context.getFilesDir(), "data");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return dir;
    }

    /** Data of SillyTavern's default user (characters, chats, backgrounds, ...). */
    static File userDir(Context context) {
        File dir = new File(dataDir(context), "default-user");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        return dir;
    }

    /** Changes whenever a new APK is installed, which triggers re-extraction of the program files. */
    private static String stamp(Context context) {
        try {
            PackageInfo info = context.getPackageManager().getPackageInfo(context.getPackageName(), 0);
            return info.versionName + "|" + info.lastUpdateTime;
        } catch (PackageManager.NameNotFoundException e) {
            return "unknown";
        }
    }

    static boolean isInstalled(Context context) {
        File marker = new File(stDir(context), MARKER);
        try {
            return marker.isFile() && stamp(context).equals(new String(Files.readAllBytes(marker.toPath()), StandardCharsets.UTF_8));
        } catch (IOException e) {
            return false;
        }
    }

    static void install(Context context, Progress progress) throws IOException {
        File target = stDir(context);
        File temp = new File(context.getFilesDir(), "st.tmp");
        deleteRecursive(temp);
        if (!temp.mkdirs()) throw new IOException("Cannot create " + temp);

        long total = -1;
        try (AssetFileDescriptor descriptor = context.getAssets().openFd("st.zip")) {
            total = descriptor.getLength();
        } catch (IOException ignored) {
            // compressed asset: progress will not be reported
        }

        String root = temp.getCanonicalPath() + File.separator;
        byte[] buffer = new byte[1 << 16];
        try (CountingInputStream counting = new CountingInputStream(context.getAssets().open("st.zip"));
             ZipInputStream zip = new ZipInputStream(new BufferedInputStream(counting, 1 << 16))) {
            ZipEntry entry;
            int lastPercent = -1;
            while ((entry = zip.getNextEntry()) != null) {
                File out = new File(temp, entry.getName());
                if (!out.getCanonicalPath().startsWith(root)) throw new IOException("Bad entry: " + entry.getName());
                if (entry.isDirectory()) {
                    //noinspection ResultOfMethodCallIgnored
                    out.mkdirs();
                    continue;
                }
                File parent = out.getParentFile();
                //noinspection ResultOfMethodCallIgnored
                if (parent != null) parent.mkdirs();
                try (OutputStream stream = new FileOutputStream(out)) {
                    int read;
                    while ((read = zip.read(buffer)) > 0) stream.write(buffer, 0, read);
                }
                if (entry.getTime() > 0) {
                    //noinspection ResultOfMethodCallIgnored
                    out.setLastModified(entry.getTime());
                }
                if (total > 0) {
                    int percent = (int) Math.min(100, counting.count * 100 / total);
                    if (percent != lastPercent) {
                        lastPercent = percent;
                        progress.onProgress(percent);
                    }
                }
            }
        }

        deleteRecursive(target);
        //noinspection ResultOfMethodCallIgnored
        new File(context.getFilesDir(), "cacert.pem").delete();
        if (!temp.renameTo(target)) throw new IOException("Cannot move " + temp + " to " + target);
        Files.write(new File(target, MARKER).toPath(), stamp(context).getBytes(StandardCharsets.UTF_8));
    }

    /** Copies a small asset to private storage once and returns it. */
    static File assetFile(Context context, String name) throws IOException {
        File out = new File(context.getFilesDir(), name);
        if (out.isFile() && out.length() > 0) return out;
        try (InputStream in = context.getAssets().open(name); OutputStream stream = new FileOutputStream(out)) {
            byte[] buffer = new byte[1 << 14];
            int read;
            while ((read = in.read(buffer)) > 0) stream.write(buffer, 0, read);
        }
        return out;
    }

    static void deleteRecursive(File file) {
        if (file == null || !file.exists()) return;
        File[] children = file.isDirectory() ? file.listFiles() : null;
        if (children != null) {
            for (File child : children) deleteRecursive(child);
        }
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    private static final class CountingInputStream extends FilterInputStream {
        long count;

        CountingInputStream(InputStream in) {
            super(in);
        }

        @Override
        public int read() throws IOException {
            int value = super.read();
            if (value >= 0) count++;
            return value;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            int read = super.read(b, off, len);
            if (read > 0) count += read;
            return read;
        }

        @Override
        public long skip(long n) throws IOException {
            long skipped = super.skip(n);
            count += skipped;
            return skipped;
        }
    }
}
