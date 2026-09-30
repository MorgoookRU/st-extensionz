package ru.morgoook.tavern;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Bundle;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.text.format.Formatter;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.MimeTypeMap;
import android.widget.BaseAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.TextView;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.text.DateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Date;
import java.util.List;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;

/**
 * Built-in file manager for the SillyTavern data folder. System file managers differ a lot between
 * phone vendors (Google Files ignores "open this folder" links from other apps), so the web UI's
 * "Open folder" buttons land here: browse, open files, import files from the phone, share, rename
 * and delete. The folder is also reachable from the system Files app via DataDocumentsProvider.
 */
public class FolderActivity extends Activity {
    static final String EXTRA_PATH = "path";
    /** Result: top-level data folders (e.g. "characters") whose contents were changed here. */
    static final String EXTRA_CHANGED = "changed";
    static final int RESULT_CHANGED = RESULT_FIRST_USER;
    private static final int REQUEST_IMPORT = 20;

    private File root;
    private File current;
    private TextView titleView;
    private TextView pathView;
    private TextView emptyView;
    private final List<File> entries = new ArrayList<>();
    private EntryAdapter adapter;
    private final Set<String> changedFolders = new LinkedHashSet<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        root = Installer.userDir(this);
        String relative = getIntent().getStringExtra(EXTRA_PATH);
        File start = relative == null || relative.isEmpty() ? root : new File(root, relative);
        //noinspection ResultOfMethodCallIgnored
        start.mkdirs();
        current = isInside(start) ? start : root;
        setContentView(buildUi());
        refresh();
    }

    @Override
    public void onBackPressed() {
        if (!current.equals(root) && current.getParentFile() != null) {
            current = current.getParentFile();
            refresh();
        } else {
            finishWithResult();
        }
    }

    private void finishWithResult() {
        if (changedFolders.isEmpty()) {
            setResult(RESULT_OK);
        } else {
            setResult(RESULT_CHANGED, new Intent().putStringArrayListExtra(EXTRA_CHANGED, new ArrayList<>(changedFolders)));
        }
        finish();
    }

    /** Remembers which top-level folder a change touched, so the web UI refreshes only what it needs. */
    private void markChanged(File file) {
        String relative = relativePath(file);
        int slash = relative.indexOf('/');
        changedFolders.add(slash >= 0 ? relative.substring(0, slash) : relative);
    }

    private boolean isInside(File file) {
        try {
            String base = root.getCanonicalPath();
            String path = file.getCanonicalPath();
            return path.equals(base) || path.startsWith(base + File.separator);
        } catch (IOException e) {
            return false;
        }
    }

    private String relativePath(File file) {
        String base = root.getAbsolutePath();
        String path = file.getAbsolutePath();
        return path.length() > base.length() ? path.substring(base.length() + 1) : "";
    }

    // ------------------------------------------------------------------ UI

    private int dp(int value) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics());
    }

    private Button actionButton(int text, View.OnClickListener listener) {
        Button button = new Button(this);
        button.setText(text);
        button.setAllCaps(false);
        button.setOnClickListener(listener);
        return button;
    }

    private View buildUi() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setBackgroundColor(0xFF15161A);
        box.setPadding(dp(12), dp(12), dp(12), 0);

        LinearLayout header = new LinearLayout(this);
        header.setGravity(Gravity.CENTER_VERTICAL);
        Button back = new Button(this);
        back.setText("←");
        back.setOnClickListener(v -> onBackPressed());
        header.addView(back, new LinearLayout.LayoutParams(dp(52), ViewGroup.LayoutParams.WRAP_CONTENT));
        LinearLayout titles = new LinearLayout(this);
        titles.setOrientation(LinearLayout.VERTICAL);
        titles.setPadding(dp(8), 0, 0, 0);
        titleView = new TextView(this);
        titleView.setTextColor(0xFFE8C27A);
        titleView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        titleView.setTypeface(Typeface.DEFAULT_BOLD);
        pathView = new TextView(this);
        pathView.setTextColor(0x99E8E6E3);
        pathView.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        pathView.setTypeface(Typeface.MONOSPACE);
        titles.addView(titleView);
        titles.addView(pathView);
        header.addView(titles, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        Button done = new Button(this);
        done.setText("✕");
        done.setOnClickListener(v -> finishWithResult());
        header.addView(done, new LinearLayout.LayoutParams(dp(52), ViewGroup.LayoutParams.WRAP_CONTENT));
        box.addView(header);

        LinearLayout actions = new LinearLayout(this);
        actions.addView(actionButton(R.string.folder_import, v -> startImport()));
        actions.addView(actionButton(R.string.folder_new, v -> askNewFolder()));
        actions.addView(actionButton(R.string.folder_system, v -> openInSystemFiles()));
        HorizontalScrollView scroll = new HorizontalScrollView(this);
        scroll.addView(actions);
        box.addView(scroll);

        emptyView = new TextView(this);
        emptyView.setText(R.string.folder_empty);
        emptyView.setTextColor(0x99E8E6E3);
        emptyView.setGravity(Gravity.CENTER);
        emptyView.setPadding(0, dp(32), 0, dp(32));
        box.addView(emptyView);

        ListView list = new ListView(this);
        adapter = new EntryAdapter();
        list.setAdapter(adapter);
        list.setDivider(null);
        list.setOnItemClickListener((parent, view, position, id) -> openEntry(entries.get(position)));
        list.setOnItemLongClickListener((parent, view, position, id) -> {
            showEntryMenu(entries.get(position));
            return true;
        });
        box.addView(list, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        TextView hint = new TextView(this);
        hint.setText(R.string.folder_hint);
        hint.setTextColor(0x80E8E6E3);
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
        hint.setPadding(dp(4), dp(8), dp(4), dp(12));
        box.addView(hint);
        return box;
    }

    private void refresh() {
        titleView.setText(current.equals(root) ? getString(R.string.app_name) : current.getName());
        pathView.setText("SillyTavern/" + relativePath(current));
        entries.clear();
        File[] files = current.listFiles();
        if (files != null) {
            Arrays.sort(files, (a, b) -> {
                if (a.isDirectory() != b.isDirectory()) return a.isDirectory() ? -1 : 1;
                return a.getName().compareToIgnoreCase(b.getName());
            });
            for (File file : files) {
                if (!file.getName().startsWith(".")) entries.add(file);
            }
        }
        emptyView.setVisibility(entries.isEmpty() ? View.VISIBLE : View.GONE);
        adapter.notifyDataSetChanged();
    }

    private final class EntryAdapter extends BaseAdapter {
        private final DateFormat dateFormat = DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT);

        @Override
        public int getCount() {
            return entries.size();
        }

        @Override
        public Object getItem(int position) {
            return entries.get(position);
        }

        @Override
        public long getItemId(int position) {
            return position;
        }

        @Override
        public View getView(int position, View convertView, ViewGroup parent) {
            LinearLayout row = convertView instanceof LinearLayout ? (LinearLayout) convertView : createRow();
            File file = entries.get(position);
            ((TextView) row.getChildAt(0)).setText(file.isDirectory() ? "📁" : iconFor(file));
            LinearLayout texts = (LinearLayout) row.getChildAt(1);
            ((TextView) texts.getChildAt(0)).setText(file.getName());
            String details = dateFormat.format(new Date(file.lastModified()));
            if (!file.isDirectory()) details = Formatter.formatShortFileSize(FolderActivity.this, file.length()) + " · " + details;
            ((TextView) texts.getChildAt(1)).setText(details);
            return row;
        }

        private LinearLayout createRow() {
            LinearLayout row = new LinearLayout(FolderActivity.this);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(dp(8), dp(10), dp(8), dp(10));
            TextView icon = new TextView(FolderActivity.this);
            icon.setTextSize(TypedValue.COMPLEX_UNIT_SP, 22);
            icon.setPadding(0, 0, dp(12), 0);
            row.addView(icon);
            LinearLayout texts = new LinearLayout(FolderActivity.this);
            texts.setOrientation(LinearLayout.VERTICAL);
            TextView name = new TextView(FolderActivity.this);
            name.setTextColor(0xFFE8E6E3);
            name.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
            TextView details = new TextView(FolderActivity.this);
            details.setTextColor(0x80E8E6E3);
            details.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11);
            texts.addView(name);
            texts.addView(details);
            row.addView(texts, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            return row;
        }
    }

    private static String iconFor(File file) {
        String mime = mimeOf(file);
        if (mime.startsWith("image/")) return "🖼️";
        if (mime.startsWith("audio/")) return "🎵";
        if (mime.startsWith("video/")) return "🎞️";
        String name = file.getName().toLowerCase(Locale.ROOT);
        if (name.endsWith(".jsonl") || name.endsWith(".json")) return "💬";
        return "📄";
    }

    private static String mimeOf(File file) {
        String name = file.getName();
        int dot = name.lastIndexOf('.');
        if (dot >= 0) {
            String extension = name.substring(dot + 1).toLowerCase(Locale.ROOT);
            // Chats and settings are text: let any text viewer or editor open them.
            if (extension.equals("jsonl") || extension.equals("json") || extension.equals("yaml")) return "text/plain";
            String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
            if (mime != null) return mime;
        }
        return "application/octet-stream";
    }

    // ------------------------------------------------------------------ actions

    private Uri uriFor(File file) {
        return DocumentsContract.buildDocumentUri(DataDocumentsProvider.AUTHORITY, file.getAbsolutePath());
    }

    private void openEntry(File file) {
        if (file.isDirectory()) {
            current = file;
            refresh();
            return;
        }
        Intent view = new Intent(Intent.ACTION_VIEW)
            .setDataAndType(uriFor(file), mimeOf(file))
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            startActivity(Intent.createChooser(view, file.getName()));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, R.string.folder_no_app, Toast.LENGTH_SHORT).show();
        }
    }

    private void showEntryMenu(File file) {
        String[] items = {getString(R.string.folder_share), getString(R.string.folder_rename), getString(R.string.folder_delete)};
        new AlertDialog.Builder(this)
            .setTitle(file.getName())
            .setItems(items, (dialog, which) -> {
                if (which == 0) share(file);
                else if (which == 1) askRename(file);
                else confirmDelete(file);
            })
            .show();
    }

    private void share(File file) {
        if (file.isDirectory()) {
            Toast.makeText(this, R.string.folder_share_dir, Toast.LENGTH_SHORT).show();
            return;
        }
        Intent send = new Intent(Intent.ACTION_SEND)
            .setType(mimeOf(file))
            .putExtra(Intent.EXTRA_STREAM, uriFor(file))
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        send.setClipData(ClipData.newRawUri(file.getName(), uriFor(file)));
        startActivity(Intent.createChooser(send, file.getName()));
    }

    private void askRename(File file) {
        EditText input = new EditText(this);
        input.setText(file.getName());
        new AlertDialog.Builder(this)
            .setTitle(R.string.folder_rename)
            .setView(input)
            .setPositiveButton(android.R.string.ok, (dialog, which) -> {
                String name = input.getText().toString().trim().replaceAll("[\\\\/]", "_");
                File target = new File(file.getParentFile(), name);
                if (!name.isEmpty() && !target.exists() && file.renameTo(target)) {
                    markChanged(file);
                    refresh();
                } else {
                    Toast.makeText(this, R.string.folder_failed_action, Toast.LENGTH_SHORT).show();
                }
            })
            .setNegativeButton(android.R.string.cancel, null)
            .show();
    }

    private void confirmDelete(File file) {
        new AlertDialog.Builder(this)
            .setTitle(getString(R.string.folder_delete_confirm, file.getName()))
            .setPositiveButton(R.string.folder_delete, (dialog, which) -> {
                Installer.deleteRecursive(file);
                markChanged(file);
                refresh();
            })
            .setNegativeButton(android.R.string.cancel, null)
            .show();
    }

    private void askNewFolder() {
        EditText input = new EditText(this);
        new AlertDialog.Builder(this)
            .setTitle(R.string.folder_new)
            .setView(input)
            .setPositiveButton(android.R.string.ok, (dialog, which) -> {
                String name = input.getText().toString().trim().replaceAll("[\\\\/]", "_");
                if (!name.isEmpty() && new File(current, name).mkdirs()) {
                    markChanged(new File(current, name));
                    refresh();
                }
            })
            .setNegativeButton(android.R.string.cancel, null)
            .show();
    }

    private void openInSystemFiles() {
        Uri document = uriFor(current);
        Uri rootUri = DocumentsContract.buildRootUri(DataDocumentsProvider.AUTHORITY, DataDocumentsProvider.ROOT_ID);
        Intent[] attempts = {
            new Intent(Intent.ACTION_VIEW).setDataAndType(document, DocumentsContract.Document.MIME_TYPE_DIR),
            new Intent(Intent.ACTION_VIEW).setDataAndType(rootUri, "vnd.android.document/root"),
        };
        for (Intent intent : attempts) {
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            try {
                startActivity(intent);
                Toast.makeText(this, R.string.folder_system_hint, Toast.LENGTH_LONG).show();
                return;
            } catch (ActivityNotFoundException | SecurityException ignored) {
                // try the next way
            }
        }
        Toast.makeText(this, R.string.folder_failed, Toast.LENGTH_LONG).show();
    }

    private void startImport() {
        Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("*/*")
            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        try {
            startActivityForResult(pick, REQUEST_IMPORT);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, R.string.folder_no_app, Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_IMPORT || resultCode != RESULT_OK || data == null) return;
        List<Uri> uris = new ArrayList<>();
        if (data.getClipData() != null) {
            for (int i = 0; i < data.getClipData().getItemCount(); i++) uris.add(data.getClipData().getItemAt(i).getUri());
        } else if (data.getData() != null) {
            uris.add(data.getData());
        }
        File target = current;
        new Thread(() -> {
            int copied = 0;
            for (Uri uri : uris) {
                try {
                    copyInto(uri, target);
                    copied++;
                } catch (IOException ignored) {
                    // reported by the count below
                }
            }
            int total = copied;
            runOnUiThread(() -> {
                if (total > 0) markChanged(target);
                refresh();
                Toast.makeText(this, getString(R.string.folder_imported, total), Toast.LENGTH_SHORT).show();
            });
        }, "tavern-import").start();
    }

    private void copyInto(Uri uri, File dir) throws IOException {
        String name = "file";
        try (Cursor cursor = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst() && cursor.getString(0) != null) name = cursor.getString(0);
        }
        name = name.replaceAll("[\\\\/]", "_");
        File out = new File(dir, name);
        int dot = name.lastIndexOf('.');
        for (int i = 1; out.exists(); i++) {
            out = new File(dir, dot > 0 ? name.substring(0, dot) + " (" + i + ")" + name.substring(dot) : name + " (" + i + ")");
        }
        try (InputStream in = getContentResolver().openInputStream(uri); OutputStream stream = new FileOutputStream(out)) {
            if (in == null) throw new IOException("Cannot read " + uri);
            byte[] buffer = new byte[1 << 16];
            int read;
            while ((read = in.read(buffer)) > 0) stream.write(buffer, 0, read);
        }
    }
}
