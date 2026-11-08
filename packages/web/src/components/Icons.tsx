/**
 * The few glyphs the UI needs, drawn inline (16 px grid, 1.5 px strokes, currentColor). Decorative by
 * default (aria-hidden); give the surrounding control the accessible name.
 *   <IconCheck />  <IconArrowUpRight />  <IconPlus />  <IconClose />  <IconExternal />
 */
import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function base({ size = 16, ...rest }: IconProps) {
  return { width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true as const, focusable: false as const, ...rest };
}

export function IconCheck(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function IconArrowUpRight(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M5 11l6-6M6 5h5v5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Opens in a new window (same arrow; use for links with target="_blank"). */
export const IconExternal = IconArrowUpRight;

export function IconPlus(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function IconClose(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M4 4l8 8m0-8l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function IconArrowRight(props: IconProps) {
  return (
    <svg {...base(props)}>
      <path d="M3.5 8h9M9 4.5L12.5 8 9 11.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
