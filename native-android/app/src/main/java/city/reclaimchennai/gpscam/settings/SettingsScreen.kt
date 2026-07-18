package city.reclaimchennai.gpscam.settings

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Slider
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import city.reclaimchennai.gpscam.audio.NoiseStats
import city.reclaimchennai.gpscam.wm.WatermarkPrefs
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    prefs: WatermarkPrefs,
    calibration: Int,
    noise: NoiseStats?,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    fun update(p: WatermarkPrefs) = scope.launch { Prefs.setWatermark(context, p) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back")
                    }
                },
            )
        }
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp)
        ) {
            Text("Watermark", style = MaterialTheme.typography.titleMedium)

            ToggleRow("Full address", prefs.showAddress) {
                update(prefs.copy(showAddress = it))
            }
            ToggleRow("DIGIPIN", prefs.showDigipin) {
                update(prefs.copy(showDigipin = it))
            }
            ToggleRow("Zone & ward", prefs.showZoneWard) {
                update(prefs.copy(showZoneWard = it))
            }
            ToggleRow("Police stations", prefs.showPolice) {
                update(prefs.copy(showPolice = it))
            }
            ToggleRow("Mini-map", prefs.showMiniMap) {
                update(prefs.copy(showMiniMap = it))
            }
            ToggleRow("Sound level (dB)", prefs.showNoise) {
                update(prefs.copy(showNoise = it))
            }
            ToggleRow("Card at top", prefs.positionTop) {
                update(prefs.copy(positionTop = it))
            }

            HorizontalDivider(Modifier.padding(vertical = 16.dp))

            Text("Sound meter calibration", style = MaterialTheme.typography.titleMedium)
            Text(
                "Live reading: ${noise?.current?.let { "≈ $it dB" } ?: "listening…"}" +
                    if (calibration != 0) "  (offset ${if (calibration > 0) "+" else ""}$calibration dB)" else "",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 4.dp)
            )
            Slider(
                value = calibration.toFloat(),
                onValueChange = { v ->
                    scope.launch { Prefs.setCalibration(context, v.toInt()) }
                },
                valueRange = -40f..40f,
                steps = 79,
            )

            HorizontalDivider(Modifier.padding(vertical = 16.dp))
            Text(
                "GPS Cam Native v0.1 — the native (Kotlin) variant of the " +
                    "GPS Cam app. Video recording, face blur, annotation and " +
                    "issue reporting are in the standard app while this " +
                    "variant catches up.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun ToggleRow(label: String, value: Boolean, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(label, Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
        Switch(checked = value, onCheckedChange = onChange)
    }
}
