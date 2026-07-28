package city.reclaimchennai.cam;

import android.Manifest;
import android.graphics.Color;
import android.util.Range;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;

import androidx.annotation.NonNull;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraInfo;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.FocusMeteringAction;
import androidx.camera.core.ImageCapture;
import androidx.camera.core.ImageCaptureException;
import androidx.camera.core.MeteringPoint;
import androidx.camera.core.MeteringPointFactory;
import androidx.camera.core.Preview;
import androidx.camera.core.ZoomState;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import androidx.lifecycle.LifecycleOwner;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.util.concurrent.ExecutionException;

/**
 * The camera, natively.
 *
 * WHY THIS EXISTS. The app has always drawn its viewfinder through
 * getUserMedia inside the WebView, and that layer hands us a deliberately
 * narrow slice of the hardware. Measured on real devices via the app's own
 * capability report:
 *   - Pixel 9a and Motorola A024: ONE camera offered, "Zoom: not offered".
 *     The ultra-wide physically exists and is unreachable.
 *   - Galaxy S25+: three physical cameras, but no zoom range either, so
 *     crossing 0.6x->1x means closing one camera and opening another —
 *     the visible hitch next to the stock camera app.
 *   - Every device tested: "Aim (pointsOfInterest): not offered", which is
 *     why tap-to-focus had to be written as a contrast sweep in JavaScript.
 * CameraX exposes all of it: a continuous zoom ratio spanning the lenses
 * (the phone crosses between them itself, seamlessly), hardware metering
 * points for tap-to-focus, and a preview that starts with the app.
 *
 * HOW IT COMPOSITES. A PreviewView is inserted BEHIND the Capacitor
 * WebView, and the WebView is made transparent. The whole existing web UI
 * — watermark card, controls, gallery — keeps drawing exactly as it does
 * now, over a live native preview instead of a <video>. Nothing about the
 * app's layout changes.
 *
 * STATUS: preview, capabilities, zoom and focus are implemented here.
 * Photo capture returns full-resolution JPEG bytes. Video recording still
 * runs on the existing web path, so this plugin is behind a flag and the
 * two never hold the camera at the same time (Android allows only one).
 */
@CapacitorPlugin(
    name = "NativeCamera",
    permissions = {
        @Permission(alias = "camera", strings = { Manifest.permission.CAMERA })
    }
)
public class NativeCameraPlugin extends Plugin {

    private PreviewView previewView;
    private ProcessCameraProvider provider;
    private Camera camera;
    private ImageCapture imageCapture;
    private boolean running = false;

    /** Is the native camera available at all on this build/device? */
    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject out = new JSObject();
        out.put("available", true);
        call.resolve(out);
    }

    /**
     * Start the preview behind the WebView.
     *
     * The WebView is made transparent so the web UI floats over the native
     * surface. Both are children of the same content frame; the preview is
     * added at index 0 so it sits underneath.
     */
    @PluginMethod
    public void start(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                if (running) {
                    call.resolve();
                    return;
                }
                WebView web = getBridge().getWebView();
                ViewGroup parent = (ViewGroup) web.getParent();
                if (previewView == null) {
                    previewView = new PreviewView(getContext());
                    previewView.setLayoutParams(new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT));
                    // FIT_CENTER keeps the whole frame visible, matching how
                    // the web viewfinder letterboxes it today
                    previewView.setScaleType(PreviewView.ScaleType.FIT_CENTER);
                    // TextureView, not SurfaceView: a SurfaceView renders in
                    // its own hardware layer and will not reliably sit UNDER
                    // a translucent WebView. This is the whole compositing
                    // trick; do not "optimise" it back to PERFORMANCE.
                    previewView.setImplementationMode(
                        PreviewView.ImplementationMode.COMPATIBLE);
                }
                if (previewView.getParent() == null) {
                    parent.addView(previewView, 0);
                }
                web.setBackgroundColor(Color.TRANSPARENT);

                ProcessCameraProvider.getInstance(getContext()).addListener(() -> {
                    try {
                        provider = ProcessCameraProvider.getInstance(getContext()).get();
                        bindUseCases(call);
                    } catch (ExecutionException | InterruptedException e) {
                        call.reject("camera provider unavailable: " + e.getMessage());
                    }
                }, ContextCompat.getMainExecutor(getContext()));
            } catch (Exception e) {
                call.reject("start failed: " + e.getMessage());
            }
        });
    }

    private void bindUseCases(PluginCall call) {
        try {
            provider.unbindAll();
            Preview preview = new Preview.Builder().build();
            preview.setSurfaceProvider(previewView.getSurfaceProvider());
            imageCapture = new ImageCapture.Builder()
                .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                .build();
            camera = provider.bindToLifecycle(
                (LifecycleOwner) getActivity(),
                CameraSelector.DEFAULT_BACK_CAMERA,
                preview,
                imageCapture);
            running = true;
            call.resolve(capabilities());
        } catch (Exception e) {
            call.reject("bind failed: " + e.getMessage());
        }
    }

    /** Stop the preview and give the camera back. */
    @PluginMethod
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                if (provider != null) provider.unbindAll();
                if (previewView != null && previewView.getParent() != null) {
                    ((ViewGroup) previewView.getParent()).removeView(previewView);
                }
                WebView web = getBridge().getWebView();
                web.setBackgroundColor(Color.BLACK);
                running = false;
                call.resolve();
            } catch (Exception e) {
                call.reject("stop failed: " + e.getMessage());
            }
        });
    }

    /**
     * Put the preview exactly where the web layout's viewfinder is.
     *
     * The app letterboxes the picture inside .cam-video-box with the
     * watermark card anchored to its bottom and an opaque controls bar
     * below — a full-screen preview would sit behind all of it. The web
     * layer sends that rectangle in CSS pixels; convert with the display
     * density.
     */
    @PluginMethod
    public void setPreviewRect(PluginCall call) {
        final Double x = call.getDouble("x");
        final Double y = call.getDouble("y");
        final Double w = call.getDouble("width");
        final Double h = call.getDouble("height");
        if (x == null || y == null || w == null || h == null) {
            call.reject("rect required");
            return;
        }
        getActivity().runOnUiThread(() -> {
            if (previewView == null) {
                call.resolve();
                return;
            }
            float d = getContext().getResources().getDisplayMetrics().density;
            FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                Math.max(1, (int) (w * d)), Math.max(1, (int) (h * d)));
            lp.leftMargin = (int) (x * d);
            lp.topMargin = (int) (y * d);
            previewView.setLayoutParams(lp);
            previewView.requestLayout();
            call.resolve();
        });
    }

    /**
     * What the hardware actually offers — the numbers the WebView would not
     * give us. minZoom below 1 means this phone can reach its ultra-wide
     * through the zoom ratio alone, with no camera switch.
     */
    private JSObject capabilities() {
        JSObject out = new JSObject();
        if (camera == null) return out;
        CameraInfo info = camera.getCameraInfo();
        ZoomState z = info.getZoomState().getValue();
        if (z != null) {
            out.put("minZoom", z.getMinZoomRatio());
            out.put("maxZoom", z.getMaxZoomRatio());
            out.put("zoom", z.getZoomRatio());
        }
        out.put("hasFlash", info.hasFlashUnit());
        Range<Integer> ec = info.getExposureState().getExposureCompensationRange();
        out.put("exposureMin", ec.getLower());
        out.put("exposureMax", ec.getUpper());
        out.put("exposureStep",
            info.getExposureState().getExposureCompensationStep().floatValue());
        try {
            MeteringPointFactory factory = previewView != null
                ? previewView.getMeteringPointFactory()
                : null;
            if (factory != null) {
                MeteringPoint centre = factory.createPoint(
                    previewView.getWidth() / 2f, previewView.getHeight() / 2f);
                out.put("focusMetering", info.isFocusMeteringSupported(
                    new FocusMeteringAction.Builder(centre).build()));
            } else {
                out.put("focusMetering", false);
            }
        } catch (Exception ignored) {
            out.put("focusMetering", false);
        }
        return out;
    }

    @PluginMethod
    public void getCapabilities(PluginCall call) {
        call.resolve(capabilities());
    }

    /**
     * Continuous zoom across the phone's lenses. On hardware with an
     * ultra-wide this crosses below 1.0 and the camera stack switches
     * physical sensors internally — no stop, no reopen, no gap to hide.
     */
    @PluginMethod
    public void setZoom(PluginCall call) {
        Float ratio = call.getFloat("zoom");
        if (camera == null || ratio == null) {
            call.reject("camera not running");
            return;
        }
        camera.getCameraControl().setZoomRatio(ratio);
        call.resolve();
    }

    /**
     * Hardware tap-to-focus: a metering point at the tapped position,
     * normalised 0..1. This is what the WebView refused to accept, forcing
     * the JavaScript contrast sweep.
     */
    @PluginMethod
    public void focusAt(PluginCall call) {
        Float x = call.getFloat("x");
        Float y = call.getFloat("y");
        if (camera == null || x == null || y == null) {
            call.reject("camera not running");
            return;
        }
        getActivity().runOnUiThread(() -> {
            try {
                MeteringPointFactory factory =
                    previewView.getMeteringPointFactory();
                MeteringPoint point = factory.createPoint(
                    x * previewView.getWidth(), y * previewView.getHeight());
                FocusMeteringAction action =
                    new FocusMeteringAction.Builder(point,
                        FocusMeteringAction.FLAG_AF | FocusMeteringAction.FLAG_AE)
                        .setAutoCancelDuration(4, java.util.concurrent.TimeUnit.SECONDS)
                        .build();
                camera.getCameraControl().startFocusAndMetering(action);
                call.resolve();
            } catch (Exception e) {
                call.reject("focus failed: " + e.getMessage());
            }
        });
    }

    /** Torch, from the same control surface. */
    @PluginMethod
    public void setTorch(PluginCall call) {
        if (camera == null) {
            call.reject("camera not running");
            return;
        }
        camera.getCameraControl().enableTorch(Boolean.TRUE.equals(call.getBoolean("on")));
        call.resolve();
    }

    /** Full-resolution still, returned as base64 JPEG for the web layer to
     *  watermark exactly as it does today. */
    @PluginMethod
    public void capture(PluginCall call) {
        if (imageCapture == null) {
            call.reject("camera not running");
            return;
        }
        try {
            File out = File.createTempFile("shot", ".jpg", getContext().getCacheDir());
            ImageCapture.OutputFileOptions opts =
                new ImageCapture.OutputFileOptions.Builder(out).build();
            imageCapture.takePicture(opts,
                ContextCompat.getMainExecutor(getContext()),
                new ImageCapture.OnImageSavedCallback() {
                    @Override
                    public void onImageSaved(@NonNull ImageCapture.OutputFileResults r) {
                        try (FileInputStream in = new FileInputStream(out)) {
                            ByteArrayOutputStream buf = new ByteArrayOutputStream();
                            byte[] chunk = new byte[8192];
                            int n;
                            while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
                            JSObject res = new JSObject();
                            res.put("base64", android.util.Base64.encodeToString(
                                buf.toByteArray(), android.util.Base64.NO_WRAP));
                            call.resolve(res);
                        } catch (Exception e) {
                            call.reject("read failed: " + e.getMessage());
                        } finally {
                            //noinspection ResultOfMethodCallIgnored
                            out.delete();
                        }
                    }

                    @Override
                    public void onError(@NonNull ImageCaptureException e) {
                        call.reject("capture failed: " + e.getMessage());
                    }
                });
        } catch (Exception e) {
            call.reject("capture failed: " + e.getMessage());
        }
    }

}
