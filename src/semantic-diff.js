/**
 * Semantic Section + Bullet Level Diff Engine
 *
 * Replaces character-level word diffing with a structured diff that shows
 * which sections and which specific bullets changed between original and tailored resume.
 */

import { parseLatex } from './latex-parser.js';
import { escapeHtml } from './diff-helper.js';
import { diffWords } from 'diff';

/**
 * @typedef {Object} BulletDiff
 * @property {'unchanged'|'modified'|'added'|'removed'} status
 * @property {string} originalText
 * @property {string} tailoredText
 * @property {string} inlineDiffHtml - Word-level diff within this bullet
 */

/**
 * @typedef {Object} SectionDiff
 * @property {string} title
 * @property {'unchanged'|'modified'|'added'|'removed'|'locked'} status
 * @property {BulletDiff[]} bullets
 * @property {number} changedCount
 */

/**
 * Compute word-level inline diff HTML for a single bullet change.
 * @param {string} original
 * @param {string} tailored
 * @returns {string}
 */
function computeInlineDiff(original, tailored) {
  if (!original && !tailored) return '';
  if (!original) return `<span class="diff-added">${escapeHtml(tailored)}</span>`;
  if (!tailored) return `<span class="diff-removed">${escapeHtml(original)}</span>`;

  try {
    const diffs = diffWords(original, tailored);
    return diffs.map(part => {
      const escaped = escapeHtml(part.value);
      if (part.added) return `<span class="diff-added">${escaped}</span>`;
      if (part.removed) return `<span class="diff-removed">${escaped}</span>`;
      return `<span>${escaped}</span>`;
    }).join('');
  } catch {
    return escapeHtml(tailored);
  }
}

/**
 * Perform a semantic section + bullet level diff between original and tailored LaTeX.
 * @param {string} originalLatex
 * @param {string} tailoredLatex
 * @returns {SectionDiff[]}
 */
export function computeSemanticDiff(originalLatex, tailoredLatex) {
  const origAst = parseLatex(originalLatex);
  const tailoredAst = parseLatex(tailoredLatex);

  // We map sections by their title (lowercased) so we can pair up the original section with the new section
  // regardless of where it moved in the document order.
  const origMap = new Map(origAst.sections.map(s => [s.title.toLowerCase(), s]));
  const tailMap = new Map(tailoredAst.sections.map(s => [s.title.toLowerCase(), s]));

  const allTitles = new Set([...origMap.keys(), ...tailMap.keys()]);
  const sectionDiffs = [];

  for (const title of allTitles) {
    const origSec = origMap.get(title);
    const tailSec = tailMap.get(title);

    // Section added
    if (!origSec) {
      sectionDiffs.push({
        title: tailSec.title,
        status: 'added',
        bullets: tailSec.bullets.map(b => ({
          status: 'added',
          originalText: '',
          tailoredText: b.text,
          inlineDiffHtml: `<span class="diff-added">${escapeHtml(b.text)}</span>`,
        })),
        changedCount: tailSec.bullets.length,
      });
      continue;
    }

    // Section removed
    if (!tailSec) {
      sectionDiffs.push({
        title: origSec.title,
        status: 'removed',
        bullets: origSec.bullets.map(b => ({
          status: 'removed',
          originalText: b.text,
          tailoredText: '',
          inlineDiffHtml: `<span class="diff-removed">${escapeHtml(b.text)}</span>`,
        })),
        changedCount: origSec.bullets.length,
      });
      continue;
    }

    // Both exist — diff bullets
    // We iterate through bullets by index. If the section was deeply rewritten and bullets reordered,
    // this index-based approach will show them as 'modified', which is visually acceptable.
    const bulletDiffs = [];
    const maxLen = Math.max(origSec.bullets.length, tailSec.bullets.length);
    let changedCount = 0;

    for (let i = 0; i < maxLen; i++) {
      const ob = origSec.bullets[i];
      const tb = tailSec.bullets[i];

      if (!ob) {
        bulletDiffs.push({
          status: 'added',
          originalText: '',
          tailoredText: tb.text,
          inlineDiffHtml: `<span class="diff-added">${escapeHtml(tb.text)}</span>`,
        });
        changedCount++;
      } else if (!tb) {
        bulletDiffs.push({
          status: 'removed',
          originalText: ob.text,
          tailoredText: '',
          inlineDiffHtml: `<span class="diff-removed">${escapeHtml(ob.text)}</span>`,
        });
        changedCount++;
      } else if (ob.text.trim() === tb.text.trim()) {
        bulletDiffs.push({
          status: 'unchanged',
          originalText: ob.text,
          tailoredText: tb.text,
          inlineDiffHtml: escapeHtml(ob.text),
        });
      } else {
        bulletDiffs.push({
          status: 'modified',
          originalText: ob.text,
          tailoredText: tb.text,
          inlineDiffHtml: computeInlineDiff(ob.text, tb.text),
        });
        changedCount++;
      }
    }

    const sectionStatus = changedCount === 0 ? 'unchanged' : 'modified';
    sectionDiffs.push({
      title: origSec.title,
      status: sectionStatus,
      bullets: bulletDiffs,
      changedCount,
    });
  }

  return sectionDiffs;
}

/**
 * Render semantic section diffs as HTML for the diff panel.
 * @param {SectionDiff[]} sectionDiffs
 * @returns {string}
 */
export function renderSemanticDiffHtml(sectionDiffs) {
  if (!sectionDiffs || sectionDiffs.length === 0) {
    return '<div class="placeholder-msg"><p>No differences detected.</p></div>';
  }

  const changedSections = sectionDiffs.filter(s => s.status !== 'unchanged');
  const unchangedCount = sectionDiffs.filter(s => s.status === 'unchanged').length;

  let html = '';

  if (unchangedCount > 0) {
    html += `<div class="diff-summary-bar">
      <span class="diff-stat modified">${changedSections.length} section${changedSections.length !== 1 ? 's' : ''} modified</span>
      <span class="diff-stat unchanged">${unchangedCount} unchanged</span>
    </div>`;
  }

  changedSections.forEach(section => {
    const statusClass = `diff-section-${section.status}`;
    const statusLabel = {
      modified: `${section.changedCount} bullet${section.changedCount !== 1 ? 's' : ''} changed`,
      added: 'Section added',
      removed: 'Section removed',
      locked: 'Protected',
    }[section.status] || section.status;

    html += `
      <div class="diff-section-block ${statusClass}">
        <div class="diff-section-header">
          <span class="diff-section-title">${escapeHtml(section.title)}</span>
          <span class="diff-section-badge diff-badge-${section.status}">${statusLabel}</span>
        </div>
        <div class="diff-section-bullets">
    `;

    section.bullets.forEach(bullet => {
      if (bullet.status === 'unchanged') return; // Hide unchanged bullets by default
      html += `
        <div class="diff-bullet diff-bullet-${bullet.status}">
          <span class="diff-bullet-marker">${
            bullet.status === 'added' ? '＋' :
            bullet.status === 'removed' ? '－' : '✎'
          }</span>
          <span class="diff-bullet-content">${bullet.inlineDiffHtml}</span>
        </div>
      `;
    });

    html += `</div></div>`;
  });

  // Show a note about unchanged sections
  if (unchangedCount > 0) {
    html += `<div class="diff-unchanged-note">
      <span>${unchangedCount} section${unchangedCount !== 1 ? 's' : ''} left intact (no changes needed)</span>
    </div>`;
  }

  return html || '<div class="placeholder-msg"><p>All sections are identical — no changes were made.</p></div>';
}
