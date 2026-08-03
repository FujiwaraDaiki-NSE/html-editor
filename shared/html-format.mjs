/* Canonical formatter for the slide sources (concept 2.10 — HTML is the single truth).

   Both authors of slides/*.html run their output through this before it hits disk: the
   human's save path (live DOM -> outerHTML) and the agent's direct file writes. Forcing one
   deterministic shape is what keeps git diffs meaningful and stops the two authors from
   drifting apart on formatting alone — the property the round-trip depends on.

   Convention: line breaks inside slide text must be <br> elements, not literal newlines.
   Prettier collapses newlines in normal-flow text (it cannot see the project's white-space
   rules), so a literal newline that renders as a break under `white-space: pre-wrap` would be
   silently lost. contentEditable already emits <br> on Enter, so this is the natural choice
   and it survives formatting unchanged. */

import prettier from "prettier";

const options = { printWidth: 100, tabWidth: 2, htmlWhitespaceSensitivity: "css" };

/* Prettier already ends with a newline; collapse any run to exactly one. */
const oneTrailingNewline = (text) => `${text.replace(/\n*$/, "")}\n`;

/** Format a slide's HTML (the `<main class="weave-slide">` element or a fragment of it). */
export async function formatSlideHtml(html) {
  return oneTrailingNewline(await prettier.format(html, { ...options, parser: "html" }));
}

/** Format the project stylesheet. */
export async function formatDeckCss(css) {
  return oneTrailingNewline(await prettier.format(css, { ...options, parser: "css" }));
}
