package city.reclaimchennai.cam;

import android.content.ContentValues;
import android.content.Context;
import android.location.Address;
import android.location.Geocoder;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

/**
 * Native services the WebView cannot provide:
 *  - reverseGeocode: android.location.Geocoder with Locale.ENGLISH, so
 *    addresses come back human-readable in English regardless of the
 *    device language. Runs off the bridge thread (the sync Geocoder call
 *    can block on a network round-trip).
 *  - saveToGallery (begin/chunk/end): streamed MediaStore insert into
 *    DCIM/GPS Camera. Streaming matters: a single-message base64 of a
 *    full-sensor photo took seconds to cross the JS bridge, and a long
 *    video could OOM it. Chunks bound both memory and latency.
 */
@CapacitorPlugin(name = "NativeBridge")
public class NativeBridgePlugin extends Plugin {

    @PluginMethod
    public void reverseGeocode(PluginCall call) {
        final double lat = call.getDouble("lat", 0.0);
        final double lng = call.getDouble("lng", 0.0);
        final Context ctx = getContext();
        new Thread(() -> {
            JSObject out = new JSObject();
            try {
                if (!Geocoder.isPresent()) {
                    out.put("ok", false);
                    call.resolve(out);
                    return;
                }
                Geocoder geocoder = new Geocoder(ctx, Locale.ENGLISH);
                @SuppressWarnings("deprecation")
                List<Address> results = geocoder.getFromLocation(lat, lng, 1);
                if (results == null || results.isEmpty()) {
                    out.put("ok", false);
                    call.resolve(out);
                    return;
                }
                Address a = results.get(0);
                StringBuilder line = new StringBuilder();
                for (int i = 0; i <= a.getMaxAddressLineIndex(); i++) {
                    if (line.length() > 0) line.append(", ");
                    line.append(a.getAddressLine(i));
                }
                out.put("ok", line.length() > 0);
                out.put("addressLine", line.toString());
                if (a.getSubLocality() != null) out.put("subLocality", a.getSubLocality());
                if (a.getLocality() != null) out.put("locality", a.getLocality());
                if (a.getAdminArea() != null) out.put("adminArea", a.getAdminArea());
                call.resolve(out);
            } catch (Exception e) {
                out.put("ok", false);
                call.resolve(out);
            }
        }).start();
    }

    // ---- streamed gallery save -------------------------------------------

    private static class PendingSave {
        OutputStream stream;
        Uri mediaStoreItem; // API 29+ path
        File legacyFile;    // API < 29 path
        String mime;
    }

    private final Map<String, PendingSave> saves = new HashMap<>();

    @PluginMethod
    public void saveToGalleryBegin(PluginCall call) {
        final String filename = call.getString("filename", "gpscam.bin");
        final String mime = call.getString("mime", "application/octet-stream");
        final Context ctx = getContext();
        JSObject out = new JSObject();
        try {
            PendingSave ps = new PendingSave();
            ps.mime = mime;
            boolean isVideo = mime.startsWith("video/");
            if (Build.VERSION.SDK_INT >= 29) {
                Uri collection = isVideo
                    ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI
                    : MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
                values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                values.put(MediaStore.MediaColumns.RELATIVE_PATH,
                    Environment.DIRECTORY_DCIM + "/GPS Camera");
                values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                ps.mediaStoreItem = ctx.getContentResolver().insert(collection, values);
                if (ps.mediaStoreItem == null) throw new IllegalStateException("insert failed");
                ps.stream = ctx.getContentResolver().openOutputStream(ps.mediaStoreItem);
                if (ps.stream == null) throw new IllegalStateException("no stream");
            } else {
                File dir = new File(
                    Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DCIM),
                    "GPS Camera");
                if (!dir.exists() && !dir.mkdirs())
                    throw new IllegalStateException("mkdir failed");
                ps.legacyFile = new File(dir, filename);
                ps.stream = new FileOutputStream(ps.legacyFile);
            }
            String id = UUID.randomUUID().toString();
            synchronized (saves) {
                saves.put(id, ps);
            }
            out.put("ok", true);
            out.put("id", id);
            call.resolve(out);
        } catch (Exception e) {
            out.put("ok", false);
            call.resolve(out);
        }
    }

    @PluginMethod
    public void saveToGalleryChunk(PluginCall call) {
        final String id = call.getString("id", "");
        final String base64 = call.getString("base64", "");
        JSObject out = new JSObject();
        PendingSave ps;
        synchronized (saves) {
            ps = saves.get(id);
        }
        if (ps == null) {
            out.put("ok", false);
            call.resolve(out);
            return;
        }
        try {
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            synchronized (ps) {
                ps.stream.write(bytes);
            }
            out.put("ok", true);
            call.resolve(out);
        } catch (Exception e) {
            abort(id, ps);
            out.put("ok", false);
            call.resolve(out);
        }
    }

    @PluginMethod
    public void saveToGalleryEnd(PluginCall call) {
        final String id = call.getString("id", "");
        final Context ctx = getContext();
        JSObject out = new JSObject();
        PendingSave ps;
        synchronized (saves) {
            ps = saves.remove(id);
        }
        if (ps == null) {
            out.put("ok", false);
            call.resolve(out);
            return;
        }
        try {
            ps.stream.close();
            if (ps.mediaStoreItem != null) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.IS_PENDING, 0);
                ctx.getContentResolver().update(ps.mediaStoreItem, values, null, null);
            } else if (ps.legacyFile != null) {
                MediaScannerConnection.scanFile(
                    ctx,
                    new String[] { ps.legacyFile.getAbsolutePath() },
                    new String[] { ps.mime },
                    null);
            }
            out.put("ok", true);
            call.resolve(out);
        } catch (Exception e) {
            out.put("ok", false);
            call.resolve(out);
        }
    }

    @PluginMethod
    public void saveToGalleryAbort(PluginCall call) {
        final String id = call.getString("id", "");
        PendingSave ps;
        synchronized (saves) {
            ps = saves.remove(id);
        }
        if (ps != null) abort(id, ps);
        JSObject out = new JSObject();
        out.put("ok", true);
        call.resolve(out);
    }

    private void abort(String id, PendingSave ps) {
        synchronized (saves) {
            saves.remove(id);
        }
        try {
            ps.stream.close();
        } catch (Exception ignored) {
        }
        try {
            if (ps.mediaStoreItem != null) {
                getContext().getContentResolver().delete(ps.mediaStoreItem, null, null);
            } else if (ps.legacyFile != null && ps.legacyFile.exists()) {
                //noinspection ResultOfMethodCallIgnored
                ps.legacyFile.delete();
            }
        } catch (Exception ignored) {
        }
    }
}
