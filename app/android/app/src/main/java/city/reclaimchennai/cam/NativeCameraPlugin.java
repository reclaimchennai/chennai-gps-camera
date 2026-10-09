package city.reclaimchennai.cam;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.CaptureResult;
import android.hardware.camera2.TotalCaptureResult;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.util.Range;
import android.util.Size;
import android.util.SizeF;
import android.view.Surface;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.ImageView;

import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.camera.camera2.interop.Camera2CameraInfo;
import androidx.camera.camera2.interop.Camera2Interop;
import androidx.camera.camera2.interop.ExperimentalCamera2Interop;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraControl;
import androidx.camera.core.CameraInfo;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ExposureState;
import androidx.camera.core.FocusMeteringAction;
import androidx.camera.core.FocusMeteringResult;
import androidx.camera.core.ImageCapture;
import androidx.camera.core.ImageCaptureException;
import androidx.camera.core.MeteringPoint;
import androidx.camera.core.Preview;
import androidx.camera.core.ResolutionInfo;
import androidx.camera.core.ZoomState;
import androidx.camera.core.resolutionselector.AspectRatioStrategy;
import androidx.camera.core.resolutionselector.ResolutionSelector;
import androidx.camera.core.resolutionselector.ResolutionStrategy;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import androidx.lifecycle.LifecycleOwner;
import androidx.lifecycle.LiveData;
import androidx.lifecycle.Observer;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.common.util.concurrent.ListenableFuture;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.TreeSet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * The camera, natively — CameraX under the web viewfinder.
 *
 * The WebView's getUserMedia camera is a video stream with a few
 * best-effort constraints bolted on. Zoom is often a digital crop because
 * many WebViews never surface the zoom constraint, there is no reliable
 * way to move between a phone's lenses, and tap-to-focus is silently
 * ignored on most devices. Owners of the app said it plainly: zoom and
 * focus were the main thing missing next to the phone's own camera.
 *
 * CameraX gives the app what the phone's camera app uses:
 *  - a hardware-composited preview, drawn by the system behind a
 *    transparent WebView, so the card and controls stay web UI on top;
 *  - the phone's real lenses — ultrawide, main, telephoto — as one zoom
 *    range (see "Lenses" below);
 *  - tap-to-focus that meters focus, exposure and white balance at the
 *    point, plus AE/AF lock and exposure compensation;
 *  - full-sensor stills, with zero-shutter-lag where the device offers
 *    it: the frame comes from a ring of frames already captured, so the
 *    photo is the moment of the press, not a moment after.
 *
 * Lenses. Zoom here is always the number the user sees: 0.6 is the
 * ultrawide, 1 the main camera, 3 a telephoto. Phones reach their lenses
 * in one of two ways, and this class hides which:
 *  - most recent phones zoom ACROSS lenses inside one logical camera, so
 *    0.6 is simply a zoom ratio and the handover is seamless;
 *  - many others (Motorola among them) list the ultrawide as a camera of
 *    its own. Below 1x the preview then moves to that camera — holding
 *    the last frame on screen meanwhile, so there is no black flash —
 *    and 0.8x is the ultrawide zoomed in by 0.8 / 0.6.
 *
 * Nothing here holds the shutter: a capture request returns at once and
 * resolves when the file is written, so a burst queues as fast as a
 * thumb can tap.
 *
 * Every entry point catches and reports instead of throwing: a camera
 * that fails to start must fall back to the web camera, never take the
 * app down with it — an evidence camera that crashes is worse than a
 * plain one that works.
 */
@CapacitorPlugin(name = "NativeCamera")
public class NativeCameraPlugin extends Plugin {

    /** A camera the preview can move to for part of the zoom range. */
    private static final class Lens {
        final CameraSelector selector;
        /** the zoom it stands for: 0.6 for a typical ultrawide */
        final float factor;
        final String id;

        Lens(CameraSelector selector, float factor, String id) {
            this.selector = selector;
            this.factor = factor;
            this.id = id;
        }
    }

    /** Leave the main camera only clearly below 1x; come back at 1x. */
    private static final float WIDE_BELOW = 0.97f;
    /** Longest a held frame may stand in for a lens that is opening. */
    private static final long FREEZE_MAX_MS = 2500;

    private PreviewView previewView;
    /** the last frame, held over the preview while the lens changes */
    private ImageView freezeView;
    private ProcessCameraProvider provider;
    private Camera camera;
    private Preview preview;
    private ImageCapture imageCapture;
    private int lensFacing = CameraSelector.LENS_FACING_BACK;
    private boolean zslActive = false;
    /** Long edge the stills are held to — see bindTo(). */
    private int maxStill = 4096;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private LiveData<ZoomState> zoomSource;
    private Observer<ZoomState> zoomObserver;
    private Observer<PreviewView.StreamState> streamObserver;
    /** the viewfinder box, in device pixels relative to the WebView */
    private int rectX, rectY, rectW = 1, rectH = 1;
    private final View.OnLayoutChangeListener relayout =
        (v, l, t, r, b, ol, ot, or, ob) -> applyTranslation();

    // lenses — see the class comment
    private CameraSelector mainSelector;
    private final List<Lens> wideLenses = new ArrayList<>();
    /** the lens the preview is on; null = the main camera */
    private Lens active = null;
    /** zoom as the user sees it */
    private float vZoom = 1f;
    private float mainZoomMin = 1f;
    private float mainZoomMax = 1f;
    /** the lenses inside the main camera, read once it is bound */
    private final TreeSet<Float> mainLensFactors = new TreeSet<>();
    /** every camera the phone offers: for the capabilities report, and for
     *  the web camera's lens switching in video mode */
    private final JSArray cameraList = new JSArray();
    private boolean switching = false;
    private boolean awaitingStream = false;
    private final List<Runnable> afterSwitch = new ArrayList<>();
    private final Runnable freezeTimeout = this::finishSwitch;
    /** bumped by every start and stop: a start that lost the race to a
     *  stop must not bind a camera nobody is showing */
    private int generation = 0;
    /** carried across a lens change */
    private boolean torchWanted = false;
    private int evWanted = 0;

    /** Latest exposure readings from the running session, for auto flash. */
    private volatile Integer lastIso = null;
    private volatile Long lastExposureNs = null;

    private WebView webView() {
        return getBridge().getWebView();
    }

    // ---- lifecycle -----------------------------------------------------

    /**
     * Start (or restart) the camera.
     * {@code facing}: "environment" | "user".
     * {@code rect}: the web viewfinder box in device pixels, relative to
     * the WebView — the preview is laid exactly under it.
     * {@code maxStill}: long edge of a still, see bindTo().
     */
    @PluginMethod
    public void start(PluginCall call) {
        final String facing = call.getString("facing", "environment");
        lensFacing = "user".equals(facing)
            ? CameraSelector.LENS_FACING_FRONT
            : CameraSelector.LENS_FACING_BACK;
        final JSObject rect = call.getObject("rect", new JSObject());
        maxStill = Math.max(1280, Math.min(8192, call.getInt("maxStill", 4096)));
        getActivity().runOnUiThread(() -> {
            final int gen = ++generation;
            try {
                ensurePreviewView();
                placePreview(rect);
                ListenableFuture<ProcessCameraProvider> fut =
                    ProcessCameraProvider.getInstance(getContext());
                fut.addListener(() -> {
                    if (gen != generation || previewView == null) {
                        call.reject("superseded by a newer start or stop");
                        return;
                    }
                    try {
                        provider = fut.get();
                        open(call);
                    } catch (Exception e) {
                        teardownViews();
                        call.reject("camera provider unavailable: " + e.getMessage());
                    }
                }, ContextCompat.getMainExecutor(getContext()));
            } catch (Exception e) {
                teardownViews();
                call.reject("could not start: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            generation++;
            try {
                if (provider != null) provider.unbindAll();
            } catch (Exception ignored) {
                // already released
            }
            camera = null;
            imageCapture = null;
            preview = null;
            endSwitch();
            teardownViews();
            call.resolve();
        });
    }

    /** Move the preview under the viewfinder box after a layout change. */
    @PluginMethod
    public void setRect(PluginCall call) {
        final JSObject rect = call.getObject("rect", new JSObject());
        getActivity().runOnUiThread(() -> {
            if (previewView != null) placePreview(rect);
            call.resolve();
        });
    }

    /**
     * Hide the preview while another screen is up. The camera keeps
     * running, so coming back is instant, but a TextureView that is not
     * visible stops drawing every frame underneath the gallery.
     */
    @PluginMethod
    public void setVisible(PluginCall call) {
        final boolean visible = !Boolean.FALSE.equals(call.getBoolean("visible", true));
        getActivity().runOnUiThread(() -> {
            if (previewView != null) {
                previewView.setVisibility(visible ? View.VISIBLE : View.INVISIBLE);
            }
            call.resolve();
        });
    }

    private void ensurePreviewView() {
        if (previewView != null) return;
        WebView wv = webView();
        ViewGroup parent = (ViewGroup) wv.getParent();
        // whatever the preview does not cover must read as black, not as
        // the window background, while the page is see-through
        parent.setBackgroundColor(Color.BLACK);
        previewView = new PreviewView(getContext());
        // TextureView, not SurfaceView: it composites like any other view,
        // so a transparent WebView over it is reliable on every device,
        // where a SurfaceView's punched-through layer misbehaves on some
        previewView.setImplementationMode(PreviewView.ImplementationMode.COMPATIBLE);
        previewView.setScaleType(PreviewView.ScaleType.FILL_CENTER);
        previewView.setBackgroundColor(Color.BLACK);
        parent.addView(previewView, 0, new ViewGroup.LayoutParams(1, 1));
        // A sibling, not a child: PreviewView clears its own children every
        // time a camera is bound, which is exactly when this must stay up.
        freezeView = new ImageView(getContext());
        freezeView.setScaleType(ImageView.ScaleType.FIT_XY);
        freezeView.setVisibility(View.GONE);
        parent.addView(freezeView, 1, new ViewGroup.LayoutParams(1, 1));
        previewView.addOnLayoutChangeListener(relayout);
        freezeView.addOnLayoutChangeListener(relayout);
        wv.addOnLayoutChangeListener(relayout);
        wv.setBackgroundColor(Color.TRANSPARENT);
        streamObserver = state -> {
            boolean streaming = state == PreviewView.StreamState.STREAMING;
            JSObject ev = new JSObject();
            ev.put("streaming", streaming);
            notifyListeners("stream", ev);
            if (streaming && awaitingStream) finishSwitch();
        };
        previewView.getPreviewStreamState().observe((LifecycleOwner) getActivity(), streamObserver);
    }

    private void placePreview(JSObject rect) {
        WebView wv = webView();
        rectX = rect.optInt("x", 0);
        rectY = rect.optInt("y", 0);
        rectW = Math.max(1, rect.optInt("width", wv.getWidth()));
        rectH = Math.max(1, rect.optInt("height", wv.getHeight()));
        for (View v : new View[] {previewView, freezeView}) {
            if (v == null) continue;
            ViewGroup.LayoutParams lp = v.getLayoutParams();
            if (lp.width != rectW || lp.height != rectH) {
                lp.width = rectW;
                lp.height = rectH;
                v.setLayoutParams(lp);
            }
        }
        applyTranslation();
    }

    /**
     * Put the preview's top-left on the box's, measured from where layout
     * actually put each view. The parent may already inset its children
     * below the status bar (edge-to-edge), so the WebView's offset cannot
     * simply be added on: that put the picture a status bar too low.
     * Re-run after every layout of any of the views.
     */
    private void applyTranslation() {
        WebView wv = webView();
        for (View v : new View[] {previewView, freezeView}) {
            if (v == null) continue;
            v.setTranslationX(wv.getLeft() + rectX - v.getLeft());
            v.setTranslationY(wv.getTop() + rectY - v.getTop());
        }
    }

    private void teardownViews() {
        WebView wv = null;
        try {
            wv = webView();
        } catch (Exception ignored) {
            // activity going away
        }
        if (previewView != null) {
            try {
                if (streamObserver != null) {
                    previewView.getPreviewStreamState().removeObserver(streamObserver);
                }
                previewView.removeOnLayoutChangeListener(relayout);
                ViewGroup parent = (ViewGroup) previewView.getParent();
                if (parent != null) parent.removeView(previewView);
            } catch (Exception ignored) {
                // view already gone
            }
            previewView = null;
        }
        if (freezeView != null) {
            try {
                freezeView.removeOnLayoutChangeListener(relayout);
                ViewGroup parent = (ViewGroup) freezeView.getParent();
                if (parent != null) parent.removeView(freezeView);
            } catch (Exception ignored) {
                // view already gone
            }
            freezeView = null;
        }
        if (wv != null) {
            wv.removeOnLayoutChangeListener(relayout);
            // the page paints its own background everywhere off the camera
            wv.setBackgroundColor(Color.BLACK);
        }
    }

    /** First bind of a start: the main camera, then find its other lenses. */
    private void open(PluginCall call) {
        mainSelector = new CameraSelector.Builder().requireLensFacing(lensFacing).build();
        try {
            if (!provider.hasCamera(mainSelector)) {
                teardownViews();
                call.reject("no such camera");
                return;
            }
        } catch (Exception e) {
            teardownViews();
            call.reject("camera query failed: " + e.getMessage());
            return;
        }
        endSwitch();
        active = null;
        vZoom = 1f;
        torchWanted = false;
        evWanted = 0;
        try {
            bindTo(mainSelector);
        } catch (Exception e) {
            teardownViews();
            call.reject("bind failed: " + e.getMessage());
            return;
        }
        ZoomState z = camera.getCameraInfo().getZoomState().getValue();
        mainZoomMin = z != null ? z.getMinZoomRatio() : 1f;
        mainZoomMax = z != null ? z.getMaxZoomRatio() : 1f;
        readMainLenses();
        findWideLenses();
        call.resolve(describe());
    }

    /**
     * Bind preview and stills to one camera, replacing whatever was bound.
     * Throws if the camera will not open with them.
     */
    @SuppressLint("UnsafeOptInUsageError")
    @androidx.annotation.OptIn(markerClass = ExperimentalCamera2Interop.class)
    private void bindTo(CameraSelector selector) {
        provider.unbindAll();

        // 4:3 for preview AND stills: it is the sensor's own shape, so the
        // photo is the full sensor, and what the viewfinder shows is what
        // the photo contains
        ResolutionSelector previewRes = new ResolutionSelector.Builder()
            .setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY)
            .build();
        // Stills are held to about 12 MP — the size the phone's own camera
        // app saves by default. HIGHEST_AVAILABLE is 50 or even 108 MP on
        // some phones (several Motorolas among them); decoded in the
        // WebView, that is a 200-400 MB bitmap per photo, which is how a
        // camera app runs out of memory. Expressed in the sensor's own
        // landscape frame.
        ResolutionSelector stillRes = new ResolutionSelector.Builder()
            .setAspectRatioStrategy(AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY)
            .setResolutionStrategy(new ResolutionStrategy(
                new Size(maxStill, maxStill * 3 / 4),
                ResolutionStrategy.FALLBACK_RULE_CLOSEST_LOWER_THEN_HIGHER))
            .build();

        Preview.Builder pb = new Preview.Builder().setResolutionSelector(previewRes);
        // Exposure readings for auto flash, straight from the capture
        // results: ISO and shutter time are exactly what the light meter
        // wants, and the WebView rarely exposes either
        new Camera2Interop.Extender<>(pb).setSessionCaptureCallback(
            new CameraCaptureSession.CaptureCallback() {
                @Override
                public void onCaptureCompleted(@NonNull CameraCaptureSession s,
                                               @NonNull CaptureRequest r,
                                               @NonNull TotalCaptureResult result) {
                    Integer iso = result.get(CaptureResult.SENSOR_SENSITIVITY);
                    Long exp = result.get(CaptureResult.SENSOR_EXPOSURE_TIME);
                    if (iso != null) lastIso = iso;
                    if (exp != null) lastExposureNs = exp;
                }
            });
        preview = pb.build();
        preview.setSurfaceProvider(previewView.getSurfaceProvider());

        boolean zsl = false;
        try {
            zsl = provider.getCameraInfo(selector).isZslSupported();
        } catch (Exception ignored) {
            // no info for this selector — minimise latency instead
        }
        imageCapture = stillUseCase(zsl, stillRes);
        zslActive = zsl;
        try {
            camera = provider.bindToLifecycle(
                (LifecycleOwner) getActivity(), selector, preview, imageCapture);
        } catch (RuntimeException e) {
            if (!zsl) throw e;
            // ZSL is not always accepted alongside the preview's
            // configuration; one retry without it before giving up
            imageCapture = stillUseCase(false, stillRes);
            zslActive = false;
            camera = provider.bindToLifecycle(
                (LifecycleOwner) getActivity(), selector, preview, imageCapture);
        }

        if (zoomSource != null && zoomObserver != null) zoomSource.removeObserver(zoomObserver);
        zoomSource = camera.getCameraInfo().getZoomState();
        zoomObserver = z -> {
            // the user's zoom, not this camera's ratio — and while a lens
            // is opening, what the user asked for rather than its 1x
            float shown = switching ? vZoom : z.getZoomRatio() * activeFactor();
            JSObject ev = new JSObject();
            ev.put("zoom", shown);
            ev.put("min", virtualMin());
            ev.put("max", mainZoomMax);
            notifyListeners("zoom", ev);
        };
        zoomSource.observe((LifecycleOwner) getActivity(), zoomObserver);

        // what the user set survives the lens change
        CameraInfo info = camera.getCameraInfo();
        CameraControl cc = camera.getCameraControl();
        if (torchWanted && info.hasFlashUnit()) cc.enableTorch(true);
        if (evWanted != 0 && info.getExposureState().isExposureCompensationSupported()) {
            Range<Integer> r = info.getExposureState().getExposureCompensationRange();
            cc.setExposureCompensationIndex(Math.max(r.getLower(), Math.min(r.getUpper(), evWanted)));
        }
    }

    private ImageCapture stillUseCase(boolean zsl, ResolutionSelector res) {
        return new ImageCapture.Builder()
            .setCaptureMode(zsl
                ? ImageCapture.CAPTURE_MODE_ZERO_SHUTTER_LAG
                : ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
            .setResolutionSelector(res)
            .setJpegQuality(92)
            .build();
    }

    /** What this camera can do — read at start and after a lens change. */
    private JSObject describe() {
        JSObject out = new JSObject();
        if (camera == null) return out;
        CameraInfo info = camera.getCameraInfo();
        out.put("zoom", vZoom);
        out.put("zoomMin", virtualMin());
        out.put("zoomMax", mainZoomMax);
        out.put("hasFlash", info.hasFlashUnit());
        out.put("zsl", zslActive);
        ExposureState ex = info.getExposureState();
        Range<Integer> r = ex.getExposureCompensationRange();
        out.put("evSupported", ex.isExposureCompensationSupported());
        out.put("evMin", r.getLower());
        out.put("evMax", r.getUpper());
        out.put("evStep", ex.getExposureCompensationStep().floatValue());
        out.put("evIndex", ex.getExposureCompensationIndex());
        out.put("facing", lensFacing == CameraSelector.LENS_FACING_FRONT ? "user" : "environment");
        out.put("lenses", lensFactors());
        out.put("lensSwitch", !wideLenses.isEmpty());
        out.put("cameras", cameraList);
        out.put("lens", active != null ? active.id : "main");
        putSize(out, "still", imageCapture != null ? imageCapture.getResolutionInfo() : null);
        putSize(out, "preview", preview != null ? preview.getResolutionInfo() : null);
        return out;
    }

    private static void putSize(JSObject out, String key, ResolutionInfo r) {
        if (r == null) return;
        out.put(key + "W", r.getResolution().getWidth());
        out.put(key + "H", r.getResolution().getHeight());
    }

    // ---- lenses --------------------------------------------------------

    private float activeFactor() {
        return active != null ? active.factor : 1f;
    }

    private float virtualMin() {
        return wideLenses.isEmpty()
            ? mainZoomMin
            : Math.min(mainZoomMin, wideLenses.get(0).factor);
    }

    /**
     * An ultrawide the preview can move to, when the main camera cannot
     * zoom out to it by itself. Back camera only.
     *
     * Two places to look: other cameras the phone lists in its own right
     * (how Motorola and many others expose the ultrawide), then the lenses
     * inside the main logical camera, streamed directly, for phones that
     * describe them but will not zoom to them.
     */
    @SuppressLint("UnsafeOptInUsageError")
    @androidx.annotation.OptIn(markerClass = ExperimentalCamera2Interop.class)
    private void findWideLenses() {
        wideLenses.clear();
        listCameras();
        if (lensFacing != CameraSelector.LENS_FACING_BACK || camera == null) return;
        if (mainZoomMin < 0.95f) return; // it already zooms across its lenses
        try {
            CameraInfo mainInfo = camera.getCameraInfo();
            String mainId = idOf(mainInfo);
            Double mainView = viewWidth(mainId);
            for (CameraInfo ci : provider.getAvailableCameraInfos()) {
                if (ci.getLensFacing() != CameraSelector.LENS_FACING_BACK) continue;
                String id = idOf(ci);
                if (id == null || id.equals(mainId)) continue;
                float f = factorOf(ci, id, mainView);
                if (usableWide(f, id)) wideLenses.add(new Lens(ci.getCameraSelector(), f, id));
            }
            if (wideLenses.isEmpty() && mainInfo.isLogicalMultiCameraSupported()) {
                for (CameraInfo pi : mainInfo.getPhysicalCameraInfos()) {
                    String pid = idOf(pi);
                    if (pid == null) continue;
                    float f = factorOf(pi, pid, mainView);
                    if (!usableWide(f, pid)) continue;
                    CameraSelector sel = new CameraSelector.Builder()
                        .requireLensFacing(CameraSelector.LENS_FACING_BACK)
                        .setPhysicalCameraId(pid)
                        .build();
                    wideLenses.add(new Lens(sel, f, pid));
                }
            }
        } catch (Exception e) {
            // nothing more to find; the main camera's own range stands
            Log.w("NativeCamera", "lens discovery failed", e);
        }
        // the widest one; a second ultrawide adds nothing a pinch cannot
        wideLenses.sort((a, b) -> Float.compare(a.factor, b.factor));
        while (wideLenses.size() > 1) wideLenses.remove(wideLenses.size() - 1);
    }

    /**
     * Every camera CameraX can open — by the camera2 id the WebView also
     * labels it with ("camera2 2, facing back"), so video mode's web camera
     * can switch to the right lens without probing and guessing. Factors
     * are against the main camera of the same facing.
     */
    private void listCameras() {
        while (cameraList.length() > 0) cameraList.remove(0);
        try {
            String mainId = camera != null ? idOf(camera.getCameraInfo()) : null;
            Double mainView = viewWidth(mainId);
            for (CameraInfo ci : provider.getAvailableCameraInfos()) {
                String id = idOf(ci);
                if (id == null) continue;
                CameraCharacteristics c = characteristics(id);
                Size px = c != null ? c.get(CameraCharacteristics.SENSOR_INFO_PIXEL_ARRAY_SIZE) : null;
                int facing = ci.getLensFacing();
                JSObject cam = new JSObject();
                cam.put("id", id);
                cam.put("facing", facing == CameraSelector.LENS_FACING_FRONT ? "front"
                    : facing == CameraSelector.LENS_FACING_BACK ? "back" : "other");
                // only cameras facing the same way as the main one compare
                cam.put("factor", facing == lensFacing
                    ? Math.round(factorOf(ci, id, mainView) * 100) / 100.0
                    : 1.0);
                cam.put("mp", px != null
                    ? Math.round(px.getWidth() * (double) px.getHeight() / 1e5) / 10.0
                    : 0.0);
                if (ci.isLogicalMultiCameraSupported()) {
                    cam.put("lenses", ci.getPhysicalCameraInfos().size());
                }
                cameraList.put(cam);
            }
        } catch (Exception e) {
            Log.w("NativeCamera", "camera listing failed", e);
        }
    }

    /** The lens for a zoom: the ultrawide below 1x, else the main camera. */
    @Nullable
    private Lens lensFor(float z) {
        if (wideLenses.isEmpty()) return null;
        Lens wide = wideLenses.get(0);
        if (active == null) return z < WIDE_BELOW ? wide : null;
        return z >= 1f ? null : wide;
    }

    /** Set the bound camera's ratio for the user's zoom. */
    private void applyRatio() {
        if (camera == null) return;
        ZoomState zs = camera.getCameraInfo().getZoomState().getValue();
        float lo = zs != null ? zs.getMinZoomRatio() : 1f;
        float hi = zs != null ? zs.getMaxZoomRatio() : 1f;
        float ratio = Math.max(lo, Math.min(hi, vZoom / activeFactor()));
        try {
            camera.getCameraControl().setZoomRatio(ratio);
        } catch (Exception ignored) {
            // a newer request superseded this one — normal mid-pinch
        }
    }

    /**
     * Move the preview to another lens. The last frame stays on screen
     * until the new lens is streaming; captures asked for meanwhile wait
     * for it. One switch at a time — when it lands, the zoom the user has
     * reached by then decides whether another is due.
     */
    private void switchTo(@Nullable Lens target) {
        if (switching) return;
        switching = true;
        freeze();
        // post: let the held frame reach the screen before the old camera goes
        main.post(() -> {
            if (camera == null) {
                endSwitch();
                return;
            }
            boolean failed = false;
            try {
                bindTo(target == null ? mainSelector : target.selector);
                active = target;
            } catch (Exception e) {
                // this lens will not open on this phone: forget it, and get
                // the main camera back so the viewfinder never stays dark
                failed = true;
                wideLenses.remove(target);
                try {
                    bindTo(mainSelector);
                } catch (Exception ignored) {
                    // nothing bound; the web layer restarts the camera
                }
                active = null;
                if (vZoom < mainZoomMin) vZoom = mainZoomMin;
            }
            applyRatio();
            awaitingStream = true;
            main.postDelayed(freezeTimeout, FREEZE_MAX_MS);
            runAfterSwitch();
            JSObject ev = describe();
            if (failed) ev.put("failed", true);
            notifyListeners("lens", ev);
        });
    }

    /** The new lens is streaming (or took too long): let go of the frame. */
    private void finishSwitch() {
        main.removeCallbacks(freezeTimeout);
        awaitingStream = false;
        boolean was = switching;
        switching = false;
        unfreeze();
        if (!was || camera == null) return;
        // the user may have pinched back across 1x while it was opening
        Lens again = lensFor(vZoom);
        if (again != active) switchTo(again);
        else applyRatio();
    }

    /** Abandon any switch — the camera is stopping or restarting. */
    private void endSwitch() {
        main.removeCallbacks(freezeTimeout);
        switching = false;
        awaitingStream = false;
        runAfterSwitch();
        if (freezeView != null) {
            freezeView.animate().cancel();
            freezeView.setVisibility(View.GONE);
            freezeView.setImageDrawable(null);
        }
    }

    /** Take the presses that waited for a lens. With no camera left they
     *  reject on their own, so a shot is never silently dropped. */
    private void runAfterSwitch() {
        List<Runnable> pending = new ArrayList<>(afterSwitch);
        afterSwitch.clear();
        for (Runnable r : pending) r.run();
    }

    private void freeze() {
        if (previewView == null || freezeView == null) return;
        Bitmap b = null;
        try {
            b = previewView.getBitmap();
        } catch (Exception ignored) {
            // nothing on screen yet
        }
        if (b == null) return;
        freezeView.animate().cancel();
        freezeView.setImageBitmap(b);
        freezeView.setAlpha(1f);
        freezeView.setVisibility(View.VISIBLE);
    }

    private void unfreeze() {
        if (freezeView == null || freezeView.getVisibility() != View.VISIBLE) return;
        freezeView.animate()
            .alpha(0f)
            .setDuration(160)
            .withEndAction(() -> {
                if (freezeView == null) return;
                freezeView.setVisibility(View.GONE);
                freezeView.setImageDrawable(null);
            })
            .start();
    }

    /**
     * The zoom factor of each lens the zoom range crosses — 0.6 for the
     * ultrawide, 3 or 5 for a telephoto — so the chips can name the
     * phone's real optics the way its own camera app does. The lenses
     * inside the main camera, plus any ultrawide reached by switching.
     */
    private JSArray lensFactors() {
        TreeSet<Float> set = new TreeSet<>(mainLensFactors);
        for (Lens l : wideLenses) set.add(Math.round(l.factor * 100) / 100f);
        JSArray out = new JSArray();
        // put(Object): put(double) declares a JSONException for NaN
        for (Float f : set) out.put(Double.valueOf(f));
        return out;
    }

    /** The physical lenses behind the main camera, as zoom factors. */
    private void readMainLenses() {
        mainLensFactors.clear();
        try {
            CameraInfo mainInfo = camera.getCameraInfo();
            if (!mainInfo.isLogicalMultiCameraSupported()) return;
            Double mainView = viewWidth(idOf(mainInfo));
            for (CameraInfo pi : mainInfo.getPhysicalCameraInfos()) {
                float f = factorOf(pi, idOf(pi), mainView);
                if (f > 0.3f && f < 20f) mainLensFactors.add(Math.round(f * 100) / 100f);
            }
        } catch (Exception ignored) {
            // no lens description — the chips fall back to plain steps
        }
    }

    /**
     * How much narrower (above 1) or wider (below 1) a camera sees than the
     * main one. CameraX knows this as the intrinsic zoom ratio; where it
     * has no answer, it is sensor width over focal length, compared.
     */
    private float factorOf(CameraInfo ci, String id, Double mainView) {
        float f = Float.NaN;
        try {
            f = ci.getIntrinsicZoomRatio();
        } catch (Exception ignored) {
            // older behaviour: computed below
        }
        if (Float.isNaN(f) || f <= 0f || Math.abs(f - 1f) < 1e-3) {
            Double view = viewWidth(id);
            if (view != null && mainView != null && view > 0) {
                f = (float) (mainView / view);
            }
        }
        return Float.isNaN(f) ? 1f : f;
    }

    /** A real ultrawide: clearly wider than the main camera, and not a
     *  low-resolution utility sensor. */
    private boolean usableWide(float f, String id) {
        if (!(f >= 0.3f && f <= 0.9f)) return false;
        CameraCharacteristics c = characteristics(id);
        if (c == null) return false;
        Size px = c.get(CameraCharacteristics.SENSOR_INFO_PIXEL_ARRAY_SIZE);
        return px != null && (long) px.getWidth() * px.getHeight() >= 3_000_000L;
    }

    @SuppressLint("UnsafeOptInUsageError")
    @androidx.annotation.OptIn(markerClass = ExperimentalCamera2Interop.class)
    @Nullable
    private static String idOf(CameraInfo ci) {
        try {
            return Camera2CameraInfo.from(ci).getCameraId();
        } catch (Exception e) {
            return null;
        }
    }

    @Nullable
    private CameraCharacteristics characteristics(String id) {
        if (id == null) return null;
        try {
            CameraManager cm = (CameraManager) getContext().getSystemService(Context.CAMERA_SERVICE);
            return cm.getCameraCharacteristics(id);
        } catch (Exception e) {
            return null;
        }
    }

    /** Field-of-view width, as sensor width over focal length. */
    @Nullable
    private Double viewWidth(String id) {
        CameraCharacteristics c = characteristics(id);
        if (c == null) return null;
        float[] fl = c.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS);
        SizeF sensor = c.get(CameraCharacteristics.SENSOR_INFO_PHYSICAL_SIZE);
        if (fl == null || fl.length == 0 || fl[0] <= 0 || sensor == null) return null;
        return (double) sensor.getWidth() / fl[0];
    }

    // ---- controls ------------------------------------------------------

    /**
     * Zoom as the user sees it (0.6 = ultrawide). Resolves at once with
     * the clamped value; the camera reports what it actually reached
     * through "zoom" events. Crossing 1x may move to another lens.
     */
    @PluginMethod
    public void setZoom(PluginCall call) {
        final float ratio = call.getFloat("ratio", 1f);
        getActivity().runOnUiThread(() -> {
            if (camera == null) {
                call.reject("camera not running");
                return;
            }
            vZoom = Math.max(virtualMin(), Math.min(mainZoomMax, ratio));
            Lens want = lensFor(vZoom);
            if (want != active) switchTo(want);
            else if (!switching) applyRatio();
            JSObject out = new JSObject();
            out.put("zoom", vZoom);
            call.resolve(out);
        });
    }

    /**
     * Focus and meter at a point — focus, exposure and white balance, the
     * way the phone's camera does. {@code x}, {@code y} are 0..1 across the
     * preview as shown. {@code lock}: hold it until cancelled (AE/AF lock)
     * instead of returning to continuous focus after a few seconds.
     */
    @PluginMethod
    public void focus(PluginCall call) {
        final float nx = call.getFloat("x", 0.5f);
        final float ny = call.getFloat("y", 0.5f);
        final boolean lock = Boolean.TRUE.equals(call.getBoolean("lock", false));
        getActivity().runOnUiThread(() -> {
            if (camera == null || previewView == null) {
                call.reject("camera not running");
                return;
            }
            try {
                MeteringPoint p = previewView.getMeteringPointFactory()
                    .createPoint(nx * previewView.getWidth(), ny * previewView.getHeight());
                FocusMeteringAction.Builder b = new FocusMeteringAction.Builder(
                    p,
                    FocusMeteringAction.FLAG_AF
                        | FocusMeteringAction.FLAG_AE
                        | FocusMeteringAction.FLAG_AWB);
                if (lock) b.disableAutoCancel();
                else b.setAutoCancelDuration(5, TimeUnit.SECONDS);
                ListenableFuture<FocusMeteringResult> fut =
                    camera.getCameraControl().startFocusAndMetering(b.build());
                fut.addListener(() -> {
                    JSObject out = new JSObject();
                    try {
                        out.put("success", fut.get().isFocusSuccessful());
                    } catch (Exception e) {
                        // cancelled by a newer tap, or no AF on this lens
                        out.put("success", false);
                    }
                    call.resolve(out);
                }, ContextCompat.getMainExecutor(getContext()));
            } catch (Exception e) {
                JSObject out = new JSObject();
                out.put("success", false);
                call.resolve(out);
            }
        });
    }

    /** Back to continuous autofocus and auto exposure. */
    @PluginMethod
    public void cancelFocus(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            try {
                if (camera != null) camera.getCameraControl().cancelFocusAndMetering();
            } catch (Exception ignored) {
                // nothing to cancel
            }
            call.resolve();
        });
    }

    @PluginMethod
    public void setTorch(PluginCall call) {
        final boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        getActivity().runOnUiThread(() -> {
            JSObject out = new JSObject();
            torchWanted = on;
            try {
                if (camera == null || !camera.getCameraInfo().hasFlashUnit()) {
                    out.put("ok", false);
                } else {
                    camera.getCameraControl().enableTorch(on);
                    out.put("ok", true);
                }
            } catch (Exception e) {
                out.put("ok", false);
            }
            call.resolve(out);
        });
    }

    @PluginMethod
    public void setExposure(PluginCall call) {
        final int index = call.getInt("index", 0);
        getActivity().runOnUiThread(() -> {
            JSObject out = new JSObject();
            try {
                CameraControl cc = camera.getCameraControl();
                Range<Integer> r = camera.getCameraInfo().getExposureState()
                    .getExposureCompensationRange();
                int clamped = Math.max(r.getLower(), Math.min(r.getUpper(), index));
                cc.setExposureCompensationIndex(clamped);
                evWanted = clamped;
                out.put("ok", true);
                out.put("index", clamped);
            } catch (Exception e) {
                out.put("ok", false);
            }
            call.resolve(out);
        });
    }

    /** The sensor's own exposure effort — what auto flash decides on. */
    @PluginMethod
    public void light(PluginCall call) {
        JSObject out = new JSObject();
        if (lastIso != null) out.put("iso", lastIso);
        if (lastExposureNs != null) out.put("exposureNs", lastExposureNs);
        call.resolve(out);
    }

    // ---- capture -------------------------------------------------------

    /**
     * Take a full-sensor still. {@code rotation} is how the phone is held
     * (0, 90 = top edge to the left, -90 = top edge to the right), so the
     * JPEG comes out the right way up for that grip. Resolves with a file
     * path in the app cache once written; nothing waits on it to accept
     * the next press. A press during a lens change is taken by the new
     * lens the moment it is open.
     */
    @PluginMethod
    public void capture(PluginCall call) {
        final int rot = call.getInt("rotation", 0);
        getActivity().runOnUiThread(() -> {
            if (switching) afterSwitch.add(() -> takeStill(call, rot));
            else takeStill(call, rot);
        });
    }

    private void takeStill(PluginCall call, int rot) {
        if (imageCapture == null) {
            call.reject("camera not running");
            return;
        }
        try {
            imageCapture.setTargetRotation(surfaceRotation(rot));
            File out = new File(getContext().getCacheDir(),
                "native-cap-" + System.nanoTime() + ".jpg");
            ImageCapture.OutputFileOptions opts =
                new ImageCapture.OutputFileOptions.Builder(out).build();
            final long started = System.nanoTime();
            final boolean zsl = zslActive;
            imageCapture.takePicture(opts, io, new ImageCapture.OnImageSavedCallback() {
                @Override
                public void onImageSaved(@NonNull ImageCapture.OutputFileResults results) {
                    JSObject res = new JSObject();
                    res.put("path", out.getAbsolutePath());
                    res.put("ms", (System.nanoTime() - started) / 1_000_000L);
                    res.put("zsl", zsl);
                    call.resolve(res);
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

    /** Delete a still the web layer has finished reading. */
    @PluginMethod
    public void release(PluginCall call) {
        String path = call.getString("path", "");
        try {
            File f = new File(path);
            File cache = getContext().getCacheDir();
            // only ever our own capture files
            if (f.getName().startsWith("native-cap-")
                    && cache.equals(f.getParentFile())) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
        } catch (Exception ignored) {
            // the next start sweeps leftovers
        }
        call.resolve();
    }

    /**
     * At app launch: get CameraX ready, so the first start only has to
     * open the camera — initialising it can take seconds on a slow phone,
     * and that used to come out of the time to a live viewfinder. Then
     * sweep leftover stills from a session that ended mid-capture.
     */
    @Override
    public void load() {
        try {
            ProcessCameraProvider.getInstance(getContext());
        } catch (Exception ignored) {
            // start() reports it if the camera really is unavailable
        }
        try {
            File[] stale = getContext().getCacheDir().listFiles(
                (dir, name) -> name.startsWith("native-cap-"));
            if (stale != null) {
                long cutoff = System.currentTimeMillis() - 10 * 60 * 1000L;
                for (File f : stale) {
                    //noinspection ResultOfMethodCallIgnored
                    if (f.lastModified() < cutoff) f.delete();
                }
            }
        } catch (Exception ignored) {
            // nothing to sweep
        }
    }

    /** Our rotation (how the phone is held) to CameraX's target rotation. */
    private static int surfaceRotation(int held) {
        // +90: top edge to the left = the device turned counter-clockwise,
        // which Android reports as ROTATION_90; -90 is ROTATION_270
        if (held == 90) return Surface.ROTATION_90;
        if (held == -90 || held == 270) return Surface.ROTATION_270;
        if (held == 180) return Surface.ROTATION_180;
        return Surface.ROTATION_0;
    }
}
