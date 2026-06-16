/**
 * Version History — LocalStorage-backed persistence for tailoring sessions.
 * Caps at MAX_VERSIONS entries, auto-pruning oldest on overflow.
 */

const STORAGE_KEY = 'curricula_version_history';
const MAX_VERSIONS = 25;

/**
 * @typedef {Object} VersionEntry
 * @property {string} id - UUID
 * @property {number} timestamp - Unix ms
 * @property {string} jobTitle - Extracted from JD analysis (best effort)
 * @property {string} originalLatex
 * @property {string} jobDescription
 * @property {string} tailoredLatex
 * @property {string} mode - 'conservative'|'moderate'|'aggressive'
 * @property {number} atsScoreBefore
 * @property {number} atsScoreAfter
 * @property {number} scoreDelta
 * @property {number} changesCount
 */

/**
 * Generate a simple UUID v4.
 * @returns {string}
 */
function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

/**
 * Load all versions from LocalStorage.
 * @returns {VersionEntry[]}
 */
function loadAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

/**
 * Persist all versions to LocalStorage.
 * @param {VersionEntry[]} versions
 */
function saveAll(versions) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(versions));
  } catch (e) {
    console.warn('Version history: localStorage write failed', e);
  }
}

/**
 * Save a new version entry. Auto-prunes oldest if over MAX_VERSIONS.
 * @param {Omit<VersionEntry, 'id' | 'timestamp'>} data
 * @returns {VersionEntry} The saved entry
 */
export function saveVersion(data) {
  const versions = loadAll();
  const entry = {
    id: uuid(),
    timestamp: Date.now(),
    ...data,
  };

  versions.unshift(entry); // Newest first

  // Prune if over limit
  if (versions.length > MAX_VERSIONS) {
    versions.splice(MAX_VERSIONS);
  }

  saveAll(versions);
  return entry;
}

/**
 * List all saved versions (summary data only, no full LaTeX to save memory).
 * @returns {Array<Pick<VersionEntry, 'id'|'timestamp'|'jobTitle'|'mode'|'atsScoreBefore'|'atsScoreAfter'|'scoreDelta'|'changesCount'>>}
 */
export function listVersions() {
  return loadAll().map(({ id, timestamp, jobTitle, mode, atsScoreBefore, atsScoreAfter, scoreDelta, changesCount }) => ({
    id, timestamp, jobTitle, mode, atsScoreBefore, atsScoreAfter, scoreDelta, changesCount,
  }));
}

/**
 * Load a full version entry by ID.
 * @param {string} id
 * @returns {VersionEntry|null}
 */
export function loadVersion(id) {
  return loadAll().find(v => v.id === id) || null;
}

/**
 * Delete a single version entry.
 * @param {string} id
 */
export function deleteVersion(id) {
  const versions = loadAll().filter(v => v.id !== id);
  saveAll(versions);
}

/**
 * Clear all version history.
 */
export function clearAllVersions() {
  localStorage.removeItem(STORAGE_KEY);
}

/**
 * Format a timestamp as a readable date string.
 * @param {number} ts - Unix ms
 * @returns {string}
 */
export function formatTimestamp(ts) {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}
