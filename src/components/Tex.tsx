"use client";

import katex from "katex";

/**
 * Inline KaTeX math renderer.
 * Accepts a LaTeX string and renders it as inline math.
 * Automatically converts "v_yx" → "v_{yx}" (wraps multi-char subscripts in braces).
 *
 * Uses dangerouslySetInnerHTML with KaTeX's trusted HTML output.
 * Only pass internal LaTeX strings — never user-supplied input.
 */
export default function Tex({ children, className }: { children: string; className?: string }) {
  // Auto-brace multi-char subscripts: v_yx → v_{yx}, but leave v_x as v_{x} too (harmless)
  const tex = children.replace(/_([^{]\w*)/g, "_{$1}");
  const html = katex.renderToString(tex, {
    throwOnError: false,
    displayMode: false,
  });
  return <span className={className} style={{ fontSize: "0.85em" }} dangerouslySetInnerHTML={{ __html: html }} />;
}
