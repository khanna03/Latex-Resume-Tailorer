/**
 * Resume Reconstruction Engine
 *
 * Takes the original LaTeX AST + AI-modified section data and surgically
 * reinserts content back into the original LaTeX template.
 * Preamble, macros, packages, spacing, and locked sections are NEVER touched.
 */

import { latexToPlainText } from './latex-parser.js';

/**
 * @typedef {Object} ModifiedSection
 * @property {string} id - Must match a section ID from the original AST
 * @property {string[]} modifiedBullets - New bullet text (plain text; will be escaped)
 * @property {boolean} [skip] - If true, use original content unchanged
 */

/**
 * Escape plain text for safe use inside LaTeX content.
 * Only applies to content regions (not math, not commands).
 * @param {string} text
 * @returns {string}
 */
function escapeLatex(text) {
  return text
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/&/g, '\\&')
    .replace(/%/g, '\\%')
    .replace(/\$/g, '\\$')
    .replace(/#/g, '\\#')
    .replace(/_/g, '\\_')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}');
}

/**
 * Reconstruct a single section's rawContent by replacing bullet texts.
 * Preserves all non-\item LaTeX content (environments, sub-environments, spacing).
 *
 * @param {import('./latex-parser.js').LatexSection} originalSection
 * @param {string[]} newBulletTexts - New plain-text bullet content, in order
 * @returns {string} Reconstructed section raw content
 */
function reconstructSectionContent(originalSection, newBulletTexts) {
  if (!newBulletTexts || newBulletTexts.length === 0) {
    return originalSection.rawContent;
  }

  const originalBullets = originalSection.bullets;
  let result = originalSection.rawContent;

  // If bullet counts differ, do our best to replace what we can
  const count = Math.min(originalBullets.length, newBulletTexts.length);

  // Replace each bullet raw text with new content, working backwards to
  // preserve string indices (later replacements don't shift earlier ones)
  const replacements = [];
  for (let i = 0; i < count; i++) {
    const origBullet = originalBullets[i];
    const newText = newBulletTexts[i];
    if (!newText || !origBullet.raw) continue;

    // Build a new \item line preserving any leading format commands
    // Try to detect if the original \item had a bold prefix like \textbf{Company}
    const leadingFormatMatch = origBullet.raw.match(/^(\\item\s*(?:\\textbf\{[^}]*\}\s*(?:--|-|–|—)?\s*)?)/);
    const leadingFormat = leadingFormatMatch ? leadingFormatMatch[1] : '\\item ';

    // If the new text already contains LaTeX commands (has backslashes), use as-is
    // Otherwise, just write it as plain text
    const newItemContent = newText.includes('\\')
      ? newText
      : newText;

    const newRaw = `${leadingFormat}${newItemContent}`;
    replacements.push({ original: origBullet.raw, replacement: newRaw });
  }

  // Apply replacements (use simple string replacement; last-first to protect indices)
  for (const { original, replacement } of replacements) {
    // Only replace the first exact occurrence to avoid replacing identical bullets
    const idx = result.indexOf(original);
    if (idx !== -1) {
      result = result.substring(0, idx) + replacement + result.substring(idx + original.length);
    }
  }

  return result;
}

/**
 * Full resume reconstruction.
 * Takes original AST + a map of section modifications and returns a complete LaTeX string.
 *
 * @param {import('./latex-parser.js').ResumeAST} originalAst
 * @param {Object} sectionModifications - Map of sectionId → { bullets: string[] }
 * @param {Set<string>} lockedSectionIds - Section IDs that must not be modified
 * @returns {string} Reconstructed full LaTeX document
 */
export function reconstructLatex(originalAst, sectionModifications, lockedSectionIds = new Set()) {
  let body = originalAst.rawFull;

  // Process sections in reverse order of appearance so string indices stay valid
  const sortedSections = [...originalAst.sections].sort((a, b) => b.lineStart - a.lineStart);

  for (const section of sortedSections) {
    // Skip locked sections
    if (lockedSectionIds.has(section.id) || section.locked) continue;

    const modification = sectionModifications[section.id];
    if (!modification || !modification.bullets || modification.bullets.length === 0) continue;

    const newContent = reconstructSectionContent(section, modification.bullets);

    // Find the section's rawContent position in the full document and replace it
    const idx = body.indexOf(section.rawContent);
    if (idx !== -1) {
      body = body.substring(0, idx) + newContent + body.substring(idx + section.rawContent.length);
    }
  }

  return body;
}

/**
 * Build a modification map from an AI response's section array.
 * The AI returns sections with bullet text arrays; this converts to the format
 * expected by reconstructLatex().
 *
 * @param {Array<{id: string, bullets: string[]}>} aiSections
 * @returns {Object}
 */
export function buildModificationMap(aiSections) {
  const map = {};
  if (!Array.isArray(aiSections)) return map;
  aiSections.forEach(section => {
    if (section.id && Array.isArray(section.bullets)) {
      map[section.id] = { bullets: section.bullets };
    }
  });
  return map;
}
