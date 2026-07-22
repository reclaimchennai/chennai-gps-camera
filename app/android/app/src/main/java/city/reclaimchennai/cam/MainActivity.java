package city.reclaimchennai.cam;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
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
                    runOnUiThread(() -> request.grant(resources));
                } else {
                    super.onPermissionRequest(request);
                }
            }
        });
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
