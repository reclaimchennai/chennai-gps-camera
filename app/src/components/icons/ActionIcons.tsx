/**
 * The selection band's icons, drawn here rather than taken from the icon
 * pack.
 *
 * The stock set is the same one every app on the phone uses, so a bar of
 * them says "this is a list of generic operations" when what it should
 * say is "these are the things you can do with evidence you just
 * collected". These share one language instead: a 1.75 stroke with round
 * joins, and a PHOTO FRAME as the recurring object — sharing pushes a
 * frame outward, an album stacks frames, delete lifts a lid off one.
 *
 * They stay conventional where convention is comprehension. A bin is a
 * bin and a tag is a tag; nobody benefits from a clever new metaphor for
 * deleting. What changes is the drawing, not the meaning.
 *
 * `currentColor` throughout, no fills, so they inherit whatever the
 * button's colour resolves to in either theme and in forced-colours mode.
 */

interface IconProps {
  size?: number;
  className?: string;
}

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none" as const,
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  // decorative: every caller pairs these with a visible text label, so a
  // screen reader announcing the icon as well would just say it twice
  "aria-hidden": true,
  focusable: false,
});

/** A frame, with its contents leaving by the top corner. */
export function ShareOutIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12.5 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6.5" />
      <path d="m7.5 16.5 3.2-3.6a1.4 1.4 0 0 1 2 0l1.6 1.7" />
      <path d="M14.5 9.5 21 3" />
      <path d="M15.6 3H21v5.4" />
    </svg>
  );
}

/** Frames stacked, with somewhere new to put one. */
export function AlbumAddIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M7 3.5h10" />
      <path d="M5.5 6.5h13" />
      <path d="M4.5 9.5h11a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 19v-8a1.5 1.5 0 0 1 1.5-1.5Z" />
      <path d="M20 13.5v6" />
      <path d="M23 16.5h-6" />
    </svg>
  );
}

/** A luggage tag: the shape people already read as "label this". */
export function TagFileIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12.6 3.2H19a1.8 1.8 0 0 1 1.8 1.8v6.4a1.8 1.8 0 0 1-.53 1.27l-7.03 7.03a1.8 1.8 0 0 1-2.55 0l-6.4-6.4a1.8 1.8 0 0 1 0-2.55l7.03-7.03a1.8 1.8 0 0 1 1.28-.52Z" />
      <circle cx="16.4" cy="7.6" r="1.5" />
    </svg>
  );
}

/** A bin with the lid already coming off — the action, not the object. */
export function BinLiftIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      {/* lid, tilted: the moment of removal rather than a closed container */}
      <path d="M3.4 7.9 20.3 5.6" />
      <path d="m9.5 5.5.2-1.5a1.2 1.2 0 0 1 1.35-1.03l2.6.35A1.2 1.2 0 0 1 14.7 4.7l-.2 1.5" />
      <path d="M5.9 10.2h12.2l-.94 9.1A2 2 0 0 1 15.17 21H8.83a2 2 0 0 1-1.99-1.7L5.9 10.2Z" />
      <path d="M10.4 13.4v4.2" />
      <path d="M13.6 13.4v4.2" />
    </svg>
  );
}
