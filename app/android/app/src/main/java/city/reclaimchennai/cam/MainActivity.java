package city.reclaimchennai.cam;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebView;

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
        // Without this the WebView refuses to start the viewfinder
        // <video> (and gallery playback) until a tap lands — users saw a
        // stuck play-button poster instead of the live camera.
        bridge.getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
        requestCorePermissions();
    }

    /**
     * The app is a hash-routed SPA: every in-app screen is a real WebView
     * history entry. Walk that history on back gestures; only leave the
     * app from the camera (root) screen.
     */
    @Override
    public void onBackPressed() {
        WebView wv = bridge.getWebView();
        if (wv != null && wv.canGoBack()) {
            wv.goBack();
        } else {
            super.onBackPressed();
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
