/**
 * Resume Section Viewer — Phase 1
 *
 * Renders the parsed LaTeX AST as a structured, human-readable
 * section-by-section view inside the app's "Resume Structure" panel.
 *
 * Rules:
 * - Shows section titles, bullet counts, and plain-text bullet previews
 * - Clearly marks locked/protected sections
 * - Preserves original formatting metadata (line counts, section types)
 * - Does NOT allow editing — read-only structured view
 */

import { escapeHtml } from './diff-helper.js';

/**
 * Render the full AST as a structured resume viewer HTML.
 *
 * @param {import('./latex-parser.js').ResumeAST} ast
 * @param {Set<string>} lockedSectionIds - Section IDs currently locked
 * @returns {string} HTML string
 */
export function renderResumeStructure(ast, lockedSectionIds = new Set()) {
  if (!ast || !ast.sections || ast.sections.length === 0) {
    return `<div class="placeholder-msg">
      <p>Upload or paste a LaTeX resume to see its parsed structure here.</p>
    </div>`;
  }

  const packageList = ast.packages.length > 0
    ? `<div class="resume-meta-row">
        <span class="meta-label">Packages</span>
        <span class="meta-value">${ast.packages.map(p => `<code>${escapeHtml(p)}</code>`).join(' ')}</span>
       </div>`
    : '';

  const cmdList = ast.customCommands.length > 0
    ? `<div class="resume-meta-row">
        <span class="meta-label">Custom Commands</span>
        <span class="meta-value">${ast.customCommands.map(c => `<code>${escapeHtml(c)}</code>`).join(' ')}</span>
       </div>`
    : '';

  const sectionsHTML = ast.sections.map(section => {
    const isLocked = lockedSectionIds.has(section.id) || section.locked;
    const bulletCount = section.bullets.length;

    const bulletsHTML = bulletCount > 0
      ? section.bullets.slice(0, 4).map(b => `
          <div class="rs-bullet">
            <span class="rs-bullet-dot">•</span>
            <span class="rs-bullet-text">${escapeHtml(b.text || '(empty)')}</span>
          </div>`).join('') +
        (bulletCount > 4
          ? `<div class="rs-bullet rs-bullet-more">+${bulletCount - 4} more bullets</div>`
          : '')
      : `<div class="rs-no-bullets">No bullet points — freeform content</div>`;

    return `
      <div class="rs-section ${isLocked ? 'rs-locked' : ''}">
        <div class="rs-section-header">
          <div class="rs-section-title-row">
            <span class="rs-section-icon">${isLocked ? '🔒' : '§'}</span>
            <span class="rs-section-title">${escapeHtml(section.title || 'Untitled Section')}</span>
            ${isLocked ? '<span class="rs-locked-badge">Protected</span>' : ''}
          </div>
          <div class="rs-section-meta">
            <span class="rs-meta-tag">${section.type}</span>
            <span class="rs-meta-tag">${bulletCount} bullet${bulletCount !== 1 ? 's' : ''}</span>
            <span class="rs-meta-tag">L${section.lineStart}–${section.lineEnd}</span>
          </div>
        </div>
        <div class="rs-section-bullets">${bulletsHTML}</div>
      </div>
    `;
  }).join('');

  return `
    <div class="resume-structure-view">
      <div class="resume-meta-block">
        <div class="resume-meta-row">
          <span class="meta-label">Sections Detected</span>
          <span class="meta-value">${ast.sections.length}</span>
        </div>
        <div class="resume-meta-row">
          <span class="meta-label">Total Bullets</span>
          <span class="meta-value">${ast.sections.reduce((n, s) => n + s.bullets.length, 0)}</span>
        </div>
        ${packageList}
        ${cmdList}
      </div>
      <div class="rs-sections-list">${sectionsHTML}</div>
    </div>
  `;
}
