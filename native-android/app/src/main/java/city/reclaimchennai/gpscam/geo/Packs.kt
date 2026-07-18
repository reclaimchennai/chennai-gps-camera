package city.reclaimchennai.gpscam.geo

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Region-pack geodata — same JSON packs the web app uses, shared over
 * the air from the site. The Chennai pack ships in assets (fully offline
 * from install); other regions download on first use and cache on disk.
 */

class GeoFeature(
    val bbox: DoubleArray?,           // minX, minY, maxX, maxY
    val props: Map<String, Any?>,
    /** polygons → rings → flat [x0,y0,x1,y1…]; empty for points */
    val polygons: List<List<DoubleArray>>,
    val point: DoubleArray?,          // lng, lat for station points
)

class GeoLayer(val features: List<GeoFeature>)

class GeoPack(
    val id: String,
    val ulb: GeoLayer,
    val lo: GeoLayer,
    val traffic: GeoLayer,
    val stations: GeoLayer,
)

private class PackMeta(val id: String, val file: String, val bbox: DoubleArray)

object Packs {
    private const val BASE_URL = "https://cam.reclaimchennai.city/data/packs/"
    private var index: List<PackMeta>? = null
    private val cache = HashMap<String, GeoPack>()
    private val mutex = Mutex()

    suspend fun packFor(context: Context, lat: Double, lng: Double): GeoPack? =
        withContext(Dispatchers.IO) {
            mutex.withLock {
                val metas = index ?: loadIndex(context).also { index = it }
                // index order = priority (chennai before the TN catch-all)
                val meta = metas.firstOrNull {
                    lng >= it.bbox[0] && lng <= it.bbox[2] &&
                        lat >= it.bbox[1] && lat <= it.bbox[3]
                } ?: return@withLock null
                cache[meta.id]?.let { return@withLock it }
                val json = readPackJson(context, meta) ?: return@withLock null
                val pack = parsePack(json)
                cache[meta.id] = pack
                pack
            }
        }

    private fun loadIndex(context: Context): List<PackMeta> {
        val text = context.assets.open("packs/index.json")
            .bufferedReader().use { it.readText() }
        val arr = JSONObject(text).getJSONArray("packs")
        return (0 until arr.length()).map { i ->
            val o = arr.getJSONObject(i)
            PackMeta(
                o.getString("id"),
                o.getString("file"),
                o.getJSONArray("bbox").toDoubleArray(),
            )
        }
    }

    private fun readPackJson(context: Context, meta: PackMeta): JSONObject? {
        // bundled?
        runCatching {
            val text = context.assets.open("packs/${meta.file}")
                .bufferedReader().use { it.readText() }
            return JSONObject(text)
        }
        // disk cache?
        val cached = File(context.filesDir, "packs/${meta.file}")
        if (cached.exists()) {
            runCatching { return JSONObject(cached.readText()) }
        }
        // fetch OTA from the site
        return runCatching {
            val conn = URL(BASE_URL + meta.file).openConnection() as HttpURLConnection
            conn.connectTimeout = 10_000
            conn.readTimeout = 30_000
            val text = conn.inputStream.bufferedReader().use { it.readText() }
            cached.parentFile?.mkdirs()
            cached.writeText(text)
            JSONObject(text)
        }.getOrNull()
    }

    private fun parsePack(o: JSONObject): GeoPack {
        val layers = o.getJSONObject("layers")
        fun layer(name: String): GeoLayer {
            val fc = layers.optJSONObject(name) ?: return GeoLayer(emptyList())
            val feats = fc.optJSONArray("features") ?: return GeoLayer(emptyList())
            val out = ArrayList<GeoFeature>(feats.length())
            for (i in 0 until feats.length()) {
                val f = feats.getJSONObject(i)
                val geom = f.optJSONObject("geometry") ?: continue
                val props = f.optJSONObject("properties")?.toMap() ?: emptyMap()
                val bbox = f.optJSONArray("bbox")?.toDoubleArray()
                when (geom.optString("type")) {
                    "Polygon" -> out.add(
                        GeoFeature(bbox, props, listOf(readRings(geom.getJSONArray("coordinates"))), null)
                    )
                    "MultiPolygon" -> {
                        val polys = geom.getJSONArray("coordinates")
                        val list = ArrayList<List<DoubleArray>>(polys.length())
                        for (p in 0 until polys.length()) {
                            list.add(readRings(polys.getJSONArray(p)))
                        }
                        out.add(GeoFeature(bbox, props, list, null))
                    }
                    "Point" -> {
                        val c = geom.getJSONArray("coordinates")
                        out.add(
                            GeoFeature(bbox, props, emptyList(), doubleArrayOf(c.getDouble(0), c.getDouble(1)))
                        )
                    }
                }
            }
            return GeoLayer(out)
        }
        return GeoPack(o.optString("id"), layer("ulb"), layer("lo"), layer("traffic"), layer("stations"))
    }

    /** rings of a single polygon → flat coordinate arrays */
    private fun readRings(rings: JSONArray): List<DoubleArray> {
        val out = ArrayList<DoubleArray>(rings.length())
        for (r in 0 until rings.length()) {
            val ring = rings.getJSONArray(r)
            val flat = DoubleArray(ring.length() * 2)
            for (i in 0 until ring.length()) {
                val pt = ring.getJSONArray(i)
                flat[i * 2] = pt.getDouble(0)
                flat[i * 2 + 1] = pt.getDouble(1)
            }
            out.add(flat)
        }
        return out
    }
}

private fun JSONArray.toDoubleArray(): DoubleArray =
    DoubleArray(length()) { getDouble(it) }

private fun JSONObject.toMap(): Map<String, Any?> =
    keys().asSequence().associateWith { opt(it) }
