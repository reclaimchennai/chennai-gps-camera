package city.reclaimchennai.gpscam

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import city.reclaimchennai.gpscam.audio.SoundMeter
import city.reclaimchennai.gpscam.camera.CameraScreen
import city.reclaimchennai.gpscam.gallery.GalleryScreen
import city.reclaimchennai.gpscam.gallery.queryGallery
import city.reclaimchennai.gpscam.loc.LocationEngine
import city.reclaimchennai.gpscam.settings.Prefs
import city.reclaimchennai.gpscam.settings.SettingsScreen
import city.reclaimchennai.gpscam.wm.WatermarkPrefs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private enum class Screen { Camera, Gallery, Settings }

class MainActivity : ComponentActivity() {
    private lateinit var locationEngine: LocationEngine
    private lateinit var soundMeter: SoundMeter

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        locationEngine = LocationEngine(applicationContext, lifecycleScope)
        soundMeter = SoundMeter(lifecycleScope)

        val permissionLauncher = registerForActivityResult(
            ActivityResultContracts.RequestMultiplePermissions()
        ) { grants ->
            if (grants[Manifest.permission.ACCESS_FINE_LOCATION] == true) {
                locationEngine.start()
            }
            if (grants[Manifest.permission.RECORD_AUDIO] == true) {
                soundMeter.start()
            }
        }

        setContent {
            val dark = isSystemInDarkTheme()
            val scheme = if (android.os.Build.VERSION.SDK_INT >= 31) {
                if (dark) dynamicDarkColorScheme(this) else dynamicLightColorScheme(this)
            } else if (dark) darkColorScheme() else lightColorScheme()

            MaterialTheme(colorScheme = scheme) {
                App()
            }
        }

        val wanted = arrayOf(
            Manifest.permission.CAMERA,
            Manifest.permission.RECORD_AUDIO,
            Manifest.permission.ACCESS_FINE_LOCATION,
        )
        val missing = wanted.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) {
            locationEngine.start()
            soundMeter.start()
        } else {
            permissionLauncher.launch(missing.toTypedArray())
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        locationEngine.stop()
        soundMeter.stop()
    }

    @Composable
    private fun App() {
        var screen by remember { mutableStateOf(Screen.Camera) }
        val geo by locationEngine.state.collectAsState()
        val noise by soundMeter.stats.collectAsState()
        val prefs by Prefs.watermark(this).collectAsState(initial = WatermarkPrefs())
        val calibration by Prefs.calibration(this).collectAsState(initial = 0)
        var lastThumb by remember { mutableStateOf<Bitmap?>(null) }

        LaunchedEffect(calibration) { soundMeter.calibration = calibration }

        // seed the gallery-button thumbnail from the newest saved photo
        LaunchedEffect(Unit) {
            val newest = queryGallery(this@MainActivity).firstOrNull() ?: return@LaunchedEffect
            lastThumb = loadThumb(newest.uri)
        }

        BackHandler(enabled = screen != Screen.Camera) { screen = Screen.Camera }

        when (screen) {
            Screen.Camera -> CameraScreen(
                geo = geo,
                noise = noise,
                prefs = prefs,
                lastThumb = lastThumb,
                onCaptured = { uri ->
                    lifecycleScope.launch { lastThumb = loadThumb(uri) }
                },
                onOpenGallery = { screen = Screen.Gallery },
                onOpenSettings = { screen = Screen.Settings },
            )
            Screen.Gallery -> GalleryScreen(onBack = { screen = Screen.Camera })
            Screen.Settings -> SettingsScreen(
                prefs = prefs,
                calibration = calibration,
                noise = noise,
                onBack = { screen = Screen.Camera },
            )
        }
    }

    private suspend fun loadThumb(uri: android.net.Uri): Bitmap? =
        withContext(Dispatchers.IO) {
            runCatching {
                if (android.os.Build.VERSION.SDK_INT >= 29) {
                    contentResolver.loadThumbnail(uri, android.util.Size(128, 128), null)
                } else {
                    @Suppress("DEPRECATION")
                    android.provider.MediaStore.Images.Media.getBitmap(contentResolver, uri)
                }
            }.getOrNull()
        }
}
