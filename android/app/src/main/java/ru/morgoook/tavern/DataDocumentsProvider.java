package ru.morgoook.tavern;

import android.database.Cursor;
import android.database.MatrixCursor;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract.Document;
import android.provider.DocumentsContract.Root;
import android.provider.DocumentsProvider;
import android.webkit.MimeTypeMap;

import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.util.Locale;

/**
 * Shows the SillyTavern data folder (characters, chats, backgrounds, ...) in the system file manager
 * ("Files" app sidebar and any file picker), the same way Termux exposes its home folder.
 * Document ids are absolute paths inside the data folder.
 */
public class DataDocumentsProvider extends DocumentsProvider {
    static final String AUTHORITY = BuildConfig.APPLICATION_ID + ".documents";
    static final String ROOT_ID = "sillytavern";

    private static final String[] ROOT_PROJECTION = {
        Root.COLUMN_ROOT_ID, Root.COLUMN_MIME_TYPES, Root.COLUMN_FLAGS, Root.COLUMN_ICON,
        Root.COLUMN_TITLE, Root.COLUMN_SUMMARY, Root.COLUMN_DOCUMENT_ID, Root.COLUMN_AVAILABLE_BYTES,
    };
    private static final String[] DOCUMENT_PROJECTION = {
        Document.COLUMN_DOCUMENT_ID, Document.COLUMN_MIME_TYPE, Document.COLUMN_DISPLAY_NAME,
        Document.COLUMN_LAST_MODIFIED, Document.COLUMN_FLAGS, Document.COLUMN_SIZE,
    };

    private File baseDir() {
        return Installer.userDir(getContext());
    }

    private File fileFor(String documentId) throws FileNotFoundException {
        File file = new File(documentId);
        try {
            String base = baseDir().getCanonicalPath();
            String path = file.getCanonicalPath();
            if (!path.equals(base) && !path.startsWith(base + File.separator)) {
                throw new FileNotFoundException("Outside of the SillyTavern folder: " + documentId);
            }
        } catch (IOException error) {
            throw new FileNotFoundException(error.getMessage());
        }
        if (!file.exists()) throw new FileNotFoundException(documentId);
        return file;
    }

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public Cursor queryRoots(String[] projection) {
        MatrixCursor result = new MatrixCursor(projection != null ? projection : ROOT_PROJECTION);
        File base = baseDir();
        MatrixCursor.RowBuilder row = result.newRow();
        row.add(Root.COLUMN_ROOT_ID, ROOT_ID);
        row.add(Root.COLUMN_DOCUMENT_ID, base.getAbsolutePath());
        row.add(Root.COLUMN_SUMMARY, getContext().getString(R.string.documents_summary));
        row.add(Root.COLUMN_FLAGS, Root.FLAG_SUPPORTS_CREATE | Root.FLAG_SUPPORTS_IS_CHILD | Root.FLAG_LOCAL_ONLY);
        row.add(Root.COLUMN_TITLE, getContext().getString(R.string.app_name));
        row.add(Root.COLUMN_MIME_TYPES, "*/*");
        row.add(Root.COLUMN_AVAILABLE_BYTES, base.getFreeSpace());
        row.add(Root.COLUMN_ICON, R.mipmap.ic_launcher);
        return result;
    }

    @Override
    public Cursor queryDocument(String documentId, String[] projection) throws FileNotFoundException {
        MatrixCursor result = new MatrixCursor(projection != null ? projection : DOCUMENT_PROJECTION);
        addRow(result, fileFor(documentId));
        return result;
    }

    @Override
    public Cursor queryChildDocuments(String parentDocumentId, String[] projection, String sortOrder) throws FileNotFoundException {
        MatrixCursor result = new MatrixCursor(projection != null ? projection : DOCUMENT_PROJECTION);
        File[] children = fileFor(parentDocumentId).listFiles();
        if (children != null) {
            for (File child : children) addRow(result, child);
        }
        return result;
    }

    @Override
    public ParcelFileDescriptor openDocument(String documentId, String mode, CancellationSignal signal) throws FileNotFoundException {
        return ParcelFileDescriptor.open(fileFor(documentId), ParcelFileDescriptor.parseMode(mode));
    }

    @Override
    public String createDocument(String parentDocumentId, String mimeType, String displayName) throws FileNotFoundException {
        File parent = fileFor(parentDocumentId);
        String name = displayName.replaceAll("[\\\\/]", "_");
        File target = new File(parent, name);
        for (int i = 1; target.exists(); i++) target = new File(parent, i + "_" + name);
        try {
            boolean created = Document.MIME_TYPE_DIR.equals(mimeType) ? target.mkdir() : target.createNewFile();
            if (!created) throw new FileNotFoundException("Cannot create " + target);
        } catch (IOException error) {
            throw new FileNotFoundException(error.getMessage());
        }
        return target.getAbsolutePath();
    }

    @Override
    public String renameDocument(String documentId, String displayName) throws FileNotFoundException {
        File file = fileFor(documentId);
        File target = new File(file.getParentFile(), displayName.replaceAll("[\\\\/]", "_"));
        if (!file.renameTo(target)) throw new FileNotFoundException("Cannot rename " + file);
        return target.getAbsolutePath();
    }

    @Override
    public void deleteDocument(String documentId) throws FileNotFoundException {
        File file = fileFor(documentId);
        if (file.equals(baseDir())) throw new FileNotFoundException("The root folder cannot be deleted");
        Installer.deleteRecursive(file);
    }

    @Override
    public boolean isChildDocument(String parentDocumentId, String documentId) {
        return documentId.startsWith(parentDocumentId + File.separator);
    }

    @Override
    public String getDocumentType(String documentId) throws FileNotFoundException {
        return mimeOf(fileFor(documentId));
    }

    private static String mimeOf(File file) {
        if (file.isDirectory()) return Document.MIME_TYPE_DIR;
        String name = file.getName();
        int dot = name.lastIndexOf('.');
        if (dot >= 0) {
            String extension = name.substring(dot + 1).toLowerCase(Locale.ROOT);
            if (extension.equals("jsonl")) return "application/jsonl";
            String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension);
            if (mime != null) return mime;
        }
        return "application/octet-stream";
    }

    private void addRow(MatrixCursor result, File file) {
        int flags = 0;
        if (file.isDirectory()) {
            if (file.canWrite()) flags |= Document.FLAG_DIR_SUPPORTS_CREATE;
        } else if (file.canWrite()) {
            flags |= Document.FLAG_SUPPORTS_WRITE;
        }
        if (!file.equals(baseDir()) && file.getParentFile() != null && file.getParentFile().canWrite()) {
            flags |= Document.FLAG_SUPPORTS_DELETE | Document.FLAG_SUPPORTS_RENAME;
        }
        String mime = mimeOf(file);
        MatrixCursor.RowBuilder row = result.newRow();
        row.add(Document.COLUMN_DOCUMENT_ID, file.getAbsolutePath());
        row.add(Document.COLUMN_DISPLAY_NAME, file.equals(baseDir()) ? getContext().getString(R.string.app_name) : file.getName());
        row.add(Document.COLUMN_SIZE, file.isDirectory() ? null : file.length());
        row.add(Document.COLUMN_MIME_TYPE, mime);
        row.add(Document.COLUMN_LAST_MODIFIED, file.lastModified());
        row.add(Document.COLUMN_FLAGS, flags);
    }
}
