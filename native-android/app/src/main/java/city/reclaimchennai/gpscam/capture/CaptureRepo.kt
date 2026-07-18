package city.reclaimchennai.gpscam.capture

import android.content.ContentValues
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Matrix
import android.net.Uri
import android.os.Environment
import android.provider.MediaStore
import androidx.exifinterface.media.ExifInterface
import city.reclaimchennai.gpscam.wm.Watermark
import city.reclaimchennai.gpscam.wm.WatermarkData
import city.reclaimchennai.gpscam.wm.WatermarkPrefs
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Watermark-composite + EXIF GPS + MediaStore save (DCIM/GPS Camera) —
 * the native analogue of the web capture pipeline, minus the IndexedDB
 * middle layer: MediaStore *is* the gallery here.
 */
object CaptureRepo {

    suspend fun save(
        context: Context,
        jpegBytes: ByteArray,
        rotationDegrees: Int,
        data: WatermarkData,
        prefs: WatermarkPrefs,
        miniMap: Bitmap?,
    ): Uri? = withContext(Dispatchers.Default) {
        // decode the full sensor frame, honouring rotation
        var bmp = BitmapFactory.decodeByteArray(jpegBytes, 0, jpegBytes.size)
            ?: return@withContext null
        if (rotationDegrees != 0) {
            val m = Matrix().apply { postRotate(rotationDegrees.toFloat()) }
            bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
        }
        val mutable = if (bmp.isMutable) bmp else bmp.copy(Bitmap.Config.ARGB_8888, true)
        Watermark.draw(Canvas(mutable), mutable.width, mutable.height, data, prefs, miniMap)

        withContext(Dispatchers.IO) {
            val name = "IMG_" +
                SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date(data.timestampMs)) +
                "_gpscam.jpg"
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                put(MediaStore.MediaColumns.MIME_TYPE, "image/jpeg")
                put(MediaStore.MediaColumns.RELATIVE_PATH,
                    Environment.DIRECTORY_DCIM + "/GPS Camera")
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val resolver = context.contentResolver
            val uri = resolver.insert(
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values
            ) ?: return@withContext null
            resolver.openOutputStream(uri)?.use { os ->
                mutable.compress(Bitmap.CompressFormat.JPEG, 92, os)
            } ?: return@withContext null

            // EXIF GPS + timestamp, written in place
            runCatching {
                resolver.openFileDescriptor(uri, "rw")?.use { pfd ->
                    val exif = ExifInterface(pfd.fileDescriptor)
                    if (data.lat != null && data.lng != null) {
                        exif.setLatLong(data.lat, data.lng)
                    }
                    exif.setAttribute(
                        ExifInterface.TAG_DATETIME_ORIGINAL,
                        SimpleDateFormat("yyyy:MM:dd HH:mm:ss", Locale.US)
                            .format(Date(data.timestampMs))
                    )
                    exif.setAttribute(ExifInterface.TAG_SOFTWARE, "GPS Cam Native")
                    exif.saveAttributes()
                }
            }

            values.clear()
            values.put(MediaStore.MediaColumns.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            uri
        }
    }
}
