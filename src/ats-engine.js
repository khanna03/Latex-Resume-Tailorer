/**
 * ATS Matching Engine — purely deterministic, no AI calls.
 * Computes keyword coverage, missing keywords, skill gaps, and an ATS score.
 */

/**
 * @typedef {Object} ATSReport
 * @property {number} score - Overall ATS score 0–100
 * @property {number} requiredCoverage - % of required skills found
 * @property {number} preferredCoverage - % of preferred skills found
 * @property {number} softCoverage - % of soft skills found
 * @property {string[]} foundRequired - Required keywords matched in resume
 * @property {string[]} missingRequired - Required keywords NOT found in resume
 * @property {string[]} foundPreferred - Preferred keywords matched
 * @property {string[]} missingPreferred - Preferred keywords NOT found
 * @property {string[]} foundSoft - Soft skills matched
 * @property {string[]} missingSoft - Soft skills NOT found
 * @property {string[]} foundAtsKeywords - ATS priority keywords found
 * @property {string[]} missingAtsKeywords - ATS priority keywords NOT found
 * @property {string[]} skillGaps - The most important missing skills
 * @property {string} experienceLevel - Detected JD experience level
 * @property {string[]} industryTerms - Industry-specific terms found in resume
 */

/**
 * Normalize a string for keyword matching (lowercase, strip punctuation).
 * @param {string} str
 * @returns {string}
 */
function normalize(str) {
  return str.toLowerCase().replace(/[^a-z0-9+#.\s]/g, ' ').trim();
}

/**
 * Check if a keyword appears in the resume text (word-boundary-aware).
 * Handles multi-word phrases.
 * @param {string} keyword
 * @param {string} normalizedResumeText
 * @returns {boolean}
 */
function keywordFound(keyword, normalizedResumeText) {
  const normKw = normalize(keyword);
  if (!normKw) return false;
  // Escape for regex
  const escaped = normKw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|\\s|[,;(])${escaped}(?:$|\\s|[,;)])`, 'i');
  return re.test(normalizedResumeText);
}

/**
 * Partition a keyword array into found / missing based on resume text.
 * @param {string[]} keywords
 * @param {string} normalizedResumeText
 * @returns {{ found: string[], missing: string[] }}
 */
function partition(keywords, normalizedResumeText) {
  const found = [];
  const missing = [];
  keywords.forEach(kw => {
    if (keywordFound(kw, normalizedResumeText)) {
      found.push(kw);
    } else {
      missing.push(kw);
    }
  });
  return { found, missing };
}

/**
 * Compute coverage percentage safely.
 * @param {number} found
 * @param {number} total
 * @returns {number}
 */
function coverage(found, total) {
  if (total === 0) return 100;
  return Math.round((found / total) * 100);
}

/**
 * Compute a composite ATS score from coverage percentages.
 * Weights: required 50%, ATS keywords 30%, preferred 15%, soft 5%
 * @param {number} req - required coverage %
 * @param {number} pref - preferred coverage %
 * @param {number} soft - soft skill coverage %
 * @param {number} ats - ats keyword coverage %
 * @returns {number} 0–100
 */
function compositeScore(req, pref, soft, ats) {
  return Math.round(req * 0.50 + ats * 0.30 + pref * 0.15 + soft * 0.05);
}

/**
 * Main ATS analysis function.
 * @param {string} resumePlainText - Plain text extracted from the resume
 * @param {import('./jd-engine').JDAnalysis} jdAnalysis
 * @returns {ATSReport}
 */
export function computeATSScore(resumePlainText, jdAnalysis) {
  const normalizedResume = normalize(resumePlainText);

  const required = partition(jdAnalysis.required_skills || [], normalizedResume);
  const preferred = partition(jdAnalysis.preferred_skills || [], normalizedResume);
  const soft = partition(jdAnalysis.soft_skills || [], normalizedResume);
  const ats = partition(jdAnalysis.ats_keywords || [], normalizedResume);
  const industry = partition(jdAnalysis.industry_terms || [], normalizedResume);

  const reqCov = coverage(required.found.length, (jdAnalysis.required_skills || []).length);
  const prefCov = coverage(preferred.found.length, (jdAnalysis.preferred_skills || []).length);
  const softCov = coverage(soft.found.length, (jdAnalysis.soft_skills || []).length);
  const atsCov = coverage(ats.found.length, (jdAnalysis.ats_keywords || []).length);

  const score = compositeScore(reqCov, prefCov, softCov, atsCov);

  // Skill gaps = missing required + missing ATS keywords (deduplicated), limited to top 10
  const skillGapSet = new Set([...required.missing, ...ats.missing]);
  const skillGaps = [...skillGapSet].slice(0, 10);

  return {
    score,
    requiredCoverage: reqCov,
    preferredCoverage: prefCov,
    softCoverage: softCov,
    atsCoverage: atsCov,
    foundRequired: required.found,
    missingRequired: required.missing,
    foundPreferred: preferred.found,
    missingPreferred: preferred.missing,
    foundSoft: soft.found,
    missingSoft: soft.missing,
    foundAtsKeywords: ats.found,
    missingAtsKeywords: ats.missing,
    skillGaps,
    experienceLevel: jdAnalysis.experience_level || 'unknown',
    industryTerms: industry.found,
    industryTermsMissing: industry.missing,
  };
}

/**
 * Compare two ATS reports (before and after tailoring) and return delta metrics.
 * @param {ATSReport} before
 * @param {ATSReport} after
 * @returns {{ scoreDelta: number, newKeywordsAdded: string[], covDelta: number }}
 */
export function compareATSReports(before, after) {
  const scoreDelta = after.score - before.score;
  const covDelta = after.requiredCoverage - before.requiredCoverage;
  const newKeywordsAdded = after.foundRequired.filter(k => !before.foundRequired.includes(k));
  return { scoreDelta, newKeywordsAdded, covDelta };
}
