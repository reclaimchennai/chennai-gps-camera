package city.reclaimchennai.cam;

import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.Address;
import android.location.Geocoder;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
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
 *  - reverseGeocode: android.location.Geocoder in the locale the caller
 *    asks for ("lang": en/ta/hi), defaulting to English rather than the
 *    device language — the watermark's language is a per-card setting, not
 *    whatever the phone happens to be set to. Runs off the bridge thread
 *    (the sync Geocoder call can block on a network round-trip).
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
     * Route the volume rocker to the shutter, or leave it to the system.
     *
     * Only the live viewfinder asks for it. Everywhere else — the gallery
     * above all, where the rocker has to set playback volume for a recorded
     * video — the keys must behave normally.
     */
    /** Back pressed at the camera root: hand the screen back to Android. */
    @PluginMethod
    public void minimizeApp(PluginCall call) {
        try {
            getActivity().moveTaskToBack(true);
        } catch (Exception ignored) {
            // worst case the app stays up — never crash on a back press
        }
        call.resolve();
    }

    /**
     * Shutter feedback, straight to the phone's vibrator.
     *
     * navigator.vibrate() exists in the WebView but does not reliably fire
     * there — the owner reported no feedback at all with the web API and
     * the VIBRATE permission in place. Going through the system service
     * removes the doubt. `pattern` is the same shape the web API takes:
     * alternating wait/vibrate milliseconds.
     */

    /** Held focus, so it can be handed back on the way out. */
    private AudioFocusRequest audioFocusRequest = null;
    private boolean holdingAudioFocus = false;

    /**
     * Take or hand back Android audio focus around microphone use.
     *
     * Opening a mic pauses whatever the user was listening to, but
     * RELEASING the mic does not resume it — a media app only resumes when
     * the focus holder abandons focus and it receives AUDIOFOCUS_GAIN. We
     * never requested focus, so we never abandoned it, and music stayed
     * dead after leaving the app.
     *
     * TRANSIENT is deliberate: it tells the other app this is a short
     * interruption to come back from, which is exactly what metering the
     * noise level or recording a clip is.
     */
    @PluginMethod
    public void audioFocus(PluginCall call) {
        final boolean hold = Boolean.TRUE.equals(call.getBoolean("hold", false));
        JSObject out = new JSObject();
        try {
            AudioManager am =
                (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
            if (am == null) {
                out.put("ok", false);
                call.resolve(out);
                return;
            }
            if (hold) {
                if (!holdingAudioFocus) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        AudioAttributes attrs = new AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                            .build();
                        audioFocusRequest = new AudioFocusRequest.Builder(
                                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                            .setAudioAttributes(attrs)
                            .setWillPauseWhenDucked(true)
                            .build();
                        am.requestAudioFocus(audioFocusRequest);
                    } else {
                        am.requestAudioFocus(null,
                            AudioManager.STREAM_MUSIC,
                            AudioManager.AUDIOFOCUS_GAIN_TRANSIENT);
                    }
                    holdingAudioFocus = true;
                }
            } else if (holdingAudioFocus) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                        && audioFocusRequest != null) {
                    am.abandonAudioFocusRequest(audioFocusRequest);
                    audioFocusRequest = null;
                } else {
                    am.abandonAudioFocus(null);
                }
                holdingAudioFocus = false;
            }
            out.put("ok", true);
            out.put("holding", holdingAudioFocus);
            call.resolve(out);
        } catch (Exception e) {
            out.put("ok", false);
            call.resolve(out);
        }
    }

    @Override
    protected void handleOnPause() {
        // leaving the app must hand the music back even if the web layer
        // never got its visibilitychange in
        try {
            if (holdingAudioFocus) {
                AudioManager am = (AudioManager)
                    getContext().getSystemService(Context.AUDIO_SERVICE);
                if (am != null) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                            && audioFocusRequest != null) {
                        am.abandonAudioFocusRequest(audioFocusRequest);
                        audioFocusRequest = null;
                    } else {
                        am.abandonAudioFocus(null);
                    }
                }
                holdingAudioFocus = false;
            }
        } catch (Exception ignored) {
            // never let this stop the activity pausing
        }
        super.handleOnPause();
    }

    @PluginMethod
    public void vibrate(PluginCall call) {
        try {
            com.getcapacitor.JSArray arr = call.getArray("pattern");
            long[] pattern;
            if (arr != null && arr.length() > 0) {
                pattern = new long[arr.length()];
                for (int i = 0; i < arr.length(); i++) {
                    pattern[i] = ((Number) arr.get(i)).longValue();
                }
            } else {
                pattern = new long[] { 0, 35 };
            }
            android.os.Vibrator v;
            if (Build.VERSION.SDK_INT >= 31) {
                android.os.VibratorManager vm = (android.os.VibratorManager)
                    getContext().getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
                v = vm != null ? vm.getDefaultVibrator() : null;
            } else {
                v = (android.os.Vibrator)
                    getContext().getSystemService(Context.VIBRATOR_SERVICE);
            }
            if (v != null && v.hasVibrator()) {
                // -1: play the pattern once, never repeat
                v.vibrate(android.os.VibrationEffect.createWaveform(pattern, -1));
            }
        } catch (Exception ignored) {
            // no vibrator, or the user has haptics off — never fail a capture
        }
        call.resolve();
    }

    @PluginMethod
    public void setShutterKeys(PluginCall call) {
        MainActivity.setShutterKeys(call.getBoolean("enabled", false));
        call.resolve();
    }

    /**
     * Mock-location disclosure (NOT a restriction — spoofing stays
     * allowed, it just gets labelled). Reads the last known fix from both
     * providers and reports Android's own isMock()/isFromMockProvider()
     * flag, so a photo taken while a fake-GPS app is feeding the system
     * can be stamped honestly instead of silently passing as genuine.
     */
    @PluginMethod
    public void checkMockLocation(PluginCall call) {
        JSObject out = new JSObject();
        boolean mock = false;
        try {
            if (androidx.core.content.ContextCompat.checkSelfPermission(
                    getContext(), Manifest.permission.ACCESS_FINE_LOCATION)
                == PackageManager.PERMISSION_GRANTED) {
                android.location.LocationManager lm =
                    (android.location.LocationManager)
                        getContext().getSystemService(Context.LOCATION_SERVICE);
                if (lm != null) {
                    String[] providers = {
                        android.location.LocationManager.GPS_PROVIDER,
                        android.location.LocationManager.NETWORK_PROVIDER,
                        android.location.LocationManager.FUSED_PROVIDER
                    };
                    for (String p : providers) {
                        try {
                            android.location.Location loc = lm.getLastKnownLocation(p);
                            if (loc == null) continue;
                            boolean isMock = Build.VERSION.SDK_INT >= 31
                                ? loc.isMock()
                                : loc.isFromMockProvider();
                            if (isMock) {
                                mock = true;
                                break;
                            }
                        } catch (SecurityException | IllegalArgumentException ignored) {
                            // provider unavailable on this device
                        }
                    }
                }
            }
        } catch (Exception ignored) {
            // treat failures as "unknown" (not mock) — never block a capture
        }
        out.put("mock", mock);
        call.resolve(out);
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
        final String lang = call.getString("lang", "en");
        final Context ctx = getContext();
        new Thread(() -> {
            JSObject out = new JSObject();
            try {
                if (!Geocoder.isPresent()) {
                    out.put("ok", false);
                    call.resolve(out);
                    return;
                }
                Locale locale;
                if ("ta".equals(lang)) locale = new Locale("ta", "IN");
                else if ("hi".equals(lang)) locale = new Locale("hi", "IN");
                else locale = Locale.ENGLISH;
                Geocoder geocoder = new Geocoder(ctx, locale);
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
