package city.reclaimchennai.cam;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import androidx.exifinterface.media.ExifInterface;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.List;

/**
 * A photo finished on the phone, not in the WebView.
 *
 * The WebView used to do it all: decode the camera's 8–12 MP JPEG, draw
 * the card over it, encode it again, splice in EXIF, make a thumbnail,
 * then hand the file to the gallery as base64 text in 3 MB slices. Every
 * step ran on the thread that also draws the viewfinder and answers the
 * shutter, which is where the stutter after each photo came from, and
 * why a burst reached the gallery seconds late.
 *
 * Here the web layer only draws the card (onto a transparent canvas, cut
 * into the horizontal bands that actually hold something) and builds the
 * EXIF block. This class decodes the still, turns it upright, draws the
 * bands, encodes once, writes the EXIF block in, saves to the gallery
 * directly through MediaStore and makes the thumbnail — on a background
 * thread, with the phone's own codecs.
 */
final class StillCompositor {

    /** A transparent strip of the card, at its place in the upright frame. */
    static final class Band {
        final int x;
        final int y;
        final byte[] png;

        Band(int x, int y, byte[] png) {
            this.x = x;
            this.y = y;
            this.png = png;
        }
    }

    static final class Result {
        File finalFile;
        File thumbFile;
        int width;
        int height;
        Uri galleryUri;
        long decodeMs;
        long drawMs;
        long encodeMs;
        long saveMs;
    }

    private StillCompositor() {}

    /**
     * Upright, mirrored if asked, stamped, encoded, tagged; saved to the
     * gallery when {@code galleryName} is given.
     *
     * @param exifApp1 the EXIF APP1 payload ("Exif\0\0" + TIFF), or null
     */
    static Result run(Context ctx, File still, List<Band> bands, boolean mirror,
                      byte[] exifApp1, int quality, int thumbEdge,
                      String galleryName, long takenAt) throws IOException {
        Result res = new Result();
        long t0 = System.nanoTime();

        int orientation = ExifInterface.ORIENTATION_NORMAL;
        try {
            orientation = new ExifInterface(still.getAbsolutePath()).getAttributeInt(
                ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
        } catch (IOException ignored) {
            // no EXIF: the pixels are already upright
        }
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inPreferredConfig = Bitmap.Config.ARGB_8888;
        o.inMutable = true;
        Bitmap src = BitmapFactory.decodeFile(still.getAbsolutePath(), o);
        if (src == null) throw new IOException("could not decode the still");
        long t1 = System.nanoTime();

        Bitmap up = upright(src, orientation, mirror);
        Canvas c = new Canvas(up);
        Paint p = new Paint(Paint.FILTER_BITMAP_FLAG);
        for (Band b : bands) {
            Bitmap bb = BitmapFactory.decodeByteArray(b.png, 0, b.png.length);
            if (bb == null) continue;
            c.drawBitmap(bb, b.x, b.y, p);
            bb.recycle();
        }
        res.width = up.getWidth();
        res.height = up.getHeight();
        long t2 = System.nanoTime();

        ByteArrayOutputStream jpeg = new ByteArrayOutputStream(4 * 1024 * 1024);
        up.compress(Bitmap.CompressFormat.JPEG, quality, jpeg);
        byte[] bytes = withExif(jpeg.toByteArray(), exifApp1);

        int tw = Math.max(1, Math.round(up.getWidth() * Math.min(1f, thumbEdge / (float) Math.max(up.getWidth(), up.getHeight()))));
        int th = Math.max(1, Math.round(up.getHeight() * Math.min(1f, thumbEdge / (float) Math.max(up.getWidth(), up.getHeight()))));
        Bitmap small = Bitmap.createScaledBitmap(up, tw, th, true);
        ByteArrayOutputStream thumb = new ByteArrayOutputStream(64 * 1024);
        small.compress(Bitmap.CompressFormat.JPEG, 80, thumb);
        if (small != up) small.recycle();
        up.recycle();
        long t3 = System.nanoTime();

        String stem = still.getName().replace("native-cap-", "").replace(".jpg", "");
        res.finalFile = new File(ctx.getCacheDir(), "native-fin-" + stem + ".jpg");
        res.thumbFile = new File(ctx.getCacheDir(), "native-thm-" + stem + ".jpg");
        write(res.finalFile, bytes);
        write(res.thumbFile, thumb.toByteArray());
        if (galleryName != null) res.galleryUri = saveToGallery(ctx, bytes, galleryName, takenAt);
        long t4 = System.nanoTime();

        res.decodeMs = (t1 - t0) / 1_000_000L;
        res.drawMs = (t2 - t1) / 1_000_000L;
        res.encodeMs = (t3 - t2) / 1_000_000L;
        res.saveMs = (t4 - t3) / 1_000_000L;
        return res;
    }

    /** The decoded still turned by its EXIF orientation (and mirrored), as
     *  a mutable bitmap the card can be drawn on. */
    private static Bitmap upright(Bitmap src, int orientation, boolean mirror) {
        Matrix m = new Matrix();
        switch (orientation) {
            case ExifInterface.ORIENTATION_ROTATE_90: m.postRotate(90); break;
            case ExifInterface.ORIENTATION_ROTATE_180: m.postRotate(180); break;
            case ExifInterface.ORIENTATION_ROTATE_270: m.postRotate(270); break;
            case ExifInterface.ORIENTATION_FLIP_HORIZONTAL: m.postScale(-1, 1); break;
            case ExifInterface.ORIENTATION_FLIP_VERTICAL: m.postScale(1, -1); break;
            case ExifInterface.ORIENTATION_TRANSPOSE: m.postRotate(90); m.postScale(-1, 1); break;
            case ExifInterface.ORIENTATION_TRANSVERSE: m.postRotate(270); m.postScale(-1, 1); break;
            default: break;
        }
        if (mirror) m.postScale(-1, 1);
        if (m.isIdentity() && src.isMutable()) return src;
        boolean swap = orientation == ExifInterface.ORIENTATION_ROTATE_90
            || orientation == ExifInterface.ORIENTATION_ROTATE_270
            || orientation == ExifInterface.ORIENTATION_TRANSPOSE
            || orientation == ExifInterface.ORIENTATION_TRANSVERSE;
        int w = swap ? src.getHeight() : src.getWidth();
        int h = swap ? src.getWidth() : src.getHeight();
        Bitmap out = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(out);
        // map the source's centre onto the output's, after the turn
        Matrix full = new Matrix();
        full.postTranslate(-src.getWidth() / 2f, -src.getHeight() / 2f);
        full.postConcat(m);
        full.postTranslate(w / 2f, h / 2f);
        c.drawBitmap(src, full, new Paint(Paint.FILTER_BITMAP_FLAG));
        src.recycle();
        return out;
    }

    /**
     * The encoder's JPEG with our EXIF block as its first segment. Android
     * writes a JFIF APP0 header; an EXIF file carries APP1 instead, so the
     * APP0 is dropped and the APP1 takes its place right after SOI.
     */
    static byte[] withExif(byte[] jpeg, byte[] app1) {
        if (app1 == null || app1.length == 0 || app1.length > 65533) return jpeg;
        if (jpeg.length < 4 || (jpeg[0] & 0xFF) != 0xFF || (jpeg[1] & 0xFF) != 0xD8) return jpeg;
        int rest = 2;
        if ((jpeg[2] & 0xFF) == 0xFF && (jpeg[3] & 0xFF) == 0xE0 && jpeg.length > 6) {
            int len = ((jpeg[4] & 0xFF) << 8) | (jpeg[5] & 0xFF);
            rest = 4 + len;
        }
        int segLen = app1.length + 2;
        byte[] out = new byte[2 + 4 + app1.length + (jpeg.length - rest)];
        out[0] = (byte) 0xFF;
        out[1] = (byte) 0xD8;
        out[2] = (byte) 0xFF;
        out[3] = (byte) 0xE1;
        out[4] = (byte) (segLen >> 8);
        out[5] = (byte) (segLen & 0xFF);
        System.arraycopy(app1, 0, out, 6, app1.length);
        System.arraycopy(jpeg, rest, out, 6 + app1.length, jpeg.length - rest);
        return out;
    }

    private static void write(File f, byte[] bytes) throws IOException {
        try (FileOutputStream os = new FileOutputStream(f)) {
            os.write(bytes);
        }
    }

    /** Straight into DCIM/GPS Camera, where the share sheets of WhatsApp,
     *  Telegram and X look for recent photos. */
    static Uri saveToGallery(Context ctx, byte[] bytes, String name, long takenAt) throws IOException {
        if (Build.VERSION.SDK_INT >= 29) {
            ContentResolver cr = ctx.getContentResolver();
            ContentValues v = new ContentValues();
            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
            v.put(MediaStore.MediaColumns.MIME_TYPE, "image/jpeg");
            v.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DCIM + "/GPS Camera");
            v.put(MediaStore.Images.Media.DATE_TAKEN, takenAt);
            v.put(MediaStore.MediaColumns.IS_PENDING, 1);
            Uri uri = cr.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
            if (uri == null) throw new IOException("gallery insert failed");
            try (OutputStream os = cr.openOutputStream(uri)) {
                if (os == null) throw new IOException("no gallery stream");
                os.write(bytes);
            } catch (IOException e) {
                cr.delete(uri, null, null);
                throw e;
            }
            ContentValues done = new ContentValues();
            done.put(MediaStore.MediaColumns.IS_PENDING, 0);
            cr.update(uri, done, null, null);
            return uri;
        }
        File dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DCIM), "GPS Camera");
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("mkdir failed");
        File f = new File(dir, name);
        write(f, bytes);
        MediaScannerConnection.scanFile(ctx, new String[] {f.getAbsolutePath()}, new String[] {"image/jpeg"}, null);
        return Uri.fromFile(f);
    }

    static byte[] b64(String s) {
        return s == null || s.isEmpty() ? null : Base64.decode(s, Base64.DEFAULT);
    }
}
