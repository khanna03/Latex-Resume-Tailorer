/**
 * Explainability Panel — Phase 1
 *
 * Shows WHY each modification was suggested:
 * - Which JD keyword / requirement triggered the change
 * - Before vs after text diff
 * - ATS keyword coverage delta per change
 * - Categorised by change type with clear reasoning
 *
 * No ML. Pure logic based on JD analysis + changes log.
 */

import { escapeHtml } from './diff-helper.js';

/**
 * @typedef {Object} ChangeEntry
 * @property {string} title
 * @property {string} type - 'skill'|'metric'|'keyword'|'restructure'|'syntax'
 * @property {string} description
 * @property {string} oldText
 * @property {string} newText
 */

/**
 * Match keywords from jdAnalysis that appear in the new bullet text
 * but NOT in the old bullet text — these are the "added keywords".
 *
 * @param {string} oldText
 * @param {string} newText
 * @param {import('./jd-engine.js').JDAnalysis} jdAnalysis
 * @returns {{ addedRequired: string[], addedPreferred: string[], addedATS: string[] }}
 */
function detectAddedKeywords(oldText, newText, jdAnalysis) {
  if (!oldText || !newText || !jdAnalysis) return { addedRequired: [], addedPreferred: [], addedATS: [] };

  const normalize = s => s.toLowerCase().replace(/[^a-z0-9+#.\s]/g, ' ');
  const normOld = normalize(oldText);
  const normNew = normalize(newText);

  const wasAbsent = kw => {
    const norm = normalize(kw);
    const re = new RegExp(`(?:^|\\s)${norm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|\\s|[,;])`, 'i');
    return !re.test(normOld) && re.test(normNew);
  };

  return {
    addedRequired:  (jdAnalysis.required_skills || []).filter(wasAbsent),
    addedPreferred: (jdAnalysis.preferred_skills || []).filter(wasAbsent),
    addedATS:       (jdAnalysis.ats_keywords || []).filter(wasAbsent),
  };
}

/**
 * Render the full explainability panel HTML.
 *
 * @param {ChangeEntry[]} changesLog
 * @param {import('./jd-engine.js').JDAnalysis} jdAnalysis
 * @param {object} atsReportBefore
 * @param {object} atsReportAfter
 * @param {Array<{entity:string,type:string,context:string}>} [fabricationFlags=[]] - Flagged entities
 * @param {string[]} [revertedSections=[]] - Section IDs that were auto-reverted due to lock violation
 * @returns {string} HTML
 */
export function renderExplainabilityPanel(changesLog, jdAnalysis, atsReportBefore, atsReportAfter, fabricationFlags = [], revertedSections = []) {
  if (!changesLog || changesLog.length === 0) {
    return `<div class="placeholder-msg"><p>No changes were made in this tailoring run. Try a more aggressive mode or broaden your JD.</p></div>`;
  }

  const TYPE_META = {
    skill:       { label: 'Skill Alignment',   color: 'var(--accent-blue)',   icon: '⚡' },
    metric:      { label: 'Impact Metric',      color: 'var(--accent-green)',  icon: '📈' },
    keyword:     { label: 'ATS Keyword',        color: 'var(--accent-cyan)',   icon: '🔑' },
    restructure: { label: 'Restructured',       color: 'var(--accent-purple)', icon: '✏️' },
    syntax:      { label: 'Syntax Fix',         color: 'var(--accent-yellow)', icon: '🔧' },
  };

  // Summary stats
  const totalKeywordsAdded = changesLog.reduce((sum, c) => {
    const kw = detectAddedKeywords(c.oldText, c.newText, jdAnalysis);
    return sum + kw.addedRequired.length + kw.addedATS.length;
  }, 0);

  const typeBreakdown = {};
  changesLog.forEach(c => { typeBreakdown[c.type] = (typeBreakdown[c.type] || 0) + 1; });

  const atsDelta = atsReportAfter && atsReportBefore
    ? atsReportAfter.score - atsReportBefore.score
    : null;

  // Summary bar
  let html = `
    <div class="explain-summary">
      <div class="explain-stat">
        <span class="explain-stat-val">${changesLog.length}</span>
        <span class="explain-stat-label">Changes Made</span>
      </div>
      <div class="explain-stat">
        <span class="explain-stat-val" style="color:var(--accent-cyan)">${totalKeywordsAdded}</span>
        <span class="explain-stat-label">Keywords Added</span>
      </div>
      ${atsDelta !== null ? `<div class="explain-stat">
        <span class="explain-stat-val" style="color:${atsDelta >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'}">
          ${atsDelta >= 0 ? '+' : ''}${atsDelta}%
        </span>
        <span class="explain-stat-label">ATS Score Δ</span>
      </div>` : ''}
      <div class="explain-type-breakdown">
        ${Object.entries(typeBreakdown).map(([type, count]) => {
          const meta = TYPE_META[type] || { label: type, color: 'var(--text-muted)', icon: '○' };
          return `<span class="type-pill" style="border-color:${meta.color};color:${meta.color}">${meta.icon} ${count} ${meta.label}</span>`;
        }).join('')}
      </div>
    </div>
  `;

  // --- Fabrication flags (human review required) ---
  if (fabricationFlags && fabricationFlags.length > 0) {
    const byType = {};
    fabricationFlags.forEach(f => { byType[f.type] = (byType[f.type] || []).concat(f); });
    html += `
      <div class="fabrication-flag-section">
        <div class="fabrication-flag-header">
          <span class="fabrication-flag-icon">⚠️</span>
          <span class="fabrication-flag-title">Fabrication Review Required (${fabricationFlags.length} flag${fabricationFlags.length !== 1 ? 's' : ''})</span>
        </div>
        <p class="fabrication-flag-desc">These entities appear in the generated resume but were NOT found in your original. Please verify they are accurate before using this output.</p>
        <div class="fabrication-flag-list">
          ${fabricationFlags.map(f => `
            <div class="fabrication-flag-card fab-type-${escapeHtml(f.type)}">
              <span class="fab-entity">${escapeHtml(f.entity)}</span>
              <span class="fab-type-badge">${escapeHtml(f.type.replace('_',' '))}</span>
              ${f.context ? `<span class="fab-context">&ldquo;...${escapeHtml(f.context)}...&rdquo;</span>` : ''}
            </div>
          `).join('')}
        </div>
      </div>
    `;
  }

  // --- Reverted locked sections notice ---
  if (revertedSections && revertedSections.length > 0) {
    html += `
      <div class="reverted-sections-notice">
        <span class="reverted-icon">🔒</span>
        <span>Locked section${revertedSections.length !== 1 ? 's' : ''} auto-reverted (AI attempted to modify protected content): <strong>${revertedSections.join(', ')}</strong></span>
      </div>
    `;
  }

  // --- Genuine Gaps (the antidote to '100% accurate' framing) ---
  const genuineGaps = atsReportAfter?.missingRequired || [];
  if (genuineGaps.length > 0) {
    html += `
      <div class="genuine-gaps-section">
        <div class="genuine-gaps-header">
          <span class="genuine-gaps-icon">📊</span>
          <span class="genuine-gaps-title">Genuine Gaps — Correctly Not Fabricated</span>
        </div>
        <p class="genuine-gaps-desc">These required skills were NOT in your original resume. The AI correctly did <strong>not</strong> invent them. Address these yourself to genuinely improve your match:</p>
        <div class="genuine-gaps-chips">
          ${genuineGaps.map(g => `<span class="kw-chip missing">${escapeHtml(g)}</span>`).join('')}
        </div>
      </div>
    `;
  }

  // Per-change cards
  html += `<div class="explain-changes-list">`;

  changesLog.forEach((change, idx) => {
    const meta = TYPE_META[change.type] || { label: change.type, color: 'var(--text-muted)', icon: '○' };
    const kw = detectAddedKeywords(change.oldText, change.newText, jdAnalysis);
    const hasKeywords = kw.addedRequired.length + kw.addedPreferred.length + kw.addedATS.length > 0;
    const hasTextDiff = change.oldText && change.newText && change.oldText !== change.newText;

    // Match this change to a JD responsibility (simple substring heuristic)
    const matchedResponsibility = (jdAnalysis?.responsibilities || []).find(resp => {
      if (!resp || !change.description) return false;
      const respWords = resp.toLowerCase().split(/\s+/).filter(w => w.length > 4);
      return respWords.some(w => change.description.toLowerCase().includes(w) || change.newText?.toLowerCase().includes(w));
    });

    html += `
      <div class="explain-card">
        <div class="explain-card-header">
          <div class="explain-card-num">${idx + 1}</div>
          <div class="explain-card-meta">
            <span class="explain-card-title">${escapeHtml(change.title)}</span>
            <span class="explain-type-badge" style="background:${meta.color}20;color:${meta.color};border-color:${meta.color}40">
              ${meta.icon} ${meta.label}
            </span>
          </div>
        </div>

        <div class="explain-reason">
          <span class="explain-reason-label">Why:</span>
          <span class="explain-reason-text">${escapeHtml(change.description)}</span>
        </div>

        ${matchedResponsibility ? `
          <div class="explain-jd-match">
            <span class="explain-jd-match-label">Matches JD requirement:</span>
            <span class="explain-jd-match-text">"${escapeHtml(matchedResponsibility)}"</span>
          </div>` : ''}

        ${hasKeywords ? `
          <div class="explain-keywords-added">
            <span class="explain-kw-label">Keywords added:</span>
            <div class="explain-kw-chips">
              ${kw.addedRequired.map(k => `<span class="explain-kw-chip req" title="Required skill">${escapeHtml(k)}</span>`).join('')}
              ${kw.addedATS.map(k => `<span class="explain-kw-chip ats" title="ATS keyword">${escapeHtml(k)}</span>`).join('')}
              ${kw.addedPreferred.map(k => `<span class="explain-kw-chip pref" title="Preferred skill">${escapeHtml(k)}</span>`).join('')}
            </div>
          </div>` : ''}

        ${hasTextDiff ? `
          <div class="explain-text-diff">
            <div class="explain-diff-old"><span class="diff-label">Before</span><span class="diff-text">${escapeHtml(change.oldText)}</span></div>
            <div class="explain-diff-new"><span class="diff-label">After</span><span class="diff-text">${escapeHtml(change.newText)}</span></div>
          </div>` : ''}
      </div>
    `;
  });

  html += `</div>`;

  return html;
}
