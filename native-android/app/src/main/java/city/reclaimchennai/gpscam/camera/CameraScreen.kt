package city.reclaimchennai.gpscam.camera

import android.graphics.Bitmap
import android.net.Uri
import androidx.camera.core.Camera
import androidx.camera.core.CameraSelector
import androidx.camera.core.FocusMeteringAction
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Cameraswitch
import androidx.compose.material.icons.filled.PhotoLibrary
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import city.reclaimchennai.gpscam.capture.CaptureRepo
import city.reclaimchennai.gpscam.geo.Packs
import city.reclaimchennai.gpscam.loc.LiveGeo
import city.reclaimchennai.gpscam.audio.NoiseStats
import city.reclaimchennai.gpscam.wm.MiniMap
import city.reclaimchennai.gpscam.wm.Watermark
import city.reclaimchennai.gpscam.wm.WatermarkData
import city.reclaimchennai.gpscam.wm.WatermarkPrefs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** The live viewfinder: CameraX preview + a Compose-drawn watermark
 *  overlay + shutter. Pinch zooms through the camera's REAL zoom range
 *  (CameraX handles ultra-wide lens switching where the OEM exposes a
 *  logical multi-camera). */
@Composable
fun CameraScreen(
    geo: LiveGeo,
    noise: NoiseStats?,
    prefs: WatermarkPrefs,
    lastThumb: Bitmap?,
    onCaptured: (Uri) -> Unit,
    onOpenGallery: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    val context = LocalContext.current
    val lifecycle = LocalLifecycleOwner.current
    val scope = rememberCoroutineScope()

    var camera by remember { mutableStateOf<Camera?>(null) }
    var imageCapture by remember { mutableStateOf<ImageCapture?>(null) }
    var facingBack by remember { mutableStateOf(true) }
    var torch by remember { mutableStateOf(false) }
    var flash by remember { mutableStateOf(0) }
    var overlay by remember { mutableStateOf<Bitmap?>(null) }
    var overlaySize by remember { mutableStateOf(0 to 0) }
    val previewView = remember { PreviewView(context) }

    // (re)bind the camera when facing changes
    DisposableEffect(facingBack) {
        val providerFuture = ProcessCameraProvider.getInstance(context)
        providerFuture.addListener({
            val provider = providerFuture.get()
            val preview = Preview.Builder().build().also {
                it.surfaceProvider = previewView.surfaceProvider
            }
            val capture = ImageCapture.Builder()
                .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
                .build()
            val selector = if (facingBack) CameraSelector.DEFAULT_BACK_CAMERA
            else CameraSelector.DEFAULT_FRONT_CAMERA
            provider.unbindAll()
            camera = provider.bindToLifecycle(lifecycle, selector, preview, capture)
            imageCapture = capture
        }, ContextCompat.getMainExecutor(context))
        onDispose {
            runCatching { ProcessCameraProvider.getInstance(context).get().unbindAll() }
        }
    }

    // live watermark overlay — re-rendered ~2×/s off the main thread
    LaunchedEffect(geo, noise, prefs, overlaySize) {
        val (w, h) = overlaySize
        if (w <= 0 || h <= 0) return@LaunchedEffect
        withContext(Dispatchers.Default) {
            val map = if (prefs.showMiniMap && geo.lat != null && geo.lng != null) {
                Packs.packFor(context, geo.lat, geo.lng)?.let {
                    MiniMap.render(it, geo.lookup, geo.lat, geo.lng)
                }
            } else null
            val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            Watermark.draw(
                android.graphics.Canvas(bmp), w, h,
                data = WatermarkData(
                    lat = geo.lat, lng = geo.lng,
                    address = geo.address, locality = geo.locality,
                    digipin = geo.digipin,
                    jurisdiction = geo.lookup?.jurisdiction,
                    noiseAvg = noise?.avg, noiseMin = noise?.min, noiseMax = noise?.max,
                    timestampMs = System.currentTimeMillis(),
                ),
                prefs = prefs,
                miniMap = map,
            )
            overlay = bmp
        }
    }

    fun shoot() {
        val capture = imageCapture ?: return
        val geoNow = geo
        val noiseNow = noise
        flash++
        capture.takePicture(
            ContextCompat.getMainExecutor(context),
            object : ImageCapture.OnImageCapturedCallback() {
                override fun onCaptureSuccess(image: ImageProxy) {
                    val rotation = image.imageInfo.rotationDegrees
                    val buf = image.planes[0].buffer
                    val bytes = ByteArray(buf.remaining()).also { buf.get(it) }
                    image.close()
                    scope.launch {
                        val map = if (prefs.showMiniMap && geoNow.lat != null && geoNow.lng != null)
                            Packs.packFor(context, geoNow.lat, geoNow.lng)
                                ?.let { MiniMap.render(it, geoNow.lookup, geoNow.lat, geoNow.lng) }
                        else null
                        val uri = CaptureRepo.save(
                            context, bytes, rotation,
                            WatermarkData(
                                lat = geoNow.lat, lng = geoNow.lng,
                                address = geoNow.address, locality = geoNow.locality,
                                digipin = geoNow.digipin,
                                jurisdiction = geoNow.lookup?.jurisdiction,
                                noiseAvg = noiseNow?.avg,
                                noiseMin = noiseNow?.min,
                                noiseMax = noiseNow?.max,
                                timestampMs = System.currentTimeMillis(),
                            ),
                            prefs, map,
                        )
                        if (uri != null) onCaptured(uri)
                    }
                }

                override fun onError(exception: ImageCaptureException) = Unit
            }
        )
    }

    Box(Modifier.fillMaxSize().background(Color.Black)) {
        AndroidView(
            factory = { previewView },
            modifier = Modifier
                .fillMaxSize()
                .onSizeChanged { overlaySize = it.width to it.height }
                .pointerInput(Unit) {
                    detectTransformGestures { _, _, zoomChange, _ ->
                        val cam = camera ?: return@detectTransformGestures
                        val z = cam.cameraInfo.zoomState.value ?: return@detectTransformGestures
                        val target = (z.zoomRatio * zoomChange)
                            .coerceIn(z.minZoomRatio, z.maxZoomRatio)
                        cam.cameraControl.setZoomRatio(target)
                    }
                }
                .pointerInput(Unit) {
                    detectTapGestures { offset ->
                        val cam = camera ?: return@detectTapGestures
                        val factory = previewView.meteringPointFactory
                        val point = factory.createPoint(offset.x, offset.y)
                        cam.cameraControl.startFocusAndMetering(
                            FocusMeteringAction.Builder(point).build()
                        )
                    }
                }
        )

        // live watermark card
        overlay?.let {
            Image(
                bitmap = it.asImageBitmap(),
                contentDescription = null,
                modifier = Modifier.fillMaxSize()
            )
        }

        // top-right: flash + settings
        Row(
            Modifier
                .align(Alignment.TopEnd)
                .statusBarsPadding()
                .padding(8.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            RoundIcon(active = torch, onClick = {
                torch = !torch
                camera?.cameraControl?.enableTorch(torch)
            }) { Icon(Icons.Filled.Bolt, "Flash", tint = Color.White) }
            RoundIcon(onClick = onOpenSettings) {
                Icon(Icons.Filled.Settings, "Settings", tint = Color.White)
            }
        }

        // bottom controls
        Row(
            Modifier
                .align(Alignment.BottomCenter)
                .navigationBarsPadding()
                .fillMaxWidth()
                .padding(horizontal = 28.dp, vertical = 20.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(
                Modifier
                    .size(52.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(Color(0x66000000))
                    .pointerInput(Unit) { detectTapGestures { onOpenGallery() } },
                contentAlignment = Alignment.Center
            ) {
                if (lastThumb != null) Image(
                    lastThumb.asImageBitmap(), null,
                    modifier = Modifier.fillMaxSize()
                ) else Icon(Icons.Filled.PhotoLibrary, "Gallery", tint = Color.White)
            }

            // shutter
            Box(
                Modifier
                    .size(74.dp)
                    .clip(CircleShape)
                    .background(Color.White)
                    .padding(5.dp)
                    .clip(CircleShape)
                    .background(Color(0xFF3A3A3A))
                    .pointerInput(Unit) { detectTapGestures { shoot() } }
            )

            RoundIcon(onClick = { facingBack = !facingBack }) {
                Icon(Icons.Filled.Cameraswitch, "Switch camera", tint = Color.White)
            }
        }

        // shutter flash effect
        if (flash > 0) {
            val alpha by remember(flash) { mutableStateOf(0f) }
            Box(
                Modifier
                    .fillMaxSize()
                    .graphicsLayer { this.alpha = alpha }
                    .background(Color.White)
            )
        }
    }
}

@Composable
private fun RoundIcon(
    active: Boolean = false,
    onClick: () -> Unit,
    content: @Composable () -> Unit,
) {
    IconButton(
        onClick = onClick,
        modifier = Modifier
            .clip(CircleShape)
            .background(
                if (active) MaterialTheme.colorScheme.primary.copy(alpha = 0.7f)
                else Color(0x66000000)
            )
    ) { content() }
}
