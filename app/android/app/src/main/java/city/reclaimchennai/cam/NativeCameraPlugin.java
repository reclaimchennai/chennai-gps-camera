package city.reclaimchennai.cam;

import android.annotation.SuppressLint;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.Paint;
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
import androidx.camera.core.CameraEffect;
import androidx.camera.core.UseCaseGroup;
import androidx.camera.effects.OverlayEffect;
import androidx.camera.video.FallbackStrategy;
import androidx.camera.video.FileOutputOptions;
import androidx.camera.video.PendingRecording;
import androidx.camera.video.Quality;
import androidx.camera.video.QualitySelector;
import androidx.camera.video.Recorder;
import androidx.camera.video.Recording;
import androidx.camera.video.VideoCapture;
import androidx.camera.video.VideoRecordEvent;
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
    /** Frame shape: 4:3 for photos (the whole sensor), 16:9 for video. */
    private boolean wide169 = false;
    /** Video mode: preview + recorder instead of preview + stills. */
    private boolean videoMode = false;
    private int recordLongEdge = 1920;
    private int recordBitrate = 0;
    private VideoCapture<Recorder> videoCapture;
    private Recording recording;
    private File recordFile;
    private long recordStartedAt;
    private PluginCall stopCall;
    /** draws the card into recorded frames */
    private OverlayEffect overlay;
    private android.os.HandlerThread overlayThread;
    /** the card's strips, upright, and the upright size they were drawn for */
    private volatile List<Placed> overlayBands = new ArrayList<>();
    private volatile int overlayW = 0, overlayH = 0;

    private static final class Placed {
        final Bitmap bmp;
        final float x, y;

        Placed(Bitmap bmp, float x, float y) {
            this.bmp = bmp;
            this.x = x;
            this.y = y;
        }
    }
    /** Long edge the stills are held to — see bindTo(). */
    private int maxStill = 4096;
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    /** shutter snapshots: never queued behind a still being saved */
    private final ExecutorService snapIo = Executors.newSingleThreadExecutor();
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
        videoMode = "video".equals(call.getString("mode", "photo"));
        wide169 = videoMode || "16:9".equals(call.getString("aspect", "4:3"));
        recordLongEdge = call.getInt("recordLongEdge", 1920);
        recordBitrate = call.getInt("recordBitrate", 0);
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
            videoCapture = null;
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
     * Every rear camera Android lists, with the zoom factor its lens stands
     * for against the main one — read from the camera service without
     * opening anything. For the APP camera (video, and photos unless the
     * phone camera is chosen): it otherwise opened each camera in turn and
     * guessed from Android's ordering which was the ultrawide, which is
     * why the wide lens failed on many phones.
     */
    @PluginMethod
    public void lensTable(PluginCall call) {
        JSArray list = new JSArray();
        try {
            CameraManager cm = (CameraManager) getContext().getSystemService(Context.CAMERA_SERVICE);
            Double mainView = null;
            for (String id : cm.getCameraIdList()) {
                CameraCharacteristics c = cm.getCameraCharacteristics(id);
                Integer facing = c.get(CameraCharacteristics.LENS_FACING);
                if (facing == null || facing != CameraCharacteristics.LENS_FACING_BACK) continue;
                int[] caps = c.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES);
                boolean usable = false;
                if (caps != null) {
                    for (int cap : caps) {
                        if (cap == CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_BACKWARD_COMPATIBLE) usable = true;
                    }
                }
                if (!usable) continue;
                Double view = viewWidth(id);
                if (view == null || view <= 0) continue;
                // the first rear camera listed is the one apps get by default:
                // the main camera, 1x
                if (mainView == null) mainView = view;
                Size px = c.get(CameraCharacteristics.SENSOR_INFO_PIXEL_ARRAY_SIZE);
                JSObject cam = new JSObject();
                cam.put("id", id);
                cam.put("facing", "back");
                cam.put("factor", Math.round(mainView / view * 100) / 100.0);
                cam.put("mp", px != null ? Math.round(px.getWidth() * (double) px.getHeight() / 1e5) / 10.0 : 0.0);
                list.put(cam);
            }
        } catch (Exception e) {
            Log.w("NativeCamera", "lens table failed", e);
        }
        JSObject out = new JSObject();
        out.put("cameras", list);
        call.resolve(out);
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
        mainSelector = widestZooming(lensFacing);
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
     * The camera to open for a facing: the one whose zoom reaches widest.
     *
     * Android hands apps the first camera of a facing by default, and on
     * many phones that is the main lens alone (zoom 1x–8x). The same
     * phones often also list a LOGICAL camera — main and ultrawide behind
     * one id — that zooms from 0.5x to 8x and hands over between the
     * lenses by itself; it is what the phone's own camera app uses. On a
     * moto g84 that is camera 3. Opening it gives the ultrawide without
     * a camera switch, so moving to 0.6x is as smooth as a pinch.
     */
    @SuppressLint("UnsafeOptInUsageError")
    @androidx.annotation.OptIn(markerClass = ExperimentalCamera2Interop.class)
    private CameraSelector widestZooming(int facing) {
        CameraSelector fallback = new CameraSelector.Builder().requireLensFacing(facing).build();
        if (android.os.Build.VERSION.SDK_INT < 30) return fallback;
        try {
            CameraInfo best = null;
            float bestMin = 0.95f;
            for (CameraInfo ci : provider.getAvailableCameraInfos()) {
                if (ci.getLensFacing() != facing) continue;
                CameraCharacteristics c = characteristics(idOf(ci));
                if (c == null || !backwardCompatible(c)) continue;
                Range<Float> zr = c.get(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE);
                if (zr == null) continue;
                if (zr.getLower() < bestMin - 0.01f) {
                    best = ci;
                    bestMin = zr.getLower();
                }
            }
            if (best != null) {
                Log.i("NativeCamera", "opening camera " + idOf(best) + ", zoom from " + bestMin);
                return best.getCameraSelector();
            }
        } catch (Exception e) {
            Log.w("NativeCamera", "camera choice failed", e);
        }
        return fallback;
    }

    private static boolean backwardCompatible(CameraCharacteristics c) {
        int[] caps = c.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES);
        if (caps == null) return false;
        for (int cap : caps) {
            if (cap == CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_BACKWARD_COMPATIBLE) return true;
        }
        return false;
    }

    /**
     * Bind preview and stills to one camera, replacing whatever was bound.
     * Throws if the camera will not open with them.
     */
    @SuppressLint("UnsafeOptInUsageError")
    @androidx.annotation.OptIn(markerClass = ExperimentalCamera2Interop.class)
    private void bindTo(CameraSelector selector) {
        provider.unbindAll();

        // Photos take the whole 4:3 sensor, as the phone's own camera does;
        // video is 16:9. Preview and stills share the shape, so the
        // viewfinder shows exactly the photo.
        AspectRatioStrategy shape = wide169
            ? AspectRatioStrategy.RATIO_16_9_FALLBACK_AUTO_STRATEGY
            : AspectRatioStrategy.RATIO_4_3_FALLBACK_AUTO_STRATEGY;
        ResolutionSelector previewRes = new ResolutionSelector.Builder()
            .setAspectRatioStrategy(shape)
            .build();
        // Stills are held to about 12 MP — the size the phone's own camera
        // app saves by default. HIGHEST_AVAILABLE is 50 or even 108 MP on
        // some phones (several Motorolas among them); decoded in the
        // WebView, that is a 200-400 MB bitmap per photo, which is how a
        // camera app runs out of memory. Expressed in the sensor's own
        // landscape frame.
        ResolutionSelector stillRes = new ResolutionSelector.Builder()
            .setAspectRatioStrategy(shape)
            .setResolutionStrategy(new ResolutionStrategy(
                new Size(maxStill, wide169 ? maxStill * 9 / 16 : maxStill * 3 / 4),
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

        if (videoMode) {
            bindVideo(selector);
        } else {
            bindStills(selector, stillRes);
        }
        afterBind();
    }

    /** Photo mode: preview and stills. */
    private void bindStills(CameraSelector selector, ResolutionSelector stillRes) {
        videoCapture = null;
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
    }

    /**
     * Video mode: preview and a recorder, with the card drawn into every
     * recorded frame by the GPU (OverlayEffect) — the page sends the card
     * once a second (setOverlay) and does nothing per frame.
     */
    @SuppressLint("UnsafeOptInUsageError")
    private void bindVideo(CameraSelector selector) {
        imageCapture = null;
        zslActive = false;
        Quality q = recordLongEdge >= 1900 ? Quality.FHD : Quality.HD;
        Recorder.Builder rb = new Recorder.Builder()
            .setQualitySelector(QualitySelector.from(q, FallbackStrategy.lowerQualityOrHigherThan(q)));
        if (recordBitrate > 0) rb.setTargetVideoEncodingBitRate(recordBitrate);
        videoCapture = VideoCapture.withOutput(rb.build());
        ensureOverlay();
        UseCaseGroup group = new UseCaseGroup.Builder()
            .addUseCase(preview)
            .addUseCase(videoCapture)
            .addEffect(overlay)
            .build();
        camera = provider.bindToLifecycle((LifecycleOwner) getActivity(), selector, group);
    }

    /** What every bind does once the use cases are attached. */
    private void afterBind() {
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
        putSize(out, "video", videoCapture != null ? videoCapture.getResolutionInfo() : null);
        out.put("mode", videoMode ? "video" : "photo");
        out.put("recording", recording != null);
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
            if (recording != null && want != active) {
                // a recording cannot follow the camera to another unit:
                // stay on this one, at the nearest zoom it can do
                want = active;
                vZoom = active == null ? Math.max(mainZoomMin, vZoom) : Math.min(0.999f, vZoom);
            }
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
     * The viewfinder as it is at this instant, small, as a JPEG data URL —
     * for the shutter's fly-to-gallery animation. It used to be made from
     * the finished photo, which is read back and watermarked in a queue:
     * in a burst the animations trailed the shutter and kept playing after
     * the last press. The view's own pixels are ready at the press.
     */
    @PluginMethod
    public void snapshot(PluginCall call) {
        final int width = Math.max(64, Math.min(640, call.getInt("width", 220)));
        getActivity().runOnUiThread(() -> {
            Bitmap full = null;
            try {
                if (previewView != null) full = previewView.getBitmap();
            } catch (Exception ignored) {
                // nothing on screen
            }
            if (full == null) {
                call.reject("no preview");
                return;
            }
            final Bitmap src = full;
            snapIo.execute(() -> {
                try {
                    int h = Math.max(1, Math.round(src.getHeight() * (width / (float) src.getWidth())));
                    Bitmap small = Bitmap.createScaledBitmap(src, width, h, true);
                    java.io.ByteArrayOutputStream jpeg = new java.io.ByteArrayOutputStream();
                    small.compress(Bitmap.CompressFormat.JPEG, 60, jpeg);
                    if (small != src) small.recycle();
                    JSObject out = new JSObject();
                    out.put("dataUrl", "data:image/jpeg;base64,"
                        + android.util.Base64.encodeToString(jpeg.toByteArray(), android.util.Base64.NO_WRAP));
                    call.resolve(out);
                } catch (Exception e) {
                    call.reject("snapshot failed: " + e.getMessage());
                } finally {
                    src.recycle();
                }
            });
        });
    }

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
                    // the upright size, so the card can be drawn for it
                    // before anything decodes the photo
                    try {
                        android.graphics.BitmapFactory.Options b = new android.graphics.BitmapFactory.Options();
                        b.inJustDecodeBounds = true;
                        android.graphics.BitmapFactory.decodeFile(out.getAbsolutePath(), b);
                        int o = new androidx.exifinterface.media.ExifInterface(out.getAbsolutePath())
                            .getRotationDegrees();
                        boolean turn = o == 90 || o == 270;
                        res.put("width", turn ? b.outHeight : b.outWidth);
                        res.put("height", turn ? b.outWidth : b.outHeight);
                    } catch (Exception ignored) {
                        // the web layer decodes it instead
                    }
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

    // ---- video ---------------------------------------------------------

    private void ensureOverlay() {
        if (overlay != null) return;
        overlayThread = new android.os.HandlerThread("card-overlay");
        overlayThread.start();
        overlay = new OverlayEffect(CameraEffect.VIDEO_CAPTURE, 0,
            new Handler(overlayThread.getLooper()),
            t -> Log.w("NativeCamera", "card overlay failed", t));
        final Paint paint = new Paint(Paint.FILTER_BITMAP_FLAG | Paint.ANTI_ALIAS_FLAG);
        overlay.setOnDrawListener(frame -> {
            android.graphics.Canvas c = frame.getOverlayCanvas();
            c.drawColor(Color.TRANSPARENT, android.graphics.PorterDuff.Mode.CLEAR);
            List<Placed> bands = overlayBands;
            int ow = overlayW, oh = overlayH;
            if (bands.isEmpty() || ow <= 0 || oh <= 0) return true;
            // The card is drawn upright for the video as it will play; the
            // buffer is the sensor's frame, turned by getRotationDegrees()
            // on playback. Map upright -> buffer.
            android.graphics.Rect crop = frame.getCropRect();
            int r = ((frame.getRotationDegrees() % 360) + 360) % 360;
            int uw = r % 180 == 0 ? crop.width() : crop.height();
            int uh = r % 180 == 0 ? crop.height() : crop.width();
            Matrix m = new Matrix();
            m.postScale(uw / (float) ow, uh / (float) oh);
            // a mirrored recording must still read left to right
            if (frame.isMirroring()) m.postScale(-1f, 1f, uw / 2f, 0f);
            m.postRotate(-r);
            android.graphics.RectF box = new android.graphics.RectF(0, 0, uw, uh);
            Matrix turn = new Matrix();
            turn.setRotate(-r);
            turn.mapRect(box);
            m.postTranslate(crop.left - box.left, crop.top - box.top);
            c.save();
            c.concat(m);
            for (Placed b : bands) c.drawBitmap(b.bmp, b.x, b.y, paint);
            c.restore();
            return true;
        });
    }

    /**
     * The card for recordings: strips of it, upright, for a frame of
     * {@code width} x {@code height}. Replaces the previous card; the next
     * recorded frame shows it.
     */
    @PluginMethod
    public void setOverlay(PluginCall call) {
        final JSArray bandsIn = call.getArray("bands", new JSArray());
        final int w = call.getInt("width", 0);
        final int h = call.getInt("height", 0);
        compositeIo.execute(() -> {
            try {
                List<Placed> next = new ArrayList<>();
                for (int i = 0; i < bandsIn.length(); i++) {
                    org.json.JSONObject b = bandsIn.getJSONObject(i);
                    byte[] img = StillCompositor.b64(b.optString("png", ""));
                    if (img == null) continue;
                    Bitmap bmp = android.graphics.BitmapFactory.decodeByteArray(img, 0, img.length);
                    if (bmp != null) next.add(new Placed(bmp, b.optInt("x", 0), b.optInt("y", 0)));
                }
                overlayW = w;
                overlayH = h;
                overlayBands = next;
                call.resolve();
            } catch (Exception e) {
                call.reject("overlay failed: " + e.getMessage());
            }
        });
    }

    /**
     * Photo or video: rebinds the camera for the other mode behind the last
     * frame, the way a lens change does — no stop, no second camera, no
     * black flash.
     */
    @PluginMethod
    public void setMode(PluginCall call) {
        final boolean video = "video".equals(call.getString("mode", "photo"));
        final int longEdge = call.getInt("recordLongEdge", recordLongEdge);
        final int bitrate = call.getInt("recordBitrate", recordBitrate);
        getActivity().runOnUiThread(() -> {
            if (camera == null) {
                call.reject("camera not running");
                return;
            }
            if (recording != null) {
                call.reject("recording");
                return;
            }
            if (video == videoMode && longEdge == recordLongEdge && bitrate == recordBitrate) {
                call.resolve(describe());
                return;
            }
            videoMode = video;
            wide169 = video;
            recordLongEdge = longEdge;
            recordBitrate = bitrate;
            freeze();
            switching = true;
            main.post(() -> {
                try {
                    bindTo(active != null ? active.selector : mainSelector);
                } catch (Exception e) {
                    endSwitch();
                    call.reject("mode change failed: " + e.getMessage());
                    return;
                }
                applyRatio();
                awaitingStream = true;
                main.postDelayed(freezeTimeout, FREEZE_MAX_MS);
                call.resolve(describe());
            });
        });
    }

    /**
     * Start recording, natively, with the card in every frame.
     * {@code rotation}: how the phone is held, fixed for the whole clip.
     * {@code lat}/{@code lng}: written into the MP4's location atom.
     */
    @SuppressLint({"MissingPermission", "UnsafeOptInUsageError"})
    @PluginMethod
    public void startRecording(PluginCall call) {
        final int rot = call.getInt("rotation", 0);
        final Double lat = call.getDouble("lat");
        final Double lng = call.getDouble("lng");
        getActivity().runOnUiThread(() -> {
            if (videoCapture == null || camera == null) {
                call.reject("not in video mode");
                return;
            }
            if (recording != null) {
                call.reject("already recording");
                return;
            }
            try {
                videoCapture.setTargetRotation(surfaceRotation(rot));
                recordFile = new File(getContext().getCacheDir(), "native-vid-" + System.nanoTime() + ".mp4");
                FileOutputOptions.Builder ob = new FileOutputOptions.Builder(recordFile);
                if (lat != null && lng != null) {
                    android.location.Location loc = new android.location.Location("gps");
                    loc.setLatitude(lat);
                    loc.setLongitude(lng);
                    ob.setLocation(loc);
                }
                PendingRecording pr = videoCapture.getOutput()
                    .prepareRecording(getContext(), ob.build());
                boolean mic = getPermissionState("microphone") == com.getcapacitor.PermissionState.GRANTED
                    || ContextCompat.checkSelfPermission(getContext(), android.Manifest.permission.RECORD_AUDIO)
                        == android.content.pm.PackageManager.PERMISSION_GRANTED;
                if (mic) pr = pr.withAudioEnabled();
                final boolean[] started = {false};
                recordStartedAt = System.currentTimeMillis();
                recording = pr.start(ContextCompat.getMainExecutor(getContext()), ev -> {
                    if (ev instanceof VideoRecordEvent.Start && !started[0]) {
                        started[0] = true;
                        JSObject out = new JSObject();
                        out.put("ok", true);
                        out.put("audio", mic);
                        out.put("startedAt", recordStartedAt);
                        call.resolve(out);
                    } else if (ev instanceof VideoRecordEvent.Finalize) {
                        onFinalized((VideoRecordEvent.Finalize) ev);
                        if (!started[0]) {
                            started[0] = true;
                            call.reject("recording did not start");
                        }
                    }
                });
            } catch (Exception e) {
                recording = null;
                call.reject("could not record: " + e.getMessage());
            }
        });
    }

    /** Stop; resolves once the file is finished and in the gallery. */
    @PluginMethod
    public void stopRecording(PluginCall call) {
        call.setKeepAlive(false);
        getActivity().runOnUiThread(() -> {
            if (recording == null) {
                call.reject("not recording");
                return;
            }
            stopCall = call;
            try {
                recording.stop();
            } catch (Exception e) {
                stopCall = null;
                call.reject("stop failed: " + e.getMessage());
            }
        });
    }

    private void onFinalized(VideoRecordEvent.Finalize fin) {
        recording = null;
        final File f = recordFile;
        final long startedAt = recordStartedAt;
        final PluginCall pending = stopCall;
        stopCall = null;
        final int err = fin.getError();
        final long durNs = fin.getRecordingStats().getRecordedDurationNanos();
        // the page's name when it asked for the stop; ours, in the same
        // form, when the recording ended without it (an error, or the app
        // going to the background) — the clip still reaches the gallery
        String asked = pending != null ? pending.getString("galleryName", null) : null;
        final String galleryName = asked != null && !asked.isEmpty() ? asked
            : "VID_" + new java.text.SimpleDateFormat("yyyyMMdd_HHmmss", java.util.Locale.US)
                .format(new java.util.Date(startedAt)) + "_gpscam.mp4";
        compositeIo.execute(() -> {
            JSObject out = new JSObject();
            boolean usable = f != null && f.exists() && f.length() > 0
                && (err == VideoRecordEvent.Finalize.ERROR_NONE
                    || err == VideoRecordEvent.Finalize.ERROR_SOURCE_INACTIVE
                    || err == VideoRecordEvent.Finalize.ERROR_INSUFFICIENT_STORAGE
                    || err == VideoRecordEvent.Finalize.ERROR_DURATION_LIMIT_REACHED
                    || err == VideoRecordEvent.Finalize.ERROR_FILE_SIZE_LIMIT_REACHED);
            out.put("ok", usable);
            out.put("error", err);
            out.put("durationMs", durNs / 1_000_000L);
            out.put("startedAt", startedAt);
            if (usable) {
                out.put("path", f.getAbsolutePath());
                out.put("bytes", f.length());
                try {
                    android.media.MediaMetadataRetriever mr = new android.media.MediaMetadataRetriever();
                    mr.setDataSource(f.getAbsolutePath());
                    String vw = mr.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH);
                    String vh = mr.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT);
                    String vr = mr.extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION);
                    int w = vw != null ? Integer.parseInt(vw) : 0;
                    int h = vh != null ? Integer.parseInt(vh) : 0;
                    int rr = vr != null ? Integer.parseInt(vr) : 0;
                    out.put("width", rr % 180 == 0 ? w : h);
                    out.put("height", rr % 180 == 0 ? h : w);
                    // a still from the middle of the first second, for the thumbnail
                    Bitmap frame = mr.getFrameAtTime(300_000L, android.media.MediaMetadataRetriever.OPTION_CLOSEST_SYNC);
                    if (frame != null) {
                        int tw = 480;
                        int th = Math.max(1, Math.round(frame.getHeight() * (tw / (float) frame.getWidth())));
                        if (frame.getHeight() > frame.getWidth()) {
                            th = 480;
                            tw = Math.max(1, Math.round(frame.getWidth() * (th / (float) frame.getHeight())));
                        }
                        Bitmap small = Bitmap.createScaledBitmap(frame, tw, th, true);
                        File thumb = new File(getContext().getCacheDir(), f.getName().replace(".mp4", "-thm.jpg"));
                        try (java.io.FileOutputStream os = new java.io.FileOutputStream(thumb)) {
                            small.compress(Bitmap.CompressFormat.JPEG, 80, os);
                        }
                        out.put("thumb", thumb.getAbsolutePath());
                    }
                    mr.release();
                } catch (Exception e) {
                    Log.w("NativeCamera", "video probe failed", e);
                }
                if (galleryName != null) {
                    try {
                        out.put("saved", saveVideoToGallery(f, galleryName, startedAt));
                    } catch (Exception e) {
                        Log.w("NativeCamera", "video gallery save failed", e);
                        out.put("saved", false);
                    }
                }
            } else if (f != null) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
            out.put("asked", pending != null);
            if (pending != null) pending.resolve(out);
            // also tell the page when nobody asked: an error or the app
            // going to the background ended the recording. Kept until the
            // page is listening again, so the clip is filed in the app too.
            else notifyListeners("recorded", out, true);
        });
    }

    private boolean saveVideoToGallery(File f, String name, long takenAt) throws java.io.IOException {
        android.content.ContentResolver cr = getContext().getContentResolver();
        if (android.os.Build.VERSION.SDK_INT >= 29) {
            android.content.ContentValues v = new android.content.ContentValues();
            v.put(android.provider.MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(android.provider.MediaStore.MediaColumns.MIME_TYPE, "video/mp4");
            v.put(android.provider.MediaStore.MediaColumns.RELATIVE_PATH,
                android.os.Environment.DIRECTORY_DCIM + "/GPS Camera");
            v.put(android.provider.MediaStore.Video.Media.DATE_TAKEN, takenAt);
            v.put(android.provider.MediaStore.MediaColumns.IS_PENDING, 1);
            android.net.Uri uri = cr.insert(android.provider.MediaStore.Video.Media.EXTERNAL_CONTENT_URI, v);
            if (uri == null) return false;
            try (java.io.InputStream in = new java.io.FileInputStream(f);
                 java.io.OutputStream os = cr.openOutputStream(uri)) {
                if (os == null) throw new java.io.IOException("no gallery stream");
                byte[] buf = new byte[1 << 16];
                int n;
                while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
            } catch (java.io.IOException e) {
                cr.delete(uri, null, null);
                throw e;
            }
            android.content.ContentValues done = new android.content.ContentValues();
            done.put(android.provider.MediaStore.MediaColumns.IS_PENDING, 0);
            cr.update(uri, done, null, null);
            return true;
        }
        File dir = new File(android.os.Environment.getExternalStoragePublicDirectory(
            android.os.Environment.DIRECTORY_DCIM), "GPS Camera");
        if (!dir.exists() && !dir.mkdirs()) return false;
        File out = new File(dir, name);
        try (java.io.InputStream in = new java.io.FileInputStream(f);
             java.io.OutputStream os = new java.io.FileOutputStream(out)) {
            byte[] buf = new byte[1 << 16];
            int n;
            while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
        }
        android.media.MediaScannerConnection.scanFile(getContext(),
            new String[] {out.getAbsolutePath()}, new String[] {"video/mp4"}, null);
        return true;
    }

    /** finishes stills: never queued behind a capture being written */
    private final ExecutorService compositeIo = Executors.newSingleThreadExecutor();

    /**
     * Finish a still natively (StillCompositor): upright, the card's bands
     * drawn on, encoded once with the EXIF block, saved to the gallery when
     * {@code galleryName} is given, plus a thumbnail. Resolves with the
     * finished file, the thumbnail and where each step's time went.
     *
     * {@code bands}: [{x, y, png (base64)}] in the upright frame.
     * {@code exif}: base64 APP1 payload, or empty.
     */
    @PluginMethod
    public void composite(PluginCall call) {
        final String path = call.getString("path", "");
        final JSArray bandsIn = call.getArray("bands", new JSArray());
        final boolean mirror = Boolean.TRUE.equals(call.getBoolean("mirror", false));
        final String exif = call.getString("exif", "");
        final int quality = Math.max(50, Math.min(100, call.getInt("quality", 92)));
        final String galleryName = call.getString("galleryName", null);
        final long takenAt = call.getLong("takenAt", System.currentTimeMillis());
        compositeIo.execute(() -> {
            try {
                File still = new File(path);
                File cache = getContext().getCacheDir();
                if (!cache.equals(still.getParentFile()) || !still.getName().startsWith("native-cap-")) {
                    call.reject("not a capture file");
                    return;
                }
                List<StillCompositor.Band> bands = new ArrayList<>();
                for (int i = 0; i < bandsIn.length(); i++) {
                    org.json.JSONObject b = bandsIn.getJSONObject(i);
                    byte[] png = StillCompositor.b64(b.optString("png", ""));
                    if (png != null) bands.add(new StillCompositor.Band(b.optInt("x", 0), b.optInt("y", 0), png));
                }
                StillCompositor.Result r = StillCompositor.run(getContext(), still, bands, mirror,
                    StillCompositor.b64(exif), quality, 480,
                    galleryName != null && !galleryName.isEmpty() ? galleryName : null, takenAt);
                JSObject out = new JSObject();
                out.put("path", r.finalFile.getAbsolutePath());
                out.put("thumb", r.thumbFile.getAbsolutePath());
                out.put("width", r.width);
                out.put("height", r.height);
                out.put("saved", r.galleryUri != null);
                out.put("decodeMs", r.decodeMs);
                out.put("drawMs", r.drawMs);
                out.put("encodeMs", r.encodeMs);
                out.put("saveMs", r.saveMs);
                call.resolve(out);
            } catch (Throwable e) {
                Log.w("NativeCamera", "composite failed", e);
                call.reject("composite failed: " + e.getMessage());
            }
        });
    }

    /** Delete a still the web layer has finished reading. */
    @PluginMethod
    public void release(PluginCall call) {
        String path = call.getString("path", "");
        try {
            File f = new File(path);
            File cache = getContext().getCacheDir();
            // only ever our own capture files
            String n = f.getName();
            if ((n.startsWith("native-cap-") || n.startsWith("native-fin-") || n.startsWith("native-thm-")
                    || n.startsWith("native-vid-"))
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
                (dir, name) -> name.startsWith("native-cap-")
                    || name.startsWith("native-fin-") || name.startsWith("native-thm-"));
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
