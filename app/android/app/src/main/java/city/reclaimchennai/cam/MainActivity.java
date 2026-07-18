package city.reclaimchennai.cam;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(NativeBridgePlugin.class);
        super.onCreate(savedInstanceState);
        setupBackNavigation();
        requestCorePermissions();
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

    /**
     * Fresh-install race: the web app boots (and starts camera + GPS)
     * while the permission dialog is still up, so its first attempts
     * fail. Once the user answers, reload the WebView so everything
     * starts cleanly with the permissions in hand. Upgrades never hit
     * this because their grants carry over.
     */
    @Override
    public void onRequestPermissionsResult(
        int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == 9001) {
            boolean anyGranted = false;
            for (int r : grantResults) {
                if (r == PackageManager.PERMISSION_GRANTED) anyGranted = true;
            }
            if (anyGranted && bridge != null && bridge.getWebView() != null) {
                bridge.getWebView().post(() -> bridge.getWebView().reload());
            }
        }
    }

    /**
     * A camera app is useless without these — ask up front instead of
     * relying on the WebView to relay each getUserMedia / geolocation
     * prompt mid-capture.
     */
    private void requestCorePermissions() {
        String[] wanted = new String[] {
            Manifest.permission.CAMERA,
            Manifest.permission.RECORD_AUDIO,
            Manifest.permission.ACCESS_FINE_LOCATION,
        };
        List<String> missing = new ArrayList<>();
        for (String p : wanted) {
            if (ContextCompat.checkSelfPermission(this, p) != PackageManager.PERMISSION_GRANTED) {
                missing.add(p);
            }
        }
        if (Build.VERSION.SDK_INT < 29
            && ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE)
                != PackageManager.PERMISSION_GRANTED) {
            missing.add(Manifest.permission.WRITE_EXTERNAL_STORAGE);
        }
        if (!missing.isEmpty()) {
            ActivityCompat.requestPermissions(this, missing.toArray(new String[0]), 9001);
        }
    }
}
