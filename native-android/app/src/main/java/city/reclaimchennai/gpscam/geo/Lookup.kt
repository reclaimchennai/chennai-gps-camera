package city.reclaimchennai.gpscam.geo

import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.PI

/**
 * Offline point-in-polygon jurisdiction lookup — port of the proven web
 * implementation: per-feature bbox prefilter, even-odd polygon test
 * (holes included), and a nearest-polygon-edge fallback (400 m) for
 * hairline gaps opened by boundary simplification.
 */

data class Jurisdiction(
    val inScope: Boolean = false,
    val corporation: String? = null,
    val city: String? = null,
    val ward: String? = null,
    val wardName: String? = null,
    val zone: String? = null,
    val wardPending: Boolean = false,
    val loStation: String? = null,
    val trafficStation: String? = null,
)

data class LookupResult(
    val jurisdiction: Jurisdiction,
    val wardFeature: GeoFeature?,
    val loFeature: GeoFeature?,
)

object Lookup {

    fun lookup(pack: GeoPack, lat: Double, lng: Double): LookupResult {
        val ulbF = findContaining(pack.ulb.features, lng, lat)
        val loF = findContaining(pack.lo.features, lng, lat)
            ?: nearestPolygon(pack.lo.features, lng, lat)
        val trF = findContaining(pack.traffic.features, lng, lat)
            ?: nearestPolygon(pack.traffic.features, lng, lat)

        var j = Jurisdiction()
        if (ulbF != null) {
            val p = ulbF.props
            j = j.copy(
                inScope = true,
                corporation = p["corp"] as? String,
                city = p["city"] as? String,
                ward = p["ward"] as? String,
                wardName = p["wardName"] as? String,
                zone = p["zone"] as? String,
            )
        } else if (loF?.props?.get("avadi") == true) {
            // Avadi has no published ward polygons — only claim it when no
            // local-body polygon matched (mirror of the web rule)
            j = j.copy(
                inScope = true,
                corporation = "Avadi Corporation",
                city = "Avadi",
                wardPending = true,
            )
        }
        if (loF != null) {
            j = j.copy(inScope = true, loStation = loF.props["station"] as? String)
        }
        if (trF != null) {
            j = j.copy(inScope = true, trafficStation = trF.props["station"] as? String)
        }
        return LookupResult(j, ulbF, loF)
    }

    private fun findContaining(
        features: List<GeoFeature>, x: Double, y: Double
    ): GeoFeature? {
        for (f in features) {
            val b = f.bbox
            if (b != null && (x < b[0] || x > b[2] || y < b[1] || y > b[3])) continue
            if (contains(f, x, y)) return f
        }
        return null
    }

    /** even-odd test across every ring of every polygon of the feature */
    private fun contains(f: GeoFeature, x: Double, y: Double): Boolean {
        for (rings in f.polygons) {
            if (rings.isEmpty()) continue
            if (!ringContains(rings[0], x, y)) continue
            var inHole = false
            for (h in 1 until rings.size) {
                if (ringContains(rings[h], x, y)) { inHole = true; break }
            }
            if (!inHole) return true
        }
        return false
    }

    private fun ringContains(ring: DoubleArray, x: Double, y: Double): Boolean {
        var inside = false
        var j = ring.size / 2 - 1
        for (i in 0 until ring.size / 2) {
            val xi = ring[i * 2]; val yi = ring[i * 2 + 1]
            val xj = ring[j * 2]; val yj = ring[j * 2 + 1]
            if ((yi > y) != (yj > y) &&
                x < (xj - xi) * (y - yi) / (yj - yi) + xi
            ) inside = !inside
            j = i
        }
        return inside
    }

    /** closest polygon edge within maxKm — equirectangular approximation */
    private fun nearestPolygon(
        features: List<GeoFeature>, x: Double, y: Double, maxKm: Double = 0.4
    ): GeoFeature? {
        val pad = maxKm / 100.0
        var best: GeoFeature? = null
        var bestKm = Double.MAX_VALUE
        val kx = 111.32 * cos(y * PI / 180.0) // km per deg lng
        val ky = 110.57                        // km per deg lat
        for (f in features) {
            val b = f.bbox
            if (b != null &&
                (x < b[0] - pad || x > b[2] + pad || y < b[1] - pad || y > b[3] + pad)
            ) continue
            for (rings in f.polygons) for (ring in rings) {
                var j2 = ring.size / 2 - 1
                for (i in 0 until ring.size / 2) {
                    val d = segDistKm(
                        x, y,
                        ring[j2 * 2], ring[j2 * 2 + 1],
                        ring[i * 2], ring[i * 2 + 1],
                        kx, ky
                    )
                    if (d < bestKm) { bestKm = d; best = f }
                    j2 = i
                }
            }
        }
        return if (bestKm <= maxKm) best else null
    }

    private fun segDistKm(
        px: Double, py: Double,
        ax: Double, ay: Double, bx: Double, by: Double,
        kx: Double, ky: Double,
    ): Double {
        // project into local km space, then classic point-segment distance
        val pX = px * kx; val pY = py * ky
        val aX = ax * kx; val aY = ay * ky
        val bX = bx * kx; val bY = by * ky
        val dx = bX - aX; val dy = bY - aY
        val len2 = dx * dx + dy * dy
        val t = if (len2 == 0.0) 0.0
        else (((pX - aX) * dx + (pY - aY) * dy) / len2).coerceIn(0.0, 1.0)
        return hypot(pX - (aX + t * dx), pY - (aY + t * dy))
    }
}

/** Zone/ward display formatting — same conventions as the web app:
 *  number first, name in brackets. */
object GeoFormat {
    private val GCC_ZONES = mapOf(
        "thiruvottriyur" to 1, "manali" to 2, "madhavaram" to 3,
        "tondiarpet" to 4, "royapuram" to 5, "thiru-vika-nagar" to 6,
        "ambattur" to 7, "anna nagar" to 8, "teynampet" to 9,
        "kodambakkam" to 10, "valasarvakkam" to 11, "alandur" to 12,
        "adyar" to 13, "perungudi" to 14, "shozhanganallur" to 15,
    )

    fun ward(w: String?): String {
        if (w.isNullOrBlank()) return ""
        val n = w.trimStart('0')
        return n.ifEmpty { w }
    }

    fun zone(zRaw: String?): String {
        if (zRaw.isNullOrBlank()) return ""
        if (zRaw.startsWith("borough", ignoreCase = true)) return zRaw
        var raw = zRaw.replace(Regex("\\s+zone$", RegexOption.IGNORE_CASE), "").trim()
        raw = raw.replace(Regex("^zone\\s*", RegexOption.IGNORE_CASE), "").trim()
        Regex("^(\\d+)(?:\\s+(.+))?$").find(raw)?.let { m ->
            val num = m.groupValues[1].toInt()
            val name = m.groupValues[2].trim()
            return if (name.isEmpty()) "Zone $num" else "Zone $num ($name)"
        }
        Regex("^(.+?)\\s*\\((\\d+)\\)$").find(raw)?.let { m ->
            return "Zone ${m.groupValues[2].toInt()} (${m.groupValues[1].trim()})"
        }
        GCC_ZONES[raw.lowercase()]?.let { return "Zone $it ($raw)" }
        return "Zone $raw"
    }
}
