package city.reclaimchennai.gpscam.geo

/**
 * DIGIPIN — India Post's open 10-character geocode. Verbatim port of the
 * official encoder (github.com/INDIAPOST-gov/digipin), same as the web
 * app; verified vector: (13.0405, 80.2337) → "4T32886P6J".
 */
object Digipin {
    private val GRID = arrayOf(
        arrayOf("F", "C", "9", "8"),
        arrayOf("J", "3", "2", "7"),
        arrayOf("K", "4", "5", "6"),
        arrayOf("L", "M", "P", "T"),
    )

    fun encode(lat: Double, lon: Double): String? {
        if (lat < 2.5 || lat > 38.5 || lon < 63.5 || lon > 99.5) return null
        var minLat = 2.5; var maxLat = 38.5
        var minLon = 63.5; var maxLon = 99.5
        val sb = StringBuilder()
        repeat(10) {
            val latDiv = (maxLat - minLat) / 4
            val lonDiv = (maxLon - minLon) / 4
            var row = 3 - ((lat - minLat) / latDiv).toInt()
            var col = ((lon - minLon) / lonDiv).toInt()
            row = row.coerceIn(0, 3)
            col = col.coerceIn(0, 3)
            sb.append(GRID[row][col])
            maxLat = minLat + latDiv * (4 - row)
            minLat += latDiv * (3 - row)
            minLon += lonDiv * col
            maxLon = minLon + lonDiv
        }
        return sb.toString()
    }
}
