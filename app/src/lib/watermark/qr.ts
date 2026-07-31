/**
 * The location as a QR code.
 *
 * Scanned with any phone camera it hands back a maps link for the exact
 * spot plus the DIGIPIN, so someone holding a printed or forwarded photo
 * can reach the place without typing coordinates. One code carries both:
 * scanners show the text and offer the link, which is friendlier than
 * making the reader choose between two codes.
 */
import QRCode from "qrcode";

export interface QrInput {
  lat: number;
  lng: number;
  digipin?: string;
}

export async function renderLocationQr(
  { lat, lng, digipin }: QrInput,
  sizePx = 260
): Promise<HTMLImageElement | null> {
  try {
    const lines = [
      `https://maps.google.com/?q=${lat.toFixed(6)},${lng.toFixed(6)}`,
    ];
    if (digipin) lines.push(`DIGIPIN: ${digipin}`);
    const url = await QRCode.toDataURL(lines.join("\n"), {
      margin: 1,
      width: sizePx,
      errorCorrectionLevel: "M",
      color: { dark: "#000000ff", light: "#ffffffff" },
    });
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } catch {
    return null; // a missing QR must never block a capture
  }
}
