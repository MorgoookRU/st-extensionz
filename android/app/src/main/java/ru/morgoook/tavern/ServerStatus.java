package ru.morgoook.tavern;

import android.os.Handler;
import android.os.Looper;

import java.util.ArrayDeque;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/** Process-wide server state shared by the service and the activity. Listeners run on the main thread. */
final class ServerStatus {
    enum Phase { IDLE, INSTALLING, STARTING, READY, STOPPED, FAILED }

    interface Listener {
        void onStatus(Phase phase, String message, int progress);

        void onLog(String line);
    }

    private static final int MAX_LOG_LINES = 400;
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final List<Listener> LISTENERS = new CopyOnWriteArrayList<>();
    private static final ArrayDeque<String> LOG = new ArrayDeque<>();

    private static volatile Phase phase = Phase.IDLE;
    private static volatile String message = "";
    private static volatile int progress = -1;

    private ServerStatus() {
    }

    static void set(Phase newPhase, String newMessage) {
        set(newPhase, newMessage, -1);
    }

    static void set(Phase newPhase, String newMessage, int newProgress) {
        phase = newPhase;
        message = newMessage;
        progress = newProgress;
        MAIN.post(() -> {
            for (Listener listener : LISTENERS) listener.onStatus(newPhase, newMessage, newProgress);
        });
    }

    static void log(String line) {
        synchronized (LOG) {
            if (LOG.size() >= MAX_LOG_LINES) LOG.removeFirst();
            LOG.addLast(line);
        }
        MAIN.post(() -> {
            for (Listener listener : LISTENERS) listener.onLog(line);
        });
    }

    static String logText(int lastLines) {
        StringBuilder builder = new StringBuilder();
        synchronized (LOG) {
            int skip = Math.max(0, LOG.size() - lastLines);
            for (String line : LOG) {
                if (skip-- > 0) continue;
                builder.append(line).append('\n');
            }
        }
        return builder.toString();
    }

    static Phase phase() {
        return phase;
    }

    static void addListener(Listener listener) {
        LISTENERS.add(listener);
        Phase current = phase;
        String currentMessage = message;
        int currentProgress = progress;
        MAIN.post(() -> listener.onStatus(current, currentMessage, currentProgress));
    }

    static void removeListener(Listener listener) {
        LISTENERS.remove(listener);
    }
}
