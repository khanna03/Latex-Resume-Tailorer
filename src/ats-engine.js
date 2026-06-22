/**
 * ATS Matching Engine — deterministic, no AI calls.
 *
 * Computes keyword coverage, missing keywords, skill gaps, and an ATS score.
 *
 * Build prompt ground rule: never present ATS score as a bare number claiming
 * accuracy. Always output a confidence range and a rationale note, since ATS
 * systems are proprietary and inconsistent. The score here is an ESTIMATE.
 */

/**
 * @typedef {Object} ATSReport
 * @property {number}   score              - Overall ATS score estimate 0–100 (midpoint)
 * @property {number}   scoreMin           - Lower bound of confidence range
 * @property {number}   scoreMax           - Upper bound of confidence range
 * @property {string}   methodNote         - One-line explanation of how score was derived
 * @property {number}   requiredCoverage   - % of required skills found (keyword match)
 * @property {number}   preferredCoverage  - % of preferred skills found
 * @property {number}   softCoverage       - % of soft skills found
 * @property {number}   atsCoverage        - % of ATS priority keywords found
 * @property {string[]} foundRequired      - Required keywords matched in resume
 * @property {string[]} missingRequired    - Required keywords NOT found in resume
 * @property {string[]} foundPreferred     - Preferred keywords matched
 * @property {string[]} missingPreferred   - Preferred keywords NOT found
 * @property {string[]} foundSoft          - Soft skills matched
 * @property {string[]} missingSoft        - Soft skills NOT found
 * @property {string[]} foundAtsKeywords   - ATS priority keywords found
 * @property {string[]} missingAtsKeywords - ATS priority keywords NOT found
 * @property {string[]} skillGaps          - Most important missing skills (deduplicated top-10)
 * @property {string}   experienceLevel    - JD experience level string
 * @property {string[]} industryTerms      - Industry-specific terms found in resume
 * @property {string[]} industryTermsMissing - Industry terms NOT found
 */

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/**
 * Normalise a string for keyword matching: lowercase, collapse punctuation.
 * @param {string} str
 * @returns {string}
 */
function normalize(str) {
  return str.toLowerCase().replace(/[^a-z0-9+#.\s]/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Keyword detection
// ---------------------------------------------------------------------------

/**
 * Check if a keyword appears in the resume text with word-boundary awareness.
 * Handles multi-word phrases and tech abbreviations (C++, C#, .NET, etc.).
 *
 * @param {string} keyword
 * @param {string} normalizedResumeText
 * @returns {boolean}
 */
function keywordFound(keyword, normalizedResumeText) {
  const normKw = normalize(keyword);
  if (!normKw) return false;
  // Escape regex metacharacters so things like "C++" become "C\+\+" instead of failing
  const escaped = normKw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Word-boundary aware, allows comma/semicolon/paren as delimiters
  const re = new RegExp(`(?:^|\\s|[,;(])${escaped}(?:$|\\s|[,;)])`, 'i');
  return re.test(normalizedResumeText);
}

/**
 * Partition a keyword array into found/missing based on resume text.
 * @param {string[]} keywords
 * @param {string}   normalizedResumeText
 * @returns {{ found: string[], missing: string[] }}
 */
function partition(keywords, normalizedResumeText) {
  const found   = [];
  const missing = [];
  (keywords || []).forEach(kw => {
    if (keywordFound(kw, normalizedResumeText)) {
      found.push(kw);
    } else {
      missing.push(kw);
    }
  });
  return { found, missing };
}

// ---------------------------------------------------------------------------
// Score computation
// ---------------------------------------------------------------------------

/**
 * Compute coverage percentage safely (returns 100 when total is 0, since
 * having no required skills means the requirement is trivially satisfied).
 * @param {number} found
 * @param {number} total
 * @returns {number} 0–100
 */
function coverage(found, total) {
  if (total === 0) return 100;
  return Math.round((found / total) * 100);
}

/**
 * Compute a weighted composite ATS score from coverage percentages.
 *
 * Weights (justified):
 *   required skills  50% — most ATS systems gate on required qualifications
 *   ATS keywords     30% — high-priority terms that appear in screening configs
 *   preferred skills 15% — tie-breakers; not always in screening rules
 *   soft skills       5% — least likely to be machine-scored
 *
 * @param {number} req  - required coverage %
 * @param {number} pref - preferred coverage %
 * @param {number} soft - soft skill coverage %
 * @param {number} ats  - ATS keyword coverage %
 * @returns {number} 0–100
 */
function compositeScore(req, pref, soft, ats) {
  return Math.round(req * 0.50 + ats * 0.30 + pref * 0.15 + soft * 0.05);
}

/**
 * Compute a ±uncertainty band around a score.
 * The band reflects that ATS systems are proprietary and use undisclosed
 * weighting — our keyword-based estimate has inherent imprecision.
 *
 * Band width is wider at moderate scores (more uncertainty) and narrower
 * at extremes (very low or very high scores are more reliable signals).
 *
 * @param {number} score - 0–100
 * @returns {{ min: number, max: number }}
 */
function uncertaintyBand(score) {
  // We assume moderate scores (20-80) have more uncertainty (±9 pts) because missing a few keywords swings the score wildly.
  // Extremely low or high scores are mathematically more certain (±5 pts).
  const halfBand = score > 20 && score < 80 ? 9 : 5;
  return {
    min: Math.max(0,   score - halfBand),
    max: Math.min(100, score + halfBand),
  };
}

// ---------------------------------------------------------------------------
// Main ATS analysis function
// ---------------------------------------------------------------------------

/**
 * Compute a comprehensive ATS matching report.
 *
 * @param {string} resumePlainText   - Plain text extracted from the resume
 * @param {import('./jd-engine').JDAnalysis} jdAnalysis
 * @returns {ATSReport}
 */
export function computeATSScore(resumePlainText, jdAnalysis) {
  const normalizedResume = normalize(resumePlainText);

  const required  = partition(jdAnalysis.required_skills  || [], normalizedResume);
  const preferred = partition(jdAnalysis.preferred_skills || [], normalizedResume);
  const soft      = partition(jdAnalysis.soft_skills      || [], normalizedResume);
  const ats       = partition(jdAnalysis.ats_keywords     || [], normalizedResume);
  const industry  = partition(jdAnalysis.industry_terms   || [], normalizedResume);

  const reqCov  = coverage(required.found.length,  (jdAnalysis.required_skills  || []).length);
  const prefCov = coverage(preferred.found.length, (jdAnalysis.preferred_skills || []).length);
  const softCov = coverage(soft.found.length,      (jdAnalysis.soft_skills      || []).length);
  const atsCov  = coverage(ats.found.length,       (jdAnalysis.ats_keywords     || []).length);

  const score  = compositeScore(reqCov, prefCov, softCov, atsCov);
  const { min: scoreMin, max: scoreMax } = uncertaintyBand(score);

  // Combine missing required skills and missing ATS priority keywords into a single Set to remove duplicates
  const skillGapSet = new Set([...required.missing, ...ats.missing]);
  // Only return the top 10 gaps so we don't overwhelm the user
  const skillGaps   = [...skillGapSet].slice(0, 10);

  const methodNote =
    `${scoreMin}–${scoreMax}%, based on keyword coverage ` +
    `(required ×0.50, ATS keywords ×0.30, preferred ×0.15, soft ×0.05); ` +
    `actual ATS behavior varies by vendor and is not guaranteed.`;

  return {
    score,
    scoreMin,
    scoreMax,
    methodNote,
    requiredCoverage:   reqCov,
    preferredCoverage:  prefCov,
    softCoverage:       softCov,
    atsCoverage:        atsCov,
    foundRequired:      required.found,
    missingRequired:    required.missing,
    foundPreferred:     preferred.found,
    missingPreferred:   preferred.missing,
    foundSoft:          soft.found,
    missingSoft:        soft.missing,
    foundAtsKeywords:   ats.found,
    missingAtsKeywords: ats.missing,
    skillGaps,
    experienceLevel:    jdAnalysis.experience_level || 'unknown',
    industryTerms:      industry.found,
    industryTermsMissing: industry.missing,
  };
}

// ---------------------------------------------------------------------------
// Comparison helper
// ---------------------------------------------------------------------------

/**
 * Compare two ATS reports (before and after tailoring) and return delta metrics.
 * @param {ATSReport} before
 * @param {ATSReport} after
 * @returns {{ scoreDelta: number, newKeywordsAdded: string[], covDelta: number }}
 */
export function compareATSReports(before, after) {
  const scoreDelta      = after.score - before.score;
  const covDelta        = after.requiredCoverage - before.requiredCoverage;
  const newKeywordsAdded = after.foundRequired.filter(k => !before.foundRequired.includes(k));
  return { scoreDelta, newKeywordsAdded, covDelta };
}
