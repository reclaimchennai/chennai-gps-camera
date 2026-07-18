package city.reclaimchennai.gpscam.loc

import android.annotation.SuppressLint
import android.content.Context
import android.location.Geocoder
import android.os.Build
import android.os.Looper
import city.reclaimchennai.gpscam.geo.Digipin
import city.reclaimchennai.gpscam.geo.LookupResult
import city.reclaimchennai.gpscam.geo.Lookup
import city.reclaimchennai.gpscam.geo.Packs
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import java.util.Locale
import kotlin.math.cos
import kotlin.math.hypot

data class LiveGeo(
    val lat: Double? = null,
    val lng: Double? = null,
    val accuracy: Float? = null,
    val address: String? = null,
    val locality: String? = null,
    val digipin: String? = null,
    val lookup: LookupResult? = null,
)

/**
 * Fused location (balanced first fix, then high accuracy) + the OS
 * geocoder in English + the offline jurisdiction lookup, all folded into
 * one StateFlow the UI and capture pipeline read.
 */
class LocationEngine(private val context: Context, private val scope: CoroutineScope) {
    private val _state = MutableStateFlow(LiveGeo())
    val state: StateFlow<LiveGeo> = _state

    private val fused = LocationServices.getFusedLocationProviderClient(context)
    private var lastLookupAt: Pair<Double, Double>? = null
    private var lastGeocodeAt: Pair<Double, Double>? = null

    private val callback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            val loc = result.lastLocation ?: return
            onFix(loc.latitude, loc.longitude, loc.accuracy)
        }
    }

    @SuppressLint("MissingPermission")
    fun start() {
        val req = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 2000L)
            .setMinUpdateDistanceMeters(2f)
            .build()
        runCatching {
            fused.requestLocationUpdates(req, callback, Looper.getMainLooper())
            fused.lastLocation.addOnSuccessListener { loc ->
                if (loc != null) onFix(loc.latitude, loc.longitude, loc.accuracy)
            }
        }
    }

    fun stop() {
        fused.removeLocationUpdates(callback)
    }

    private fun metersBetween(a: Pair<Double, Double>, lat: Double, lng: Double): Double {
        val dLat = (a.first - lat) * 111_320
        val dLng = (a.second - lng) * 111_320 * cos(lat * Math.PI / 180)
        return hypot(dLat, dLng)
    }

    private fun onFix(lat: Double, lng: Double, acc: Float) {
        _state.value = _state.value.copy(
            lat = lat, lng = lng, accuracy = acc,
            digipin = Digipin.encode(lat, lng),
        )
        val lookAt = lastLookupAt
        if (lookAt == null || metersBetween(lookAt, lat, lng) >= 8 || _state.value.lookup == null) {
            lastLookupAt = lat to lng
            scope.launch(Dispatchers.Default) {
                val pack = Packs.packFor(context, lat, lng) ?: return@launch
                val res = Lookup.lookup(pack, lat, lng)
                _state.value = _state.value.copy(lookup = res)
            }
        }
        val geoAt = lastGeocodeAt
        if (geoAt == null || metersBetween(geoAt, lat, lng) >= 120) {
            lastGeocodeAt = lat to lng
            scope.launch(Dispatchers.IO) { geocode(lat, lng) }
        }
    }

    /** OS geocoder, English — the "System (Android)" path of the web app. */
    private fun geocode(lat: Double, lng: Double) {
        runCatching {
            if (!Geocoder.isPresent()) return
            val geocoder = Geocoder(context, Locale.ENGLISH)
            @Suppress("DEPRECATION")
            val results = geocoder.getFromLocation(lat, lng, 1) ?: return
            val a = results.firstOrNull() ?: return
            val line = (0..a.maxAddressLineIndex)
                .joinToString(", ") { a.getAddressLine(it) }
            val locality = listOfNotNull(a.subLocality, a.locality)
                .distinct().joinToString(", ")
            _state.value = _state.value.copy(
                address = line.ifBlank { null },
                locality = locality.ifBlank { null },
            )
        }
    }
}
