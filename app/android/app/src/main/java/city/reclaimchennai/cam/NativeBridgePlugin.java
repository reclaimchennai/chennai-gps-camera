package city.reclaimchennai.cam;

import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.location.Address;
import android.location.Geocoder;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import androidx.core.content.FileProvider;

import android.Manifest;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

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
@CapacitorPlugin(
    name = "NativeBridge",
    permissions = {
        @Permission(alias = "camera", strings = { Manifest.permission.CAMERA }),
        @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }),
        @Permission(alias = "location", strings = {
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
        }),
        @Permission(alias = "storage", strings = {
            Manifest.permission.WRITE_EXTERNAL_STORAGE
        })
    }
)
public class NativeBridgePlugin extends Plugin {

    /** Permission states only — never prompts. The web layer uses this to
     *  decide whether to show the first-run "Enable camera" gate. */
    @PluginMethod
    public void checkMediaPermissions(PluginCall call) {
        resolvePermissionStates(call);
    }

    /**
     * First-run fix: request the Android runtime permissions NATIVELY,
     * before the WebView ever calls getUserMedia. When getUserMedia fires
     * while the OS permission dialog is still pending, the WebView caches
     * a denial for the page's lifetime — the camera then stays black until
     * the app restarts, no matter how often JS retries. Granting first
     * makes the WebView's own permission check pass immediately.
     */
    @PluginMethod
    public void ensureMediaPermissions(PluginCall call) {
        if (getPermissionState("camera") == PermissionState.GRANTED
                && getPermissionState("microphone") == PermissionState.GRANTED
                && getPermissionState("location") == PermissionState.GRANTED) {
            resolvePermissionStates(call);
            return;
        }
        String[] aliases = Build.VERSION.SDK_INT < 29
            ? new String[] { "camera", "microphone", "location", "storage" }
            : new String[] { "camera", "microphone", "location" };
        requestPermissionForAliases(aliases, call, "mediaPermsCallback");
    }

    /**
     * Step 1 of the split first-run flow: camera + microphone ONLY. The
     * combined 3-permission request crashed some devices at its tail end
     * — smaller atomic steps survive: even if the app dies between steps,
     * the next launch's state check resumes exactly where it left off.
     */
    @PluginMethod
    public void requestCameraPermissions(PluginCall call) {
        if (getPermissionState("camera") == PermissionState.GRANTED
                && getPermissionState("microphone") == PermissionState.GRANTED) {
            resolvePermissionStates(call);
            return;
        }
        String[] aliases = Build.VERSION.SDK_INT < 29
            ? new String[] { "camera", "microphone", "storage" }
            : new String[] { "camera", "microphone" };
        requestPermissionForAliases(aliases, call, "mediaPermsCallback");
    }

    /** Step 2, requested solo once the camera is already up and stable. */
    @PluginMethod
    public void requestLocationPermission(PluginCall call) {
        if (getPermissionState("location") == PermissionState.GRANTED) {
            resolvePermissionStates(call);
            return;
        }
        requestPermissionForAliases(
            new String[] { "location" }, call, "mediaPermsCallback");
    }

    /**
     * Location via CLASSIC ActivityCompat — no Capacitor launcher, no
     * PluginCall held across the dialog, no WebView geolocation callback.
     * Resolves immediately; the grant lands as a "gpscamLocationGranted"
     * window event from MainActivity.onRequestPermissionsResult. This
     * replaced the launcher-based path after field crashes the moment
     * location was granted.
     */
    @PluginMethod
    public void requestLocationNative(PluginCall call) {
        try {
            androidx.core.app.ActivityCompat.requestPermissions(
                getActivity(),
                new String[] {
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION
                },
                MainActivity.REQ_LOCATION
            );
        } catch (Exception ignored) {
            // state re-checked on next boot regardless
        }
        JSObject out = new JSObject();
        out.put("requested", true);
        call.resolve(out);
    }

    @PermissionCallback
    private void mediaPermsCallback(PluginCall call) {
        try {
            resolvePermissionStates(call);
        } catch (Exception e) {
            // never let a result-handling surprise take the process down
            call.resolve(new JSObject());
        }
    }

    private void resolvePermissionStates(PluginCall call) {
        JSObject out = new JSObject();
        out.put("camera", getPermissionState("camera") == PermissionState.GRANTED);
        out.put("microphone", getPermissionState("microphone") == PermissionState.GRANTED);
        out.put("location", getPermissionState("location") == PermissionState.GRANTED);
        call.resolve(out);
    }

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

    /** Installed APK version — shown in About so update state is
     *  verifiable at a glance. */
    @PluginMethod
    public void getAppInfo(PluginCall call) {
        JSObject out = new JSObject();
        try {
            android.content.pm.PackageInfo pi = getContext()
                .getPackageManager()
                .getPackageInfo(getContext().getPackageName(), 0);
            out.put("ok", true);
            out.put("versionName", pi.versionName);
            out.put("versionCode",
                Build.VERSION.SDK_INT >= 28
                    ? pi.getLongVersionCode()
                    : pi.versionCode);
        } catch (Exception e) {
            out.put("ok", false);
        }
        call.resolve(out);
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

    // ---- streamed native share (Android share sheet) --------------------
    // A WebView's navigator.share() cannot attach files, so shares fell
    // back to a silent re-save. This writes the file to the app cache in
    // chunks (bounded memory) then fires ACTION_SEND via the FileProvider.

    private static class PendingShare {
        FileOutputStream stream;
        File file;
        String mime;
    }

    private final Map<String, PendingShare> shares = new HashMap<>();

    @PluginMethod
    public void shareBegin(PluginCall call) {
        final String filename = call.getString("filename", "gpscam.bin");
        final String mime = call.getString("mime", "application/octet-stream");
        JSObject out = new JSObject();
        try {
            File dir = new File(getContext().getCacheDir(), "share");
            if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("mkdir");
            PendingShare ps = new PendingShare();
            ps.mime = mime;
            ps.file = new File(dir, filename);
            ps.stream = new FileOutputStream(ps.file);
            String id = UUID.randomUUID().toString();
            synchronized (shares) {
                shares.put(id, ps);
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
    public void shareChunk(PluginCall call) {
        final String id = call.getString("id", "");
        final String base64 = call.getString("base64", "");
        JSObject out = new JSObject();
        PendingShare ps;
        synchronized (shares) {
            ps = shares.get(id);
        }
        if (ps == null) {
            out.put("ok", false);
            call.resolve(out);
            return;
        }
        try {
            synchronized (ps) {
                ps.stream.write(Base64.decode(base64, Base64.DEFAULT));
            }
            out.put("ok", true);
            call.resolve(out);
        } catch (Exception e) {
            out.put("ok", false);
            call.resolve(out);
        }
    }

    @PluginMethod
    public void shareEnd(PluginCall call) {
        final String id = call.getString("id", "");
        final String text = call.getString("text", "");
        final Context ctx = getContext();
        JSObject out = new JSObject();
        PendingShare ps;
        synchronized (shares) {
            ps = shares.remove(id);
        }
        if (ps == null) {
            out.put("ok", false);
            call.resolve(out);
            return;
        }
        try {
            ps.stream.close();
            Uri uri = FileProvider.getUriForFile(
                ctx, ctx.getPackageName() + ".fileprovider", ps.file);
            Intent send = new Intent(Intent.ACTION_SEND);
            send.setType(ps.mime);
            send.putExtra(Intent.EXTRA_STREAM, uri);
            if (text != null && !text.isEmpty()) {
                send.putExtra(Intent.EXTRA_TEXT, text);
            }
            send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            Intent chooser = Intent.createChooser(send, "Share");
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(chooser);
            out.put("ok", true);
            call.resolve(out);
        } catch (Exception e) {
            out.put("ok", false);
            call.resolve(out);
        }
    }
}
