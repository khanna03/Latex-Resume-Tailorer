import { diffWords } from 'diff';

/**
 * Escapes special HTML characters to prevent XSS.
 * @param {string} text
 * @returns {string}
 */
export function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Legacy word-level diff HTML generator.
 * Used as a fallback if semantic diff fails.
 * @param {string} original
 * @param {string} tailored
 * @returns {string}
 */
export function generateDiffHtml(original, tailored) {
  if (!original) return '<div class="placeholder-msg"><p>No original content to compare.</p></div>';
  if (!tailored) return '<div class="placeholder-msg"><p>No tailored content yet.</p></div>';

  try {
    const diffs = diffWords(original, tailored);
    return diffs.map(part => {
      const escaped = escapeHtml(part.value);
      if (part.added) return `<span class="diff-added">${escaped}</span>`;
      if (part.removed) return `<span class="diff-removed">${escaped}</span>`;
      return `<span>${escaped}</span>`;
    }).join('');
  } catch (error) {
    return `<div class="placeholder-msg"><p class="text-error">Error generating diff: ${escapeHtml(error.message)}</p></div>`;
  }
}
