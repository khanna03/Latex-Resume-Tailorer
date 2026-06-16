/**
 * Job Description Analysis Engine — Phase 1
 *
 * Deterministic post-processing layer on top of the Gemini JD analysis response.
 * Normalises, deduplicates, and categorises extracted JD fields.
 * No ML, no embeddings. Pure string/regex processing.
 */

/**
 * @typedef {Object} JDAnalysis
 * @property {string}   role_title
 * @property {string}   company_context
 * @property {string}   experience_level
 * @property {string[]} required_skills
 * @property {string[]} preferred_skills
 * @property {string[]} soft_skills
 * @property {string[]} industry_terms
 * @property {string[]} ats_keywords
 * @property {string[]} responsibilities
 */

/**
 * Deduplicate an array of strings case-insensitively, preserving original casing
 * of the first occurrence.
 * @param {string[]} arr
 * @returns {string[]}
 */
function deduplicate(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  return arr.filter(item => {
    if (typeof item !== 'string' || !item.trim()) return false;
    const key = item.trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(s => s.trim());
}

/**
 * Sanitize and normalise a raw JD analysis response from Gemini.
 * Guarantees all fields exist and are deduplicated string arrays.
 *
 * @param {object} raw - Raw parsed JSON from Gemini
 * @returns {JDAnalysis}
 */
export function normaliseJDAnalysis(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      role_title: 'Unknown Role',
      company_context: '',
      experience_level: 'mid',
      required_skills: [],
      preferred_skills: [],
      soft_skills: [],
      industry_terms: [],
      ats_keywords: [],
      responsibilities: [],
    };
  }

  return {
    role_title:        typeof raw.role_title === 'string'        ? raw.role_title.trim()        : 'Unknown Role',
    company_context:   typeof raw.company_context === 'string'   ? raw.company_context.trim()   : '',
    experience_level:  typeof raw.experience_level === 'string'  ? raw.experience_level.trim()  : 'mid',
    required_skills:   deduplicate(raw.required_skills),
    preferred_skills:  deduplicate(raw.preferred_skills),
    soft_skills:       deduplicate(raw.soft_skills),
    industry_terms:    deduplicate(raw.industry_terms),
    ats_keywords:      deduplicate(raw.ats_keywords),
    responsibilities:  deduplicate(raw.responsibilities),
  };
}

/**
 * Build a quick-reference keyword set for O(1) lookups.
 * Combines required_skills + ats_keywords (the highest-value terms).
 *
 * @param {JDAnalysis} jd
 * @returns {Set<string>} lowercase keyword set
 */
export function buildKeywordSet(jd) {
  const all = [...(jd.required_skills || []), ...(jd.ats_keywords || [])];
  return new Set(all.map(k => k.toLowerCase().trim()));
}

/**
 * Render a compact JD intelligence card HTML string for display.
 * Used by the "JD Intelligence" panel shown before tailoring.
 *
 * @param {JDAnalysis} jd
 * @returns {string} HTML string
 */
export function renderJDIntelligenceHTML(jd) {
  const escape = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const chips = (arr, cls) => arr.length
    ? arr.map(k => `<span class="kw-chip ${cls}">${escape(k)}</span>`).join('')
    : '<span class="kw-chip none">None identified</span>';

  const levelBadge = {
    junior: 'level-junior', mid: 'level-mid', senior: 'level-senior',
    lead: 'level-lead', executive: 'level-exec',
  }[jd.experience_level] || 'level-mid';

  return `
    <div class="jd-intel-card">

      <div class="jd-intel-top">
        <div class="jd-intel-title-row">
          <span class="jd-role-title">${escape(jd.role_title)}</span>
          <span class="jd-level-badge ${levelBadge}">${escape(jd.experience_level)}</span>
        </div>
        ${jd.company_context ? `<div class="jd-company">${escape(jd.company_context)}</div>` : ''}
      </div>

      <div class="jd-section">
        <div class="jd-section-label">Required Skills <span class="jd-count">${jd.required_skills.length}</span></div>
        <div class="kw-chips">${chips(jd.required_skills, 'required')}</div>
      </div>

      <div class="jd-section">
        <div class="jd-section-label">Preferred Skills <span class="jd-count">${jd.preferred_skills.length}</span></div>
        <div class="kw-chips">${chips(jd.preferred_skills, 'preferred')}</div>
      </div>

      <div class="jd-section">
        <div class="jd-section-label">ATS Keywords <span class="jd-count">${jd.ats_keywords.length}</span></div>
        <div class="kw-chips">${chips(jd.ats_keywords, 'ats-kw')}</div>
      </div>

      <div class="jd-section">
        <div class="jd-section-label">Soft Skills <span class="jd-count">${jd.soft_skills.length}</span></div>
        <div class="kw-chips">${chips(jd.soft_skills, 'soft')}</div>
      </div>

      ${jd.responsibilities.length > 0 ? `
      <div class="jd-section">
        <div class="jd-section-label">Key Responsibilities <span class="jd-count">${jd.responsibilities.length}</span></div>
        <ul class="jd-resp-list">
          ${jd.responsibilities.slice(0, 6).map(r => `<li>${escape(r)}</li>`).join('')}
          ${jd.responsibilities.length > 6 ? `<li class="more-items">+${jd.responsibilities.length - 6} more…</li>` : ''}
        </ul>
      </div>` : ''}

      ${jd.industry_terms.length > 0 ? `
      <div class="jd-section">
        <div class="jd-section-label">Industry Terms <span class="jd-count">${jd.industry_terms.length}</span></div>
        <div class="kw-chips">${chips(jd.industry_terms, 'industry')}</div>
      </div>` : ''}

    </div>
  `;
}
