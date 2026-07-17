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
import java.util.List;
import java.util.Locale;

/**
 * Native services the WebView cannot provide:
 *  - reverseGeocode: android.location.Geocoder with Locale.ENGLISH, so
 *    addresses come back human-readable in English regardless of the
 *    device language. Runs off the bridge thread (the sync Geocoder call
 *    can block on a network round-trip).
 *  - saveToGallery: MediaStore insert into DCIM/GPS Camera. An anchor
 *    download of a blob: URL is a silent no-op inside a WebView, so the
 *    web side routes captured files through here instead.
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

    @PluginMethod
    public void saveToGallery(PluginCall call) {
        final String filename = call.getString("filename", "gpscam.bin");
        final String mime = call.getString("mime", "application/octet-stream");
        final String base64 = call.getString("base64", "");
        final Context ctx = getContext();
        new Thread(() -> {
            JSObject out = new JSObject();
            try {
                byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
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
                    Uri item = ctx.getContentResolver().insert(collection, values);
                    if (item == null) throw new IllegalStateException("insert failed");
                    try (OutputStream os = ctx.getContentResolver().openOutputStream(item)) {
                        if (os == null) throw new IllegalStateException("no stream");
                        os.write(bytes);
                    }
                    values.clear();
                    values.put(MediaStore.MediaColumns.IS_PENDING, 0);
                    ctx.getContentResolver().update(item, values, null, null);
                } else {
                    File dir = new File(
                        Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DCIM),
                        "GPS Camera");
                    if (!dir.exists() && !dir.mkdirs())
                        throw new IllegalStateException("mkdir failed");
                    File f = new File(dir, filename);
                    try (FileOutputStream fos = new FileOutputStream(f)) {
                        fos.write(bytes);
                    }
                    MediaScannerConnection.scanFile(
                        ctx, new String[] { f.getAbsolutePath() }, new String[] { mime }, null);
                }
                out.put("ok", true);
                call.resolve(out);
            } catch (Exception e) {
                out.put("ok", false);
                call.resolve(out);
            }
        }).start();
    }
}
