/**
 * Multi-Generation Quality Ranking Pipeline
 *
 * Accepts 3 candidates (conservative, moderate, aggressive),
 * scores each on multiple dimensions, and returns them ranked best-first.
 */

import { computeATSScore } from './ats-engine.js';
import { latexToPlainText, parseLatex } from './latex-parser.js';

/**
 * @typedef {Object} CandidateScore
 * @property {string} mode - 'conservative'|'moderate'|'aggressive'
 * @property {string} latex - The full tailored LaTeX
 * @property {number} totalScore - 0–100 composite ranking score
 * @property {number} atsScore - ATS keyword coverage score
 * @property {number} preservationScore - How much original structure was preserved
 * @property {number} changeCount - Number of bullets changed
 * @property {number} changesScore - Reward for meaningful changes (up to a point)
 * @property {object} atsReport - Full ATS report
 * @property {string[]} recommendations - Human-readable ranking reasons
 */

/**
 * Compute a preservation score: how much of the original structure is intact.
 * Higher is better for conservative; lower (more changes) may be better for aggressive.
 * @param {string} originalLatex
 * @param {string} tailoredLatex
 * @returns {number} 0–100
 */
function computePreservationScore(originalLatex, tailoredLatex) {
  if (!originalLatex || !tailoredLatex) return 50;
  const origLines = originalLatex.split('\n').length;
  const tailLines = tailoredLatex.split('\n').length;
  const origChars = originalLatex.length;
  const tailChars = tailoredLatex.length;

  // Penalize large structural divergence (line count change)
  const linePctChange = Math.abs(origLines - tailLines) / origLines;
  // Penalize large content divergence
  const charPctChange = Math.abs(origChars - tailChars) / origChars;

  const score = Math.max(0, 100 - (linePctChange * 40 + charPctChange * 30));
  return Math.round(score);
}

/**
 * Count how many bullets were changed between original and tailored.
 * @param {string} originalLatex
 * @param {string} tailoredLatex
 * @returns {number}
 */
function countChangedBullets(originalLatex, tailoredLatex) {
  const origAst = parseLatex(originalLatex);
  const tailAst = parseLatex(tailoredLatex);
  let changed = 0;

  origAst.sections.forEach((origSec, i) => {
    const tailSec = tailAst.sections[i];
    if (!tailSec) return;
    origSec.bullets.forEach((ob, j) => {
      const tb = tailSec.bullets[j];
      if (!tb || ob.text.trim() !== tb.text.trim()) changed++;
    });
  });

  return changed;
}

/**
 * Score a single candidate.
 * @param {string} originalLatex
 * @param {object} candidate - { mode, latex, changes }
 * @param {object} jdAnalysis
 * @returns {CandidateScore}
 */
function scoreCandidate(originalLatex, candidate, jdAnalysis) {
  const plainText = latexToPlainText(candidate.latex);
  const atsReport = computeATSScore(plainText, jdAnalysis);
  const atsScore = atsReport.score;

  const preservationScore = computePreservationScore(originalLatex, candidate.latex);
  const changeCount = countChangedBullets(originalLatex, candidate.latex);

  // Changes score: reward meaningful changes up to ~15 bullets, penalize excessive changes
  const changesScore = Math.min(100, changeCount * 8) - Math.max(0, (changeCount - 15) * 5);
  const normalizedChanges = Math.max(0, Math.min(100, changesScore));

  // Composite: ATS is weighted highest
  const totalScore = Math.round(
    atsScore * 0.60 +
    normalizedChanges * 0.25 +
    preservationScore * 0.15
  );

  const recommendations = [];
  if (atsScore >= 80) recommendations.push(`Strong ATS coverage (${atsScore}%)`);
  else if (atsScore >= 60) recommendations.push(`Moderate ATS coverage (${atsScore}%)`);
  else recommendations.push(`Low ATS coverage (${atsScore}%) — consider more aggressive mode`);

  if (atsReport.missingRequired.length > 0) {
    recommendations.push(`Still missing: ${atsReport.missingRequired.slice(0, 3).join(', ')}`);
  }
  if (preservationScore >= 85) recommendations.push('Excellent structural preservation');
  if (changeCount === 0) recommendations.push('No bullets were changed');
  else recommendations.push(`${changeCount} bullet${changeCount !== 1 ? 's' : ''} updated`);

  return {
    mode: candidate.mode,
    latex: candidate.latex,
    totalScore,
    atsScore,
    preservationScore,
    changeCount,
    changesScore: normalizedChanges,
    atsReport,
    recommendations,
  };
}

/**
 * Score and rank all candidates. Returns best-first.
 * @param {string} originalLatex
 * @param {Array<{mode: string, latex: string}>} candidates
 * @param {object} jdAnalysis
 * @returns {CandidateScore[]}
 */
export function rankCandidates(originalLatex, candidates, jdAnalysis) {
  const scored = candidates
    .filter(c => c && c.latex)
    .map(c => scoreCandidate(originalLatex, c, jdAnalysis));

  // Sort best first
  scored.sort((a, b) => b.totalScore - a.totalScore);

  return scored;
}

/**
 * Pick the best candidate from a ranked list.
 * @param {CandidateScore[]} rankedCandidates
 * @returns {CandidateScore}
 */
export function pickBest(rankedCandidates) {
  return rankedCandidates[0] || null;
}
