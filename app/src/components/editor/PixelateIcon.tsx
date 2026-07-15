/** Mosaic/pixelate glyph — reads as "blur/redact" better than a droplet. */
export default function PixelateIcon({ size = 19 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="6" height="6" />
      <rect x="15" y="3" width="6" height="6" />
      <rect x="9" y="9" width="6" height="6" />
      <rect x="3" y="15" width="6" height="6" />
      <rect x="15" y="15" width="6" height="6" />
      <rect x="9" y="3" width="6" height="6" opacity="0.3" />
      <rect x="3" y="9" width="6" height="6" opacity="0.3" />
      <rect x="15" y="9" width="6" height="6" opacity="0.3" />
      <rect x="9" y="15" width="6" height="6" opacity="0.3" />
    </svg>
  );
}
