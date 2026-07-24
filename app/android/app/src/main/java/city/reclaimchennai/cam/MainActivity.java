package city.reclaimchennai.cam;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.view.KeyEvent;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;

public class MainActivity extends BridgeActivity {

    /** Classic ActivityCompat request code for the solo location step. */
    public static final int REQ_LOCATION = 9107;

    /**
     * Volume buttons as the shutter, like every camera app. Both keys are
     * consumed while the app is foreground (a camera app doesn't play
     * media, so hijacking volume is the expected trade); only the first
     * press of a hold fires — auto-repeat is swallowed. The web layer
     * decides what "shutter" means (photo vs start/stop recording).
     * NOTE: the power button cannot be used — Android reserves it for the
     * system (screen off / device-wide double-press camera shortcut) and
     * never delivers it to apps.
     */
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_VOLUME_DOWN
                || keyCode == KeyEvent.KEYCODE_VOLUME_UP) {
            if (event.getRepeatCount() == 0 && bridge != null) {
                try {
                    bridge.triggerWindowJSEvent("gpscamShutterKey", "{}");
                } catch (Exception ignored) {
                    // never let the relay crash a key press
                }
            }
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public boolean onKeyUp(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_VOLUME_DOWN
                || keyCode == KeyEvent.KEYCODE_VOLUME_UP) {
            return true; // consumed on the way down
        }
        return super.onKeyUp(keyCode, event);
    }

    private void wipeRestoredServiceWorkers() {
        try {
            java.io.File webviewData =
                new java.io.File(getApplicationInfo().dataDir, "app_webview");
            java.io.File[] profiles = webviewData.listFiles();
            if (profiles == null) return;
            for (java.io.File profile : profiles) {
                deleteRecursively(new java.io.File(profile, "Service Worker"));
            }
        } catch (Exception ignored) {
            // best effort — the web layer also unregisters on boot
        }
    }

    private static void deleteRecursively(java.io.File f) {
        if (f == null || !f.exists()) return;
        java.io.File[] children = f.listFiles();
        if (children != null) {
            for (java.io.File c : children) deleteRecursively(c);
        }
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // BEFORE the WebView exists: wipe any service-worker state that
        // Android Auto-Backup restored from an older version. A restored
        // SW controls the very first page load and reloads the WebView
        // seconds into a fresh install (the "flicker") — crashing any
        // permission flow in flight. The native app never registers a SW;
        // only restored ones ever existed. Deleting the directory while
        // the WebView is not yet running is safe and Chromium treats the
        // absence as "no registrations".
        wipeRestoredServiceWorkers();
        registerPlugin(NativeBridgePlugin.class);
        super.onCreate(savedInstanceState);
        setupBackNavigation();
        setupDeterministicPermissionGrants();
        // NOTE: deliberately NO permission request here. First-run
        // permissions are requested by the web layer's explicit
        // "Enable camera" gate (single, user-initiated flow). Boot-time
        // requests used to race the WebView's own getUserMedia prompt
        // relay and Capacitor's plugin launcher (capacitor#6881), leaving
        // the WebView with a cached denial → black camera until restart.
    }

    /**
     * Deterministic WebView permission grants: when the app already HOLDS
     * the Android camera/mic permissions, answer the WebView's
     * getUserMedia permission request immediately and affirmatively —
     * never re-entering Capacitor's async request flow, whose race
     * (grant()/deny() double-call, capacitor#6881) is what poisoned
     * first-run sessions. When permissions are NOT yet held, defer to
     * Capacitor's default handling (the web layer's gate ensures this
     * path is never hit in practice).
     */
    private void setupDeterministicPermissionGrants() {
        WebView wv = bridge.getWebView();
        if (wv == null) return;
        wv.setWebChromeClient(new BridgeWebChromeClient(bridge) {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                boolean allHeld = true;
                for (String res : request.getResources()) {
                    if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(res)
                        && ContextCompat.checkSelfPermission(
                                MainActivity.this, Manifest.permission.CAMERA)
                            != PackageManager.PERMISSION_GRANTED) {
                        allHeld = false;
                    }
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(res)
                        && ContextCompat.checkSelfPermission(
                                MainActivity.this, Manifest.permission.RECORD_AUDIO)
                            != PackageManager.PERMISSION_GRANTED) {
                        allHeld = false;
                    }
                }
                if (allHeld) {
                    final String[] resources = request.getResources();
                    runOnUiThread(() -> {
                        try {
                            request.grant(resources);
                        } catch (Exception ignored) {
                            // request already answered/cancelled by the
                            // WebView (capacitor#6881 class) — never crash
                        }
                    });
                } else {
                    try {
                        super.onPermissionRequest(request);
                    } catch (Exception ignored) {
                        // same guard for Capacitor's own path
                    }
                }
            }

            /**
             * Geolocation relay, made DETERMINISTIC: answer from the
             * currently-held permission state, immediately, exactly once —
             * and never launch a native request from here. Capacitor's
             * default relay requests permissions and can invoke this
             * callback twice / after teardown, which is a hard WebView
             * crash — the "app quits the moment location is granted"
             * field report. All location granting goes through the
             * ActivityCompat flow below instead.
             */
            @Override
            public void onGeolocationPermissionsShowPrompt(
                String origin, GeolocationPermissions.Callback callback) {
                try {
                    boolean held =
                        ContextCompat.checkSelfPermission(
                                MainActivity.this,
                                Manifest.permission.ACCESS_FINE_LOCATION)
                            == PackageManager.PERMISSION_GRANTED
                        || ContextCompat.checkSelfPermission(
                                MainActivity.this,
                                Manifest.permission.ACCESS_COARSE_LOCATION)
                            == PackageManager.PERMISSION_GRANTED;
                    callback.invoke(origin, held, false);
                } catch (Exception ignored) {
                    // never let the relay take the process down
                }
            }
        });
    }

    /**
     * Result of the classic location request (fired by the plugin's
     * requestLocationNative). No Capacitor launcher, no held PluginCall,
     * no WebView callback — just a window event the web layer listens
     * for. Nothing here can double-fire into WebView internals.
     */
    @Override
    public void onRequestPermissionsResult(
        int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_LOCATION) return;
        try {
            boolean granted = false;
            for (int r : grantResults) {
                if (r == PackageManager.PERMISSION_GRANTED) granted = true;
            }
            if (granted && bridge != null) {
                bridge.triggerWindowJSEvent("gpscamLocationGranted", "{}");
            }
        } catch (Exception ignored) {
            // web layer re-checks state on next boot regardless
        }
    }

    /**
     * The app is a hash-routed SPA: every in-app screen is a real WebView
     * history entry. Walk that history on back gestures; only leave the
     * app from the camera (root) screen. Registered through the androidx
     * dispatcher so it also holds under Android 13+ predictive back —
     * a plain onBackPressed() override is skipped there.
     */
    private void setupBackNavigation() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView wv = bridge.getWebView();
                if (wv != null && wv.canGoBack()) {
                    wv.goBack();
                } else {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                    setEnabled(true);
                }
            }
        });
    }
}
