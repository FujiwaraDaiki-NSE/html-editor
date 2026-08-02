/**
 * Pure, data-level checks for a Weave deck. These checks intentionally do not try to
 * predict rendered geometry; they catch defects that are deterministic before render.
 */

export const blockTextLimits = Object.freeze({
  eyebrow: 80,
  heading: 120,
  paragraph: 600,
  metrics: 240,
  note: 160,
});

const diagnostic = (code, message, location = {}, severity = "error") => ({
  code,
  severity,
  message,
  ...location,
});

const cleanText = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * @param {unknown} input
 * @param {{ textLimits?: Partial<typeof blockTextLimits> }} [options]
 */
export function auditDeckQuality(input, options = {}) {
  const diagnostics = [];
  const limits = { ...blockTextLimits, ...options.textLimits };
  const deck = input && typeof input === "object" ? input : null;

  if (!deck) {
    diagnostics.push(diagnostic("deck.missing", "Deck data is missing.", { path: "deck" }));
    return makeResult(diagnostics);
  }

  if (!Array.isArray(deck.slides) || deck.slides.length === 0) {
    diagnostics.push(diagnostic(
      "deck.slides.missing",
      "The deck must contain at least one slide.",
      { path: "slides" },
    ));
    return makeResult(diagnostics);
  }

  const slideIds = new Map();
  deck.slides.forEach((slide, slideIndex) => {
    const slidePath = `slides[${slideIndex}]`;
    if (!slide || typeof slide !== "object") {
      diagnostics.push(diagnostic(
        "slide.missing",
        `Slide ${slideIndex + 1} is missing.`,
        { slideIndex, path: slidePath },
      ));
      return;
    }

    const slideId = cleanText(slide.id);
    const slideLocation = { slideIndex, ...(slideId ? { slideId } : {}) };
    if (!slideId) {
      diagnostics.push(diagnostic(
        "slide.id.missing",
        `Slide ${slideIndex + 1} needs an id.`,
        { ...slideLocation, path: `${slidePath}.id` },
      ));
    } else if (slideIds.has(slideId)) {
      diagnostics.push(diagnostic(
        "slide.id.duplicate",
        `Slide id “${slideId}” duplicates slide ${slideIds.get(slideId) + 1}.`,
        { ...slideLocation, path: `${slidePath}.id` },
      ));
    } else {
      slideIds.set(slideId, slideIndex);
    }

    if (!Array.isArray(slide.blocks) || slide.blocks.length === 0) {
      diagnostics.push(diagnostic(
        "slide.blocks.missing",
        `Slide ${slideIndex + 1} has no content blocks.`,
        { ...slideLocation, path: `${slidePath}.blocks` },
      ));
      return;
    }

    const blockIds = new Map();
    let headingCount = 0;
    const allBlocks = [];
    const visit = (items, path) => items.forEach((block, index) => {
      const blockPath = `${path}[${index}]`;
      allBlocks.push({ block, blockPath });
      if (Array.isArray(block?.children)) visit(block.children, `${blockPath}.children`);
    });
    visit(slide.blocks, `${slidePath}.blocks`);
    allBlocks.forEach(({ block, blockPath }, blockIndex) => {
      if (!block || typeof block !== "object") {
        diagnostics.push(diagnostic(
          "block.missing",
          `Block ${blockIndex + 1} on slide ${slideIndex + 1} is missing.`,
          { ...slideLocation, blockIndex, path: blockPath },
        ));
        return;
      }

      const blockId = cleanText(block.id);
      const location = {
        ...slideLocation,
        blockIndex,
        ...(blockId ? { blockId } : {}),
      };
      if (!blockId) {
        diagnostics.push(diagnostic(
          "block.id.missing",
          `Block ${blockIndex + 1} needs an id.`,
          { ...location, path: `${blockPath}.id` },
        ));
      } else if (blockIds.has(blockId)) {
        diagnostics.push(diagnostic(
          "block.id.duplicate",
          `Block id “${blockId}” duplicates block ${blockIds.get(blockId) + 1} on this slide.`,
          { ...location, path: `${blockPath}.id` },
        ));
      } else {
        blockIds.set(blockId, blockIndex);
      }

      const text = typeof block.text === "string" ? block.text : "";
      if (block.kind === "heading") {
        headingCount += 1;
        if (!text.trim()) {
          diagnostics.push(diagnostic(
            "heading.empty",
            `Heading on slide ${slideIndex + 1} is empty.`,
            { ...location, path: `${blockPath}.text` },
          ));
        }
      }

      if (block.kind === "metrics") {
        const parts = text.split("|");
        if (parts.length < 2 || parts.length % 2 !== 0 || parts.some((part) => !part.trim())) {
          diagnostics.push(diagnostic(
            "metrics.invalid",
            "Metrics must contain complete, non-empty value|caption pairs.",
            { ...location, path: `${blockPath}.text` },
          ));
        }
      }

      const limit = limits[block.kind];
      if (Number.isFinite(limit) && text.length > limit) {
        diagnostics.push(diagnostic(
          "block.text.too-long",
          `${block.kind} text is ${text.length} characters; the recommended maximum is ${limit}.`,
          { ...location, path: `${blockPath}.text`, actual: text.length, limit },
          "warning",
        ));
      }
    });

    if (headingCount === 0) {
      diagnostics.push(diagnostic(
        "heading.missing",
        `Slide ${slideIndex + 1} has no heading.`,
        { ...slideLocation, path: `${slidePath}.blocks` },
      ));
    }
  });

  return makeResult(diagnostics);
}

function makeResult(diagnostics) {
  const errors = diagnostics.filter((item) => item.severity === "error").length;
  const warnings = diagnostics.filter((item) => item.severity === "warning").length;
  return {
    ok: errors === 0,
    diagnostics,
    summary: { errors, warnings },
  };
}
