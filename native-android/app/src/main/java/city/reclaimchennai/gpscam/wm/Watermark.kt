package city.reclaimchennai.gpscam.wm

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Typeface
import city.reclaimchennai.gpscam.geo.GeoFormat
import city.reclaimchennai.gpscam.geo.Jurisdiction
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** Everything the card can stamp — assembled by the capture pipeline. */
data class WatermarkData(
    val lat: Double?,
    val lng: Double?,
    val address: String?,
    val locality: String?,
    val digipin: String?,
    val jurisdiction: Jurisdiction?,
    val noiseAvg: Int?,
    val noiseMin: Int?,
    val noiseMax: Int?,
    val timestampMs: Long,
)

data class WatermarkPrefs(
    val showAddress: Boolean = true,
    val showDigipin: Boolean = false,
    val showNoise: Boolean = true,
    val showMiniMap: Boolean = true,
    val showPolice: Boolean = true,
    val showZoneWard: Boolean = true,
    val positionTop: Boolean = false,
)

/**
 * The detailed watermark card, drawn with android.graphics.Canvas —
 * the same layout language as the web renderer: rounded translucent
 * panel, mini-map left, text stack right; corporation on its own line,
 * "Zone N (Name) · Ward N (Name)" next, police clubbed when L&O and
 * Traffic share a station.
 */
object Watermark {

    fun draw(
        canvas: Canvas,
        width: Int,
        height: Int,
        data: WatermarkData,
        prefs: WatermarkPrefs,
        miniMap: Bitmap?,
    ) {
        val s = width / 1080f
        val margin = (width * 0.025f)
        val pad = 18f * s
        val panelW = width - margin * 2
        val bodyPx = max(10f, 26f * s)
        val smallPx = bodyPx * 0.82f
        val titlePx = bodyPx * 1.15f
        val lineGap = bodyPx * 0.45f

        val text = Paint(Paint.ANTI_ALIAS_FLAG)
        val dim = Color.argb(232, 226, 232, 240)
        val bright = Color.WHITE
        val accent = Color.parseColor("#7dd3fc")

        val mapSize = if (prefs.showMiniMap && miniMap != null)
            min(220f * s, panelW * 0.3f) else 0f
        val mapGap = if (mapSize > 0) pad else 0f
        val textW = panelW - pad * 2 - mapSize - mapGap

        data class Line(val str: String, val px: Float, val color: Int, val bold: Boolean, val gapBefore: Float = 0f)
        val lines = ArrayList<Line>()

        val title = data.locality ?: data.jurisdiction?.city
        if (title != null) lines.add(Line(title, titlePx, bright, true))
        if (prefs.showAddress && data.address != null) {
            wrap(data.address, text.apply { textSize = bodyPx }, textW, 3)
                .forEach { lines.add(Line(it, bodyPx, dim, false)) }
        }
        if (data.lat != null && data.lng != null) {
            lines.add(Line(
                "Lat %.6f°  Long %.6f°".format(data.lat, data.lng),
                bodyPx, dim, false
            ))
            if (prefs.showDigipin && data.digipin != null) {
                lines.add(Line("DIGIPIN: ${data.digipin}", bodyPx, dim, false))
            }
        }
        lines.add(Line(dateLine(data.timestampMs), bodyPx, dim, false))
        if (prefs.showNoise && data.noiseAvg != null) {
            lines.add(Line(
                "Noise: Avg ${data.noiseAvg} dB · Min ${data.noiseMin} dB · Max ${data.noiseMax} dB",
                smallPx, dim, false
            ))
        }

        val j = data.jurisdiction
        if (j != null && j.inScope) {
            var first = true
            fun jur(strs: List<String>) {
                strs.forEach {
                    lines.add(Line(it, bodyPx, accent, false, if (first) 0.35f * bodyPx else 0f))
                    first = false
                }
            }
            if (prefs.showZoneWard && j.corporation != null) {
                jur(wrap(j.corporation, text.apply { textSize = bodyPx }, textW, 2))
            }
            if (prefs.showZoneWard) {
                if (j.wardPending) jur(listOf("Ward: not yet available"))
                else {
                    val zw = ArrayList<String>()
                    if (j.zone != null) zw.add(GeoFormat.zone(j.zone))
                    if (j.ward != null) {
                        val name = j.wardName?.let { " ($it)" } ?: ""
                        zw.add("Ward ${GeoFormat.ward(j.ward)}$name")
                    }
                    if (zw.isNotEmpty())
                        jur(wrap(zw.joinToString(" · "), text.apply { textSize = bodyPx }, textW, 2))
                }
            }
            if (prefs.showPolice) {
                val lo = j.loStation
                val tr = j.trafficStation
                when {
                    lo != null && tr != null && lo == tr ->
                        jur(wrap("Police (L&O & Traffic): $lo", text.apply { textSize = bodyPx }, textW, 2))
                    lo != null && tr != null ->
                        jur(wrap("Police: L&O – $lo · Traffic – $tr", text.apply { textSize = bodyPx }, textW, 3))
                    lo != null -> jur(wrap("Police (L&O): $lo", text.apply { textSize = bodyPx }, textW, 2))
                    tr != null -> jur(wrap("Traffic: $tr", text.apply { textSize = bodyPx }, textW, 2))
                }
            }
        }

        if (lines.isEmpty() && mapSize <= 0f) return

        var textH = 0f
        for (l in lines) textH += l.px * 1.18f + lineGap + l.gapBefore
        val contentH = max(textH, mapSize)
        val panelH = pad * 2 + contentH
        val panelX = margin
        val panelY = if (prefs.positionTop) margin else height - margin - panelH

        val panel = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.argb((0.55f * 255).roundToInt(), 10, 14, 20)
        }
        canvas.drawRoundRect(
            RectF(panelX, panelY, panelX + panelW, panelY + panelH),
            16f * s, 16f * s, panel
        )

        // mini-map (stretches with the card, cover-cropped, capped)
        if (mapSize > 0 && miniMap != null) {
            val mapH = min(max(contentH, mapSize), mapSize * 2.4f)
            val mx = panelX + pad
            val my = panelY + pad + (contentH - mapH) / 2
            val destRatio = mapSize / mapH
            var cw = miniMap.width.toFloat()
            var ch = miniMap.height.toFloat()
            if (cw / ch > destRatio) cw = ch * destRatio else ch = cw / destRatio
            val srcL = ((miniMap.width - cw) / 2).roundToInt()
            val srcT = ((miniMap.height - ch) / 2).roundToInt()
            val save = canvas.save()
            val dst = RectF(mx, my, mx + mapSize, my + mapH)
            val clip = android.graphics.Path().apply {
                addRoundRect(dst, 10f * s, 10f * s, android.graphics.Path.Direction.CW)
            }
            canvas.clipPath(clip)
            canvas.drawBitmap(
                miniMap,
                Rect(srcL, srcT, srcL + cw.roundToInt(), srcT + ch.roundToInt()),
                dst, null
            )
            canvas.restoreToCount(save)
        }

        // text stack
        val tx = panelX + pad + mapSize + mapGap
        var ty = panelY + pad + (contentH - textH) / 2
        for (l in lines) {
            ty += l.gapBefore
            text.textSize = l.px
            text.color = l.color
            text.typeface = if (l.bold) Typeface.DEFAULT_BOLD else Typeface.DEFAULT
            ty += l.px // baseline
            canvas.drawText(l.str, tx, ty, text)
            ty += l.px * 0.18f + lineGap
        }
    }

    private fun dateLine(ts: Long): String {
        val d = Date(ts)
        val day = SimpleDateFormat("EEEE, dd/MM/yyyy hh:mm:ss a", Locale.ENGLISH).format(d)
        val tz = TimeZone.getDefault().getOffset(ts) / 60000
        val sign = if (tz >= 0) "+" else "-"
        val abs = kotlin.math.abs(tz)
        return "%s UTC%s%02d:%02d".format(day, sign, abs / 60, abs % 60)
    }

    private fun wrap(str: String, paint: Paint, maxWidth: Float, maxLines: Int): List<String> {
        val words = str.split(Regex("\\s+"))
        val out = ArrayList<String>()
        var cur = ""
        for (w in words) {
            val attempt = if (cur.isEmpty()) w else "$cur $w"
            if (paint.measureText(attempt) <= maxWidth || cur.isEmpty()) {
                cur = attempt
            } else if (out.size < maxLines - 1) {
                out.add(cur); cur = w
            } else {
                cur = attempt // final line — ellipsized below
            }
        }
        if (cur.isNotEmpty()) out.add(cur)
        val last: String? = out.lastOrNull()
        if (last != null && paint.measureText(last) > maxWidth) {
            var t: String = last
            while (t.isNotEmpty() && paint.measureText(t + "…") > maxWidth) {
                t = t.dropLast(1)
            }
            out[out.size - 1] = t + "…"
        }
        return out
    }
}
