package city.reclaimchennai.gpscam.audio

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlin.math.log10
import kotlin.math.sqrt

data class NoiseStats(val current: Int, val avg: Int, val min: Int, val max: Int)

/**
 * Ambient sound meter on AudioRecord with the UNPROCESSED source where
 * available — no AGC/noise-suppression rewriting the level (the exact
 * problem the web app had to fight). Same calibration model as the web
 * app: dBFS + offset (default 90) + user calibration.
 */
class SoundMeter(private val scope: CoroutineScope) {
    private val _stats = MutableStateFlow<NoiseStats?>(null)
    val stats: StateFlow<NoiseStats?> = _stats

    private var job: Job? = null
    private var sum = 0L
    private var count = 0
    private var minV = Int.MAX_VALUE
    private var maxV = Int.MIN_VALUE
    var calibration: Int = 0

    @SuppressLint("MissingPermission")
    fun start() {
        if (job?.isActive == true) return
        job = scope.launch(Dispatchers.IO) {
            val rate = 44100
            val bufSize = AudioRecord.getMinBufferSize(
                rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT
            ).coerceAtLeast(4096)
            val source = if (android.os.Build.VERSION.SDK_INT >= 24)
                MediaRecorder.AudioSource.UNPROCESSED
            else MediaRecorder.AudioSource.MIC
            val rec = runCatching {
                AudioRecord(source, rate, AudioFormat.CHANNEL_IN_MONO,
                    AudioFormat.ENCODING_PCM_16BIT, bufSize)
            }.getOrNull() ?: return@launch
            if (rec.state != AudioRecord.STATE_INITIALIZED) { rec.release(); return@launch }
            rec.startRecording()
            val buf = ShortArray(2048)
            var smoothed = -1.0
            try {
                while (isActive) {
                    val n = rec.read(buf, 0, buf.size)
                    if (n > 0) {
                        var acc = 0.0
                        for (i in 0 until n) acc += buf[i].toDouble() * buf[i]
                        val rms = sqrt(acc / n) / 32768.0
                        if (rms > 1e-7) {
                            val db = (20 * log10(rms) + 90 + calibration)
                                .coerceIn(20.0, 120.0)
                            smoothed = if (smoothed < 0) db
                            else if (db > smoothed) smoothed * 0.4 + db * 0.6
                            else smoothed * 0.75 + db * 0.25
                            val v = smoothed.toInt()
                            sum += v; count++
                            if (v < minV) minV = v
                            if (v > maxV) maxV = v
                            _stats.value = NoiseStats(v, (sum / count).toInt(), minV, maxV)
                        }
                    }
                    delay(200)
                }
            } finally {
                runCatching { rec.stop() }
                rec.release()
            }
        }
    }

    fun stop() {
        job?.cancel()
        job = null
    }
}
