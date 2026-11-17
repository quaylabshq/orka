import React from "react";

/**
 * Any icon the Icon and IconButton components can render: a Lucide icon or
 * one of the local glyphs below.
 */
export type IconGlyph = React.ComponentType<
  Omit<React.SVGProps<SVGSVGElement>, "ref"> & { size?: number | string }
>;

type GlyphProps = React.ComponentProps<IconGlyph>;

/** Local glyphs share Lucide's 24px grid and sizing so they swap in freely. */
function glyph(name: string, children: React.ReactNode, stroked = false) {
  function Glyph({ size = 24, className = "", ...props }: GlyphProps) {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill={stroked ? "none" : "currentColor"}
        stroke={stroked ? "currentColor" : "none"}
        strokeWidth={stroked ? 2 : undefined}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className={`${stroked ? "lucide " : ""}${className}`.trim()}
        {...props}
      >
        {children}
      </svg>
    );
  }
  Glyph.displayName = name;
  return Glyph;
}

/* Brand marks. Lucide ships no brand logos. */

export const GithubMarkIcon = glyph(
  "GithubMarkIcon",
  <path d="M12 1.5C6.2 1.5 1.5 6.2 1.5 12c0 4.64 3.01 8.57 7.18 9.96.53.1.72-.23.72-.5v-1.78c-2.92.63-3.54-1.4-3.54-1.4-.48-1.22-1.17-1.54-1.17-1.54-.95-.65.07-.64.07-.64 1.05.07 1.61 1.08 1.61 1.08.94 1.6 2.46 1.14 3.06.87.1-.68.37-1.14.67-1.4-2.33-.27-4.78-1.17-4.78-5.19 0-1.15.41-2.08 1.08-2.82-.11-.26-.47-1.33.1-2.78 0 0 .88-.28 2.89 1.08a10 10 0 0 1 5.26 0c2-1.36 2.88-1.08 2.88-1.08.57 1.45.21 2.52.1 2.78.68.74 1.08 1.67 1.08 2.82 0 4.03-2.46 4.92-4.8 5.18.38.33.72.97.72 1.95v2.89c0 .28.19.6.72.5A10.5 10.5 0 0 0 22.5 12c0-5.8-4.7-10.5-10.5-10.5Z" />,
);

export const MarkdownMarkIcon = glyph(
  "MarkdownMarkIcon",
  <>
    <rect x="2" y="5" width="20" height="14" rx="2.5" />
    <path d="M6 15V9l2.5 3L11 9v6" />
    <path d="M17 9v6" />
    <path d="m14.5 12.5 2.5 2.5 2.5-2.5" />
  </>,
  true,
);

/* Filled status glyphs, for states that must read at a glance. */

export const CircleCheckFilledIcon = glyph(
  "CircleCheckFilledIcon",
  <path
    fillRule="evenodd"
    d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm4.7 7.7a1 1 0 0 0-1.4-1.4L11 12.58l-1.8-1.79a1 1 0 0 0-1.4 1.42l2.5 2.5a1 1 0 0 0 1.4 0l5-5Z"
  />,
);

export const TriangleAlertFilledIcon = glyph(
  "TriangleAlertFilledIcon",
  <path
    fillRule="evenodd"
    d="M10.27 3.5a2 2 0 0 1 3.46 0l8 14A2 2 0 0 1 20 20.5H4a2 2 0 0 1-1.73-3l8-14ZM12 8.5a1 1 0 0 0-1 1v4a1 1 0 0 0 2 0v-4a1 1 0 0 0-1-1Zm0 7.5a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2Z"
  />,
);

export const DotFilledIcon = glyph(
  "DotFilledIcon",
  <circle cx="12" cy="12" r="5" />,
);
