package city.reclaimchennai.gpscam.wm

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import city.reclaimchennai.gpscam.geo.GeoFeature
import city.reclaimchennai.gpscam.geo.GeoPack
import city.reclaimchennai.gpscam.geo.LookupResult
import kotlin.math.max
import kotlin.math.min

/**
 * Offline vector mini-map: matched ward outline + neighbour boundaries +
 * a pin, drawn from the pack polygons. Port of the web renderer, same
 * palette, no third-party tiles.
 */
object MiniMap {
    private const val SIZE = 256

    fun render(pack: GeoPack, result: LookupResult?, lat: Double, lng: Double): Bitmap {
        val focus = result?.wardFeature ?: result?.loFeature
        val bmp = Bitmap.createBitmap(SIZE, SIZE, Bitmap.Config.ARGB_8888)
        val c = Canvas(bmp)
        c.drawColor(Color.parseColor("#17212b"))

        var minX: Double; var minY: Double; var maxX: Double; var maxY: Double
        val fb = focus?.bbox
        if (fb != null) {
            minX = fb[0]; minY = fb[1]; maxX = fb[2]; maxY = fb[3]
        } else {
            minX = lng - 0.006; minY = lat - 0.006
            maxX = lng + 0.006; maxY = lat + 0.006
        }
        minX = min(minX, lng); maxX = max(maxX, lng)
        minY = min(minY, lat); maxY = max(maxY, lat)
        var padX = (maxX - minX) * 0.25
        if (padX == 0.0) padX = 0.002
        var padY = (maxY - minY) * 0.25
        if (padY == 0.0) padY = 0.002
        minX -= padX; maxX += padX; minY -= padY; maxY += padY
        val spanX = maxX - minX; val spanY = maxY - minY
        if (spanX > spanY) { val g = (spanX - spanY) / 2; minY -= g; maxY += g }
        else { val g = (spanY - spanX) / 2; minX -= g; maxX += g }

        fun px(x: Double) = ((x - minX) / (maxX - minX) * SIZE).toFloat()
        fun py(y: Double) = (SIZE - (y - minY) / (maxY - minY) * SIZE).toFloat()

        val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
        val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }

        fun draw(f: GeoFeature, color: Int, fillColor: Int?) {
            val path = Path()
            for (rings in f.polygons) for (ring in rings) {
                for (i in 0 until ring.size / 2) {
                    val x = px(ring[i * 2]); val y = py(ring[i * 2 + 1])
                    if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
                }
                path.close()
            }
            if (fillColor != null) {
                fill.color = fillColor
                c.drawPath(path, fill)
            }
            stroke.color = color
            stroke.strokeWidth = if (fillColor != null) 2f else 1f
            c.drawPath(path, stroke)
        }

        val layer = if (result?.wardFeature != null) pack.ulb else pack.lo
        var drawn = 0
        for (f in layer.features) {
            val b = f.bbox ?: continue
            if (b[0] > maxX || b[2] < minX || b[1] > maxY || b[3] < minY) continue
            if (f === focus) continue
            draw(f, Color.argb(115, 148, 163, 184), null)
            if (++drawn > 40) break
        }
        focus?.let { draw(it, Color.parseColor("#38bdf8"), Color.argb(36, 56, 189, 248)) }

        val cx = px(lng); val cy = py(lat)
        fill.color = Color.parseColor("#f43f5e")
        c.drawCircle(cx, cy, 7f, fill)
        stroke.color = Color.WHITE
        stroke.strokeWidth = 2.5f
        c.drawCircle(cx, cy, 7f, stroke)
        return bmp
    }
}
