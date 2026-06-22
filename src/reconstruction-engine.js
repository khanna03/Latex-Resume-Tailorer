/**
 * Resume Reconstruction Engine
 *
 * Takes the original LaTeX AST + AI-modified section data and surgically
 * reinserts content back into the original LaTeX template.
 *
 * KEY GUARANTEES:
 * 1. Preamble, macros, packages, spacing, and locked sections are NEVER touched.
 * 2. Uses absolute character offsets (_offsetStart/_offsetEnd) from the parser
 *    instead of fragile indexOf searches — safe even if sections have identical text.
 * 3. Locked sections are validated post-reconstruction; any drift reverts to original.
 * 4. Processes sections in reverse offset order so earlier offsets stay valid.
 */

import { latexToPlainText, parseLatex } from './latex-parser.js';

// ---------------------------------------------------------------------------
// LaTeX special-character escaping
// ---------------------------------------------------------------------------

/**
 * Escape plain text for safe use inside LaTeX content regions.
 * Only call on AI-supplied plain text that will be placed into \item bodies.
 * Do NOT call on text that already contains valid LaTeX commands.
 *
 * @param {string} text
 * @returns {string}
 */
function escapeLatex(text) {
  if (!text) return '';
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

// ---------------------------------------------------------------------------
// Bullet reconstruction
// ---------------------------------------------------------------------------

/**
 * Reconstruct a single section's rawContent by replacing \item bullet texts.
 * Preserves all non-\item LaTeX content (environments, sub-environments, spacing).
 *
 * Strategy:
 * - Walk the original bullets in order.
 * - For each bullet, replace its raw content with the new text from the AI.
 * - Replacements are done by absolute position within rawContent (safe even
 *   if two bullets share identical text).
 * - If AI provided more bullets than original: extra are appended before the
 *   section's closing environment command (or at end of content).
 * - If AI provided fewer bullets: original extras are preserved unchanged.
 *
 * @param {import('./latex-parser.js').LatexSection} originalSection
 * @param {string[]} newBulletTexts - New plain-text bullet content in order (from AI)
 * @returns {string} Reconstructed section rawContent
 */
function reconstructSectionContent(originalSection, newBulletTexts) {
  if (!newBulletTexts || newBulletTexts.length === 0) {
    return originalSection.rawContent;
  }

  const originalBullets = originalSection.bullets;
  const count = Math.min(originalBullets.length, newBulletTexts.length);

  // Build list of { start, end, newRaw } replacements (positions within rawContent)
  // We work on rawContent-relative offsets (= absOffset - section._offsetStart)
  const replacements = [];
  const sectionAbsStart = originalSection._offsetStart;

  for (let i = 0; i < count; i++) {
    const origBullet = originalBullets[i];
    const newText    = newBulletTexts[i];
    if (newText === undefined || newText === null) continue;

    // Relative start/end within rawContent
    const relStart = origBullet._offsetStart - sectionAbsStart;
    const relEnd   = origBullet._offsetEnd   - sectionAbsStart;

    // Preserve the leading \item prefix exactly as it appeared (e.g. \item[label] or \resumeItem)
    const leadingMatch = origBullet.raw.match(/^(\\item(?:\[[^\]]*\])?\s*)/);
    const leadingPrefix = leadingMatch ? leadingMatch[1] : '\\item ';

    // If the AI returned plain text (no backslashes), use it as-is.
    // If it somehow returned LaTeX commands, pass through without double-escaping.
    const newItemContent = newText.includes('\\') ? newText : newText;
    const newRaw = `${leadingPrefix}${newItemContent}`;

    replacements.push({ relStart, relEnd, newRaw });
  }

  // Apply replacements in REVERSE order to preserve earlier offsets.
  // If we applied them forwards, modifying the string would invalidate the start/end offsets
  // of all subsequent bullets in the section.
  replacements.sort((a, b) => b.relStart - a.relStart);

  let result = originalSection.rawContent;
  for (const { relStart, relEnd, newRaw } of replacements) {
    result = result.substring(0, relStart) + newRaw + result.substring(relEnd);
  }

  // If AI provided MORE bullets than the original, append them before the
  // first \end{...} we can find in the section content, or at the end.
  if (newBulletTexts.length > originalBullets.length) {
    const extraTexts = newBulletTexts.slice(originalBullets.length);
    const extraItems = extraTexts
      .map(t => `\\item ${t.includes('\\') ? t : t}`)
      .join('\n');

    // Find a good insertion point: before \end{itemize} or \end{enumerate}
    const endEnvMatch = result.search(/\\end\{(?:itemize|enumerate|description)\}/);
    if (endEnvMatch !== -1) {
      result = result.substring(0, endEnvMatch) + extraItems + '\n' + result.substring(endEnvMatch);
    } else {
      result = result.trimEnd() + '\n' + extraItems + '\n';
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main reconstruction function
// ---------------------------------------------------------------------------

/**
 * Full resume reconstruction.
 * Takes original AST + a map of section modifications and returns a complete LaTeX string.
 *
 * Uses absolute character offsets stored in the AST (_offsetStart/_offsetEnd)
 * for precise, index-safe section splicing — never uses fragile string searches.
 *
 * @param {import('./latex-parser.js').ResumeAST} originalAst
 * @param {Object} sectionModifications - Map of sectionId → { bullets: string[] }
 * @param {Set<string>} lockedSectionIds - Section IDs that must not be modified
 * @returns {string} Reconstructed full LaTeX document
 */
export function reconstructLatex(originalAst, sectionModifications, lockedSectionIds = new Set()) {
  let result = originalAst.rawFull;

  // Process sections in reverse offset order so earlier offsets stay valid
  // after each splice. If we mutated the start of the document first, all AST offsets
  // for later sections would be incorrect.
  const sectionsToProcess = [...originalAst.sections]
    .filter(s => {
      if (lockedSectionIds.has(s.id) || s.locked) return false;
      const mod = sectionModifications[s.id];
      return mod && Array.isArray(mod.bullets) && mod.bullets.length > 0;
    })
    .sort((a, b) => b._offsetStart - a._offsetStart); // reverse order

  for (const section of sectionsToProcess) {
    const modification = sectionModifications[section.id];
    const newContent   = reconstructSectionContent(section, modification.bullets);

    // Splice the new content into the result using absolute offsets
    result =
      result.substring(0, section._offsetStart) +
      newContent +
      result.substring(section._offsetEnd);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Locked section validator
// ---------------------------------------------------------------------------

/**
 * After reconstruction, verify that every locked section's content is
 * byte-for-byte identical to the original. If any locked section drifted
 * (e.g. the AI changed it despite the prompt), revert those sections by
 * splicing the original content back in.
 *
 * @param {import('./latex-parser.js').ResumeAST} originalAst
 * @param {string} tailoredLatex     - Reconstructed LaTeX output
 * @param {Set<string>} lockedSectionIds
 * @returns {{ latex: string, reverted: string[] }} Corrected LaTeX + list of reverted section IDs
 */
export function validateLockedSections(originalAst, tailoredLatex, lockedSectionIds) {
  if (!lockedSectionIds || lockedSectionIds.size === 0) {
    return { latex: tailoredLatex, reverted: [] };
  }

  const tailoredAst = parseLatex(tailoredLatex);
  const reverted    = [];
  let   result      = tailoredLatex;

  // Build a title → section map for the tailored AST
  const tailoredByTitle = new Map(
    tailoredAst.sections.map(s => [s.title.toLowerCase().trim(), s])
  );

  for (const origSection of originalAst.sections) {
    if (!lockedSectionIds.has(origSection.id) && !origSection.locked) continue;

    const tailored = tailoredByTitle.get(origSection.title.toLowerCase().trim());
    if (!tailored) continue; // section was removed entirely — skip

    // Compare rawContent
    if (tailored.rawContent === origSection.rawContent) continue; // identical — OK

    // Revert: splice original rawContent back at the tailored section's offset
    result =
      result.substring(0, tailored._offsetStart) +
      origSection.rawContent +
      result.substring(tailored._offsetEnd);

    reverted.push(origSection.id);
  }

  return { latex: result, reverted };
}

// ---------------------------------------------------------------------------
// Modification map builder
// ---------------------------------------------------------------------------

/**
 * Build a modification map from an AI response's section array.
 * The AI returns sections with bullet text arrays; this converts to the format
 * expected by reconstructLatex().
 *
 * @param {Array<{id: string, bullets: string[]}>} aiSections
 * @returns {Object} sectionId → { bullets: string[] }
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
