/**
 * Curricula AI — Frontend API Bridge
 *
 * This module encapsulates all network communications with our Python FastAPI backend.
 * It stores and manages the user's JWT access token locally and handles formatting
 * requests (e.g. Multipart/Form-data for file uploads, Blob types for PDF downloads).
 */

const API_BASE_URL = 'http://localhost:8000/api';

/**
 * Base wrapper for fetch requests.
 * Automatically injects JWT Bearer tokens and handles error states.
 */
async function apiRequest(endpoint, options = {}) {
  const token = localStorage.getItem('curricula_token');
  const headers = options.headers || {};

  // Inject authentication header if JWT token is stored
  if (token && !headers['Authorization']) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const config = {
    ...options,
    headers,
  };

  const response = await fetch(`${API_BASE_URL}${endpoint}`, config);

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const message = errorData.detail?.message || errorData.detail || `HTTP ${response.status}`;
    throw new Error(typeof message === 'object' ? JSON.stringify(message) : message);
  }

  // Handle binary PDF file streams or datasets downloads
  const contentType = response.headers.get('Content-Type') || '';
  if (contentType.includes('application/pdf') || contentType.includes('application/x-jsonlines')) {
    return await response.blob();
  }

  return await response.json();
}

// ---------------------------------------------------------------------------
# 1. Authentication Requests
// ---------------------------------------------------------------------------

/**
 * Register a new user account.
 */
export async function registerUser(email, password) {
  return await apiRequest('/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

/**
 * Log in an existing user and cache their token.
 */
export async function loginUser(email, password) {
  // OAuth2 standard uses urlencoded form-data payload (username & password keys)
  const formData = new URLSearchParams();
  formData.append('username', email);
  formData.append('password', password);

  const data = await apiRequest('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formData.toString(),
  });

  if (data.access_token) {
    localStorage.setItem('curricula_token', data.access_token);
  }
  return data;
}

/**
 * Clean cached auth session.
 */
export function logoutUser() {
  localStorage.removeItem('curricula_token');
}

/**
 * Checks if user session token is cached.
 */
export function isAuthenticated() {
  return !!localStorage.getItem('curricula_token');
}

// ---------------------------------------------------------------------------
# 2. Resume & AST Requests
// ---------------------------------------------------------------------------

/**
 * Upload a .tex or .pdf resume to the backend.
 * Triggers server-side PDF-to-LaTeX conversion if file is a PDF,
 * parses AST structure, computes vectors, and saves to Postgres.
 */
export async function uploadResume(file, title = 'My Resume') {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('title', title);

  // We omit Content-Type header so the browser sets the boundary parameter automatically
  return await apiRequest('/resumes/upload', {
    method: 'POST',
    body: formData,
  });
}

/**
 * Fetches all resumes owned by the logged-in user.
 */
export async function getResumes() {
  return await apiRequest('/resumes');
}

/**
 * Fetches full detail (parsed AST JSON) for a specific resume.
 */
export async function getResumeDetail(resumeId) {
  return await apiRequest(`/resumes/${resumeId}`);
}

// ---------------------------------------------------------------------------
# 3. Tailoring Pipeline Requests
// ---------------------------------------------------------------------------

/**
 * Extracts intelligence keywords and criteria from a Job Description.
 */
export async function analyzeJD(jdText) {
  return await apiRequest('/tailor/analyze-jd', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jd_text: jdText }),
  });
}

/**
 * Executes the resume optimization pipeline.
 * Computes ATS scores, generates mode variants, reverts locks, and checks fabrication.
 */
export async function runTailoringPipeline(resumeId, jdAnalysis, config = {}, lockedSectionIds = []) {
  const payload = {
    resume_id: resumeId,
    jd_analysis: jdAnalysis,
    config: {
      mode: config.mode || 'moderate',
      custom_instructions: config.customInstructions || '',
    },
    locked_section_ids: lockedSectionIds,
  };

  return await apiRequest('/tailor/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

// ---------------------------------------------------------------------------
# 4. Feedback & Compiler Requests
// ---------------------------------------------------------------------------

/**
 * Saves review evaluation and comments for a generated version.
 */
export async function submitFeedback(versionId, scoreStars, thumbsDirection, comments = '') {
  const payload = {
    version_id: versionId,
    score_stars: scoreStars,
    thumbs_direction: thumbsDirection,
    comments,
  };

  return await apiRequest('/feedback/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/**
 * Exports the ML training dataset. Returns a JSONL blob file.
 */
export async function exportMLDataset() {
  return await apiRequest('/feedback/export', {
    method: 'GET',
  });
}

/**
 * Compiles LaTeX source code to a PDF document binary blob.
 */
export async function compileLaTeX(latexCode) {
  return await apiRequest('/feedback/compile', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ latex_code: latexCode }),
  });
}

/**
 * Fetches all tailored version history for the logged-in user.
 */
export async function getVersionHistory() {
  return await apiRequest('/tailor/history');
}

/**
 * Fetches details of a specific version history entry.
 */
export async function getVersionDetail(versionId) {
  return await apiRequest(`/tailor/history/${versionId}`);
}
