package ru.morgoook.tavern;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Log;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;

import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;

public class MainActivity extends Activity implements ServerStatus.Listener {
    private static final String URL = "http://127.0.0.1:" + NodeService.PORT + "/";
    private static final String WEB_TAG = "TavernWeb";
    private static final int REQUEST_FILES = 10;
    private static final int REQUEST_FOLDER = 11;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private FrameLayout root;
    private WebView web;
    private View panel;
    private TextView statusView;
    private TextView logView;
    private ScrollView logScroll;
    private ProgressBar progress;
    private Button restartButton;
    private ValueCallback<Uri[]> fileCallback;
    private volatile boolean pageLoaded;
    private volatile boolean polling;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        root = new FrameLayout(this);
        root.setBackgroundColor(0xFF15161A);
        web = createWebView();
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        panel = createPanel();
        root.addView(panel, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }

        ServerStatus.addListener(this);
        NodeService.start(this);
        startPolling();
    }

    @Override
    protected void onDestroy() {
        ServerStatus.removeListener(this);
        polling = false;
        if (web != null) web.destroy();
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        if (pageLoaded && web.canGoBack()) {
            web.goBack();
        } else {
            // Keep the server and the page alive; just leave the app like the home button does.
            moveTaskToBack(true);
        }
    }

    // ------------------------------------------------------------------ server status

    @Override
    public void onStatus(ServerStatus.Phase phase, String message, int percent) {
        if (!message.isEmpty()) statusView.setText(message);
        progress.setIndeterminate(percent < 0);
        if (percent >= 0) progress.setProgress(percent);
        boolean failed = phase == ServerStatus.Phase.FAILED || phase == ServerStatus.Phase.STOPPED;
        restartButton.setVisibility(failed ? View.VISIBLE : View.GONE);
        progress.setVisibility(failed ? View.GONE : View.VISIBLE);
        if (failed) {
            showPanel();
        } else {
            startPolling();
        }
    }

    @Override
    public void onLog(String line) {
        if (panel.getVisibility() != View.VISIBLE) return;
        logView.setText(ServerStatus.logText(60));
        logScroll.post(() -> logScroll.fullScroll(View.FOCUS_DOWN));
    }

    private void showPanel() {
        panel.setVisibility(View.VISIBLE);
        logView.setText(ServerStatus.logText(60));
    }

    /** Polls the server until it answers, then opens the UI. */
    private void startPolling() {
        if (polling || pageLoaded) return;
        polling = true;
        new Thread(() -> {
            while (polling && !pageLoaded && !isFinishing()) {
                if (ping()) {
                    handler.post(() -> {
                        polling = false;
                        if (!pageLoaded) web.loadUrl(URL);
                    });
                    return;
                }
                try {
                    Thread.sleep(700);
                } catch (InterruptedException e) {
                    break;
                }
            }
            polling = false;
        }, "tavern-poll").start();
    }

    private static boolean ping() {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(URL).openConnection();
            connection.setConnectTimeout(1500);
            connection.setReadTimeout(3000);
            return connection.getResponseCode() == 200;
        } catch (Exception e) {
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    // ------------------------------------------------------------------ web view

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    private WebView createWebView() {
        WebView view = new WebView(this);
        view.setBackgroundColor(0xFF15161A);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setTextZoom(100);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setUserAgentString(settings.getUserAgentString() + " SillyTavernAndroid/" + BuildConfig.VERSION_CODE);
        CookieManager.getInstance().setAcceptCookie(true);
        // chrome://inspect works over USB debugging, handy for troubleshooting.
        WebView.setWebContentsDebuggingEnabled(true);

        view.addJavascriptInterface(new Downloads.Bridge(this), Downloads.BRIDGE_NAME);
        view.addJavascriptInterface(new AppBridge(this), AppBridge.NAME);
        view.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            if (url.startsWith("blob:") || url.startsWith("data:")) return; // handled by the injected script
            Downloads.downloadUrl(this, url, userAgent, contentDisposition, mimeType);
        });

        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String host = uri.getHost();
                if ("127.0.0.1".equals(host) || "localhost".equals(host)) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (ActivityNotFoundException ignored) {
                    // no browser
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                if (url != null && url.startsWith(URL)) {
                    v.evaluateJavascript(Downloads.INJECT_JS, null);
                    if (!pageLoaded) {
                        pageLoaded = true;
                        panel.setVisibility(View.GONE);
                    }
                }
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    pageLoaded = false;
                    statusView.setText(R.string.status_disconnected);
                    showPanel();
                    handler.postDelayed(MainActivity.this::startPolling, 1000);
                }
            }

            @Override
            public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail detail) {
                // Android killed the page renderer to free memory. The server keeps running:
                // rebuild the WebView and reload instead of crashing the app.
                Log.w(WEB_TAG, "Renderer gone (crashed=" + detail.didCrash() + "), reloading");
                recreateWebView();
                return true;
            }
        });

        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent intent = params.createIntent();
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                try {
                    startActivityForResult(Intent.createChooser(intent, null), REQUEST_FILES);
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                Log.d(WEB_TAG, message.messageLevel() + ": " + message.message());
                return true;
            }
        });
        return view;
    }

    private void recreateWebView() {
        pageLoaded = false;
        root.removeView(web);
        web.destroy();
        web = createWebView();
        root.addView(web, 0, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        startPolling();
    }

    /** Opens the built-in file manager at a folder of the SillyTavern data (called by AppBridge). */
    void openFolder(String relative) {
        startActivityForResult(new Intent(this, FolderActivity.class).putExtra(FolderActivity.EXTRA_PATH, relative), REQUEST_FOLDER);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_FOLDER) {
            if (resultCode == FolderActivity.RESULT_CHANGED && data != null && pageLoaded) {
                // Let the web UI refresh the lists that show the changed folders (Extensionz "Folders").
                JSONArray folders = new JSONArray();
                ArrayList<String> changed = data.getStringArrayListExtra(FolderActivity.EXTRA_CHANGED);
                if (changed != null) for (String folder : changed) folders.put(folder);
                web.evaluateJavascript("window.dispatchEvent(new CustomEvent('tavernapp:files-changed',{detail:{folders:" + folders + "}}))", null);
            }
            return;
        }
        if (requestCode != REQUEST_FILES || fileCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null) {
            ClipData clip = data.getClipData();
            if (clip != null && clip.getItemCount() > 0) {
                result = new Uri[clip.getItemCount()];
                for (int i = 0; i < clip.getItemCount(); i++) result[i] = clip.getItemAt(i).getUri();
            } else if (data.getData() != null) {
                result = new Uri[]{data.getData()};
            }
        }
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    // ------------------------------------------------------------------ status panel

    private int dp(int value) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics());
    }

    private View createPanel() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER_HORIZONTAL);
        box.setPadding(dp(24), dp(48), dp(24), dp(24));
        box.setBackgroundColor(0xFF15161A);
        box.setClickable(true);

        TextView title = new TextView(this);
        title.setText(R.string.app_name);
        title.setTextColor(0xFFE8C27A);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 28);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        box.addView(title);

        TextView subtitle = new TextView(this);
        subtitle.setText(R.string.subtitle);
        subtitle.setTextColor(0x99E8E6E3);
        subtitle.setGravity(Gravity.CENTER);
        subtitle.setPadding(0, dp(4), 0, dp(24));
        box.addView(subtitle);

        progress = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progress.setIndeterminate(true);
        progress.setMax(100);
        box.addView(progress, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(8)));

        statusView = new TextView(this);
        statusView.setTextColor(Color.WHITE);
        statusView.setGravity(Gravity.CENTER);
        statusView.setPadding(0, dp(12), 0, dp(12));
        statusView.setText(R.string.notif_starting);
        box.addView(statusView);

        LinearLayout buttons = new LinearLayout(this);
        buttons.setGravity(Gravity.CENTER);
        restartButton = new Button(this);
        restartButton.setText(R.string.btn_restart);
        restartButton.setVisibility(View.GONE);
        restartButton.setOnClickListener(v -> {
            restartButton.setVisibility(View.GONE);
            NodeService.start(this);
            startPolling();
        });
        buttons.addView(restartButton);
        Button battery = new Button(this);
        battery.setText(R.string.btn_battery);
        battery.setOnClickListener(v -> requestBatteryExemption());
        PowerManager power = getSystemService(PowerManager.class);
        battery.setVisibility(power.isIgnoringBatteryOptimizations(getPackageName()) ? View.GONE : View.VISIBLE);
        buttons.addView(battery);
        box.addView(buttons);

        logView = new TextView(this);
        logView.setTextColor(0xB3E8E6E3);
        logView.setTypeface(Typeface.MONOSPACE);
        logView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 10);
        logView.setTextIsSelectable(true);
        logScroll = new ScrollView(this);
        logScroll.addView(logView);
        LinearLayout.LayoutParams logParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f);
        logParams.topMargin = dp(16);
        box.addView(logScroll, logParams);
        return box;
    }

    @SuppressLint("BatteryLife")
    private void requestBatteryExemption() {
        try {
            startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + getPackageName())));
        } catch (ActivityNotFoundException e) {
            startActivity(new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS));
        }
    }
}
