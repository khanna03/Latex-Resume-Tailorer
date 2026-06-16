/**
 * Feedback Store — Collects user ratings and exports ML-ready JSONL datasets.
 */

const FEEDBACK_KEY = 'curricula_feedback_store';

/**
 * @typedef {Object} FeedbackRecord
 * @property {string} id - Session ID (matches version history entry)
 * @property {number} timestamp
 * @property {string} resume - Original LaTeX
 * @property {string} jobDescription
 * @property {string} generatedOutput - Final tailored LaTeX
 * @property {string} mode - 'conservative'|'moderate'|'aggressive'
 * @property {number} atsScoreBefore
 * @property {number} atsScoreAfter
 * @property {'up'|'down'|null} thumbRating
 * @property {number|null} starRating - 1–5
 * @property {string} userCorrection - Free-text correction from user
 */

/**
 * Load all feedback records.
 * @returns {FeedbackRecord[]}
 */
function loadAll() {
  try {
    const raw = localStorage.getItem(FEEDBACK_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/**
 * Persist all feedback records.
 * @param {FeedbackRecord[]} records
 */
function saveAll(records) {
  try {
    localStorage.setItem(FEEDBACK_KEY, JSON.stringify(records));
  } catch (e) {
    console.warn('Feedback store: localStorage write failed', e);
  }
}

/**
 * Submit or update feedback for a session.
 * @param {string} sessionId
 * @param {object} sessionData - { resume, jobDescription, generatedOutput, mode, atsScoreBefore, atsScoreAfter }
 * @param {object} feedbackData - { thumbRating, starRating, userCorrection }
 * @returns {FeedbackRecord}
 */
export function submitFeedback(sessionId, sessionData, feedbackData) {
  const records = loadAll();
  const existing = records.findIndex(r => r.id === sessionId);

  const record = {
    id: sessionId,
    timestamp: Date.now(),
    resume: sessionData.resume || '',
    jobDescription: sessionData.jobDescription || '',
    generatedOutput: sessionData.generatedOutput || '',
    mode: sessionData.mode || 'moderate',
    atsScoreBefore: sessionData.atsScoreBefore || 0,
    atsScoreAfter: sessionData.atsScoreAfter || 0,
    thumbRating: feedbackData.thumbRating || null,
    starRating: feedbackData.starRating || null,
    userCorrection: feedbackData.userCorrection || '',
  };

  if (existing >= 0) {
    records[existing] = record;
  } else {
    records.unshift(record);
  }

  saveAll(records);
  return record;
}

/**
 * Get feedback count.
 * @returns {number}
 */
export function getFeedbackCount() {
  return loadAll().length;
}

/**
 * Export all feedback records as a JSONL blob for ML fine-tuning.
 * Schema per line: { input: { resume, jobDescription }, output: generatedOutput, metadata: { mode, atsScoreBefore, atsScoreAfter, thumbRating, starRating, userCorrection, timestamp } }
 * @returns {Blob}
 */
export function exportDatasetBlob() {
  const records = loadAll();
  const lines = records.map(r => JSON.stringify({
    input: {
      resume: r.resume,
      jobDescription: r.jobDescription,
    },
    output: r.generatedOutput,
    metadata: {
      mode: r.mode,
      atsScoreBefore: r.atsScoreBefore,
      atsScoreAfter: r.atsScoreAfter,
      thumbRating: r.thumbRating,
      starRating: r.starRating,
      userCorrection: r.userCorrection,
      timestamp: r.timestamp,
    },
  }));

  return new Blob([lines.join('\n')], { type: 'application/jsonl' });
}

/**
 * Clear all feedback records.
 */
export function clearFeedback() {
  localStorage.removeItem(FEEDBACK_KEY);
}
