package ru.morgoook.tavern;

import android.app.ActivityManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.IBinder;
import android.os.PowerManager;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

/**
 * Foreground service that runs the SillyTavern server (Node.js) as a child process.
 * While the app is on screen the process belongs to a foreground app, so Android does not treat it
 * as a background task the way it treats Termux while the browser is in front.
 */
public class NodeService extends Service {
    static final int PORT = 8123;
    static final String ACTION_STOP = "ru.morgoook.tavern.action.STOP";

    private static final String TAG = "TavernNode";
    private static final String CHANNEL = "server";
    private static final int NOTIFICATION_ID = 1;
    private static final Pattern ANSI = Pattern.compile("\u001B\\[[;?0-9]*[A-Za-z]|\u001B\\][^\u0007\u001B]*(\u0007|\u001B\\\\)");

    private static volatile boolean running;

    private volatile Process process;
    private volatile boolean stopping;
    private Thread worker;
    private PowerManager.WakeLock wakeLock;

    static boolean isRunning() {
        return running;
    }

    static void start(Context context) {
        context.startForegroundService(new Intent(context, NodeService.class));
    }

    static void stop(Context context) {
        context.startService(new Intent(context, NodeService.class).setAction(ACTION_STOP));
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationChannel channel = new NotificationChannel(CHANNEL, getString(R.string.notif_channel), NotificationManager.IMPORTANCE_LOW);
        channel.setShowBadge(false);
        getSystemService(NotificationManager.class).createNotificationChannel(channel);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        startForeground(NOTIFICATION_ID, notification(getString(R.string.notif_starting)));
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopping = true;
            ServerStatus.set(ServerStatus.Phase.STOPPED, getString(R.string.status_stopped));
            killProcess();
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }
        if (worker == null || !worker.isAlive()) {
            stopping = false;
            worker = new Thread(this::runServer, "tavern-node");
            worker.start();
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        stopping = true;
        killProcess();
        releaseWakeLock();
        super.onDestroy();
    }

    private void runServer() {
        running = true;
        try {
            if (!Installer.isInstalled(this)) {
                ServerStatus.set(ServerStatus.Phase.INSTALLING, getString(R.string.status_installing, 0), 0);
                Installer.install(this, percent ->
                    ServerStatus.set(ServerStatus.Phase.INSTALLING, getString(R.string.status_installing, percent), percent));
            }
            ServerStatus.set(ServerStatus.Phase.STARTING, getString(R.string.status_starting));
            acquireWakeLock();
            int code = runNode();
            if (!stopping) {
                ServerStatus.set(ServerStatus.Phase.FAILED, getString(R.string.status_exited, code));
            }
        } catch (Throwable error) {
            Log.e(TAG, "Server failed", error);
            ServerStatus.log(String.valueOf(error));
            ServerStatus.set(ServerStatus.Phase.FAILED, getString(R.string.status_failed, String.valueOf(error.getMessage())));
        } finally {
            running = false;
            releaseWakeLock();
        }
    }

    /** Heap limit for V8, picked from the device RAM (see server/st-lite.sh for the measurements). */
    private int heapLimitMb() {
        ActivityManager.MemoryInfo info = new ActivityManager.MemoryInfo();
        getSystemService(ActivityManager.class).getMemoryInfo(info);
        long gb = info.totalMem / (1024L * 1024L * 1024L);
        if (gb < 3) return 256;
        if (gb < 6) return 384;
        return 512;
    }

    private int runNode() throws IOException, InterruptedException {
        String libDir = getApplicationInfo().nativeLibraryDir;
        File node = new File(libDir, "libstnode.so");
        if (!node.isFile()) throw new IOException("Node.js binary is missing: " + node);

        List<String> command = new ArrayList<>();
        command.add(node.getAbsolutePath());
        command.add("--max-old-space-size=" + heapLimitMb());
        command.add("--max-semi-space-size=2");
        command.add("--optimize-for-size");
        command.add("--use-bundled-ca");
        command.add("server.js");
        command.add("--port");
        command.add(String.valueOf(PORT));
        command.add("--listen");
        command.add("false");
        command.add("--browserLaunchEnabled");
        command.add("false");
        command.add("--dataRoot");
        command.add(Installer.dataDir(this).getAbsolutePath());

        ProcessBuilder builder = new ProcessBuilder(command)
            .directory(Installer.stDir(this))
            .redirectErrorStream(true);
        Map<String, String> env = builder.environment();
        env.put("LD_LIBRARY_PATH", libDir);
        env.put("HOME", getFilesDir().getAbsolutePath());
        env.put("TMPDIR", getCacheDir().getAbsolutePath());
        try {
            File cert = Installer.assetFile(this, "cacert.pem");
            env.put("SSL_CERT_FILE", cert.getAbsolutePath());
        } catch (IOException ignored) {
            // node falls back to its bundled certificates (--use-bundled-ca)
        }

        ServerStatus.log("$ " + String.join(" ", command));
        process = builder.start();

        File logFile = new File(getFilesDir(), "server.log");
        if (logFile.length() > 2L * 1024 * 1024) {
            //noinspection ResultOfMethodCallIgnored
            logFile.delete();
        }
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8));
             Writer writer = new FileWriter(logFile, true)) {
            String line;
            while ((line = reader.readLine()) != null) {
                String clean = ANSI.matcher(line).replaceAll("");
                Log.i(TAG, clean);
                ServerStatus.log(clean);
                writer.write(clean);
                writer.write('\n');
                writer.flush();
                if (clean.contains("is listening on")) {
                    ServerStatus.set(ServerStatus.Phase.READY, getString(R.string.status_ready));
                    getSystemService(NotificationManager.class).notify(NOTIFICATION_ID, notification(getString(R.string.notif_running)));
                }
            }
        }
        return process.waitFor();
    }

    private void killProcess() {
        Process current = process;
        process = null;
        if (current == null) return;
        current.destroy();
        try {
            if (!current.waitFor(5, TimeUnit.SECONDS)) current.destroyForcibly();
        } catch (InterruptedException ignored) {
            current.destroyForcibly();
        }
    }

    private void acquireWakeLock() {
        if (wakeLock != null) return;
        // Keeps the CPU running when the screen turns off, so a long generation is not cut off.
        wakeLock = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "tavern:server");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire();
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        wakeLock = null;
    }

    private Notification notification(String text) {
        PendingIntent open = PendingIntent.getActivity(this, 0,
            new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent stop = PendingIntent.getService(this, 1,
            new Intent(this, NodeService.class).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(text)
            .setContentIntent(open)
            .setOngoing(true)
            .setShowWhen(false)
            .addAction(new Notification.Action.Builder(null, getString(R.string.notif_stop), stop).build())
            .build();
    }
}
