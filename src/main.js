import './style.css';
import { extractTextFromPDF } from './pdf-parser.js';
import { pdfToLatex } from './gemini.js';

/**
 * Curricula AI — Hybrid AI + ML Pipeline Orchestrator
 * 
 * Pipeline stages:
 * 1. Parse LaTeX → AST
 * 2. Analyze JD → intelligence
 * 3. Compute ATS pre-score
 * 4. Apply protected section masks
 * 5. Multi-generation (3 parallel or single)
 * 6. Rank candidates
 * 7. Reconstruct LaTeX from best candidate
 * 8. Deterministic validate → repair loop → re-validate
 * 9. Render semantic diff + ATS + confidence + feedback
 */

import { analyzeJobDescription, tailorResumeAST, repairLatex, computeEmbedding, cosineSimilarity } from './gemini.js';
// pdfToLatex imported at top
import { parseLatex, astToTextSummary, getSectionNames, latexToPlainText } from './latex-parser.js';
import { computeATSScore, compareATSReports } from './ats-engine.js';
import { reconstructLatex, buildModificationMap } from './reconstruction-engine.js';
import { validateLatexDeterministic, formatErrorsForRepair } from './latex-validator.js';
import { computeSemanticDiff, renderSemanticDiffHtml } from './semantic-diff.js';
import { rankCandidates, pickBest } from './ranking-pipeline.js';
import { saveVersion, listVersions, loadVersion, deleteVersion, clearAllVersions, formatTimestamp } from './version-history.js';
import { submitFeedback, exportDatasetBlob, getFeedbackCount } from './feedback-store.js';
import { escapeHtml } from './diff-helper.js';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  apiKey: localStorage.getItem('gemini_api_key') || '',
  model: localStorage.getItem('gemini_model') || 'gemini-2.5-flash',
  latexInput: '',
  jdInput: '',
  originalAst: null,
  jdAnalysis: null,
  atsReportBefore: null,
  atsReportAfter: null,
  tailoredLatex: '',
  validationReport: null,
  candidates: [],
  rankedCandidates: [],
  selectedCandidateMode: 'moderate',
  changesLog: [],
  isProcessing: false,
  protectedSections: new Set(), // section IDs to lock
  generationMode: 'single',    // 'single' | 'multi'
  currentMode: 'moderate',     // 'conservative' | 'moderate' | 'aggressive'
  currentSessionId: null,
  feedbackSubmitted: false,
  semanticSimilarity: null,
};

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------
const $ = id => document.getElementById(id);
const $q = sel => document.querySelector(sel);
const $qa = sel => document.querySelectorAll(sel);

function elChild(parent, sel) {
  return parent ? parent.querySelector(sel) : null;
}

// Cache all DOM references
const el = {
  // Header
  settingsBtn: $('settings-btn'),
  statusIndicator: $('status-indicator'),
  statusText: $q('.status-text'),
  historyBtn: $('history-btn'),
  exportDatasetBtn: $('export-dataset-btn'),

  // Settings drawer
  settingsDrawer: $('settings-drawer'),
  closeSettingsBtn: $('close-settings-btn'),
  saveSettingsBtn: $('save-settings-btn'),
  apiKeyInput: $('api-key-input'),
  modelSelect: $('model-select'),
  toggleKeyVisibility: $('toggle-key-visibility'),

  // History drawer
  historyDrawer: $('history-drawer'),
  closeHistoryBtn: $('close-history-btn'),
  historyList: $('history-list'),
  clearHistoryBtn: $('clear-history-btn'),

  // Inputs
  dropZone: $('drop-zone'),
  fileInput: $('file-input'),
  latexInputTextarea: $('latex-input'),
  jdInputTextarea: $('jd-input'),

  // Controls
  generationModeSelect: $('generation-mode'),
  tailorModeSelect: $('tailor-mode'),
  customInstructionsInput: $('custom-instructions'),
  tailorBtn: $('tailor-btn'),
  tailorBtnText: $q('#tailor-btn .btn-text'),
  tailorBtnSpinner: $q('#tailor-btn .btn-spinner'),

  // Protected sections
  protectedChips: $qa('.protected-chip'),

  // Pipeline tracker
  pipelineTracker: $('pipeline-tracker'),

  // Output tabs & panels
  diffView: $('diff-view'),
  latexOutputTextarea: $('latex-output'),
  logView: $('log-view'),
  atsPanel: $('ats-panel'),
  confidencePanel: $('confidence-panel'),
  candidatesPanel: $('candidates-panel'),
  copyBtn: $('copy-btn'),
  downloadBtn: $('download-btn'),
  validationBadge: $('validation-badge'),
  validationBadgeText: $q('#validation-badge .validation-msg'),
  validationBadgeBullet: $q('#validation-badge .status-bullet'),

  // Feedback widget
  feedbackWidget: $('feedback-widget'),
  thumbUp: $('thumb-up'),
  thumbDown: $('thumb-down'),
  starBtns: $qa('.star-btn'),
  correctionInput: $('correction-input'),
  submitFeedbackBtn: $('submit-feedback-btn'),
  feedbackCount: $('feedback-count'),
};

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
function init() {
  if (state.apiKey) {
    el.apiKeyInput.value = state.apiKey;
    updateStatusBadge('ready');
  } else {
    updateStatusBadge('error', 'API Key Missing');
    setTimeout(() => openSettings(), 800);
  }
  el.modelSelect.value = state.model;

  setupEventListeners();
  updateFeedbackCount();
  renderProtectedChips();
}

// ---------------------------------------------------------------------------
// Event Listeners
// ---------------------------------------------------------------------------
function setupEventListeners() {
  // Settings
  el.settingsBtn.addEventListener('click', openSettings);
  el.closeSettingsBtn.addEventListener('click', closeSettings);
  el.saveSettingsBtn.addEventListener('click', saveSettings);
  el.settingsDrawer.addEventListener('click', e => { if (e.target === el.settingsDrawer) closeSettings(); });
  el.toggleKeyVisibility.addEventListener('click', () => {
    const isPass = el.apiKeyInput.type === 'password';
    el.apiKeyInput.type = isPass ? 'text' : 'password';
    el.toggleKeyVisibility.textContent = isPass ? 'Hide' : 'Show';
  });

  // History
  el.historyBtn.addEventListener('click', openHistory);
  el.closeHistoryBtn.addEventListener('click', closeHistory);
  el.historyDrawer.addEventListener('click', e => { if (e.target === el.historyDrawer) closeHistory(); });
  el.clearHistoryBtn.addEventListener('click', () => {
    clearAllVersions();
    renderHistoryList();
  });

  // Tabs
  setupTabs('input-tabs');
  setupTabs('output-tabs');

  // File drag & drop
  el.dropZone.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', e => { if (e.target.files[0]) readFile(e.target.files[0]); });
  ['dragenter', 'dragover'].forEach(evt => el.dropZone.addEventListener(evt, e => { e.preventDefault(); el.dropZone.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(evt => el.dropZone.addEventListener(evt, e => { e.preventDefault(); el.dropZone.classList.remove('dragover'); }));
  el.dropZone.addEventListener('drop', e => { const f = e.dataTransfer?.files?.[0]; if (f) readFile(f); });

  // Protected section chips
  el.protectedChips.forEach(chip => {
    chip.addEventListener('click', () => toggleProtectedSection(chip));
  });

  // Generation mode
  el.generationModeSelect?.addEventListener('change', e => {
    state.generationMode = e.target.value;
    const singleModeRow = $('single-mode-row');
    if (singleModeRow) singleModeRow.style.display = e.target.value === 'single' ? '' : 'none';
  });

  // Main action
  el.tailorBtn.addEventListener('click', handleTailorAction);

  // Output actions
  el.copyBtn.addEventListener('click', copyToClipboard);
  el.downloadBtn.addEventListener('click', downloadTexFile);
  el.exportDatasetBtn?.addEventListener('click', exportDataset);

  // Feedback
  el.thumbUp?.addEventListener('click', () => setThumb('up'));
  el.thumbDown?.addEventListener('click', () => setThumb('down'));
  el.starBtns?.forEach(btn => {
    btn.addEventListener('click', () => setStarRating(parseInt(btn.dataset.star)));
    btn.addEventListener('mouseenter', () => highlightStars(parseInt(btn.dataset.star)));
    btn.addEventListener('mouseleave', () => highlightStars(state._starRating || 0));
  });
  el.submitFeedbackBtn?.addEventListener('click', handleFeedbackSubmit);
}

// ---------------------------------------------------------------------------
// Tab handling
// ---------------------------------------------------------------------------
function setupTabs(groupName) {
  const container = $q(`.tabs[data-group="${groupName}"]`);
  if (!container) return;
  const tabBtns = container.querySelectorAll('.tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const targetId = btn.getAttribute('data-tab');
      btn.closest('.panel-section').querySelectorAll('.tab-content').forEach(c => {
        c.classList.toggle('active', c.id === targetId);
      });
    });
  });
}

// ---------------------------------------------------------------------------
// File handling
// ---------------------------------------------------------------------------
async function readFile(file) {
  const isPDF = file.name.toLowerCase().endsWith('.pdf');
  const isTex = file.name.toLowerCase().endsWith('.tex');

  if (!isPDF && !isTex) {
    alert('Please upload a .tex or .pdf file.');
    return;
  }

  const dropText = el.dropZone.querySelector('.drop-text');

  if (isTex) {
    const reader = new FileReader();
    reader.onload = e => {
      el.latexInputTextarea.value = e.target.result;
      if (dropText) dropText.innerHTML = `Loaded: <strong>${escapeHtml(file.name)}</strong> (${(file.size / 1024).toFixed(1)} KB)`;
      el.dropZone.style.borderColor = 'var(--accent-cyan)';
    };
    reader.readAsText(file);
    return;
  }

  // PDF flow
  if (!state.apiKey) {
    alert('An API key is required to convert PDF resumes to LaTeX. Please add your Gemini API key in Settings first.');
    openSettings();
    return;
  }

  el.dropZone.style.borderColor = 'var(--accent-yellow)';
  if (dropText) dropText.innerHTML = `<span style="color:var(--accent-yellow)">⟳ Extracting text from PDF...</span>`;

  try {
    const extractedText = await extractTextFromPDF(file);

    if (dropText) dropText.innerHTML = `<span style="color:var(--accent-blue)">⟳ Converting to LaTeX via AI...</span>`;

    let latexResult = await pdfToLatex(state.apiKey, state.model, extractedText);

    // Strip any markdown code fences the model might have added
    latexResult = latexResult
      .replace(/^```(?:latex|tex)?\s*/i, '')
      .replace(/\s*```\s*$/, '')
      .trim();

    el.latexInputTextarea.value = latexResult;
    el.dropZone.style.borderColor = 'var(--accent-cyan)';
    if (dropText) dropText.innerHTML = `✓ PDF converted: <strong>${escapeHtml(file.name)}</strong> → LaTeX (${(file.size / 1024).toFixed(1)} KB)`;

  } catch (err) {
    console.error('PDF conversion failed:', err);
    el.dropZone.style.borderColor = 'var(--accent-red)';
    if (dropText) dropText.innerHTML = `<span style="color:var(--accent-red)">✕ PDF conversion failed: ${escapeHtml(err.message)}</span>`;
  }
}

// ---------------------------------------------------------------------------
// Protected Sections
// ---------------------------------------------------------------------------
function renderProtectedChips() {
  el.protectedChips.forEach(chip => {
    const sectionTitle = chip.dataset.section?.toLowerCase();
    chip.classList.toggle('locked', state.protectedSections.has(sectionTitle));
  });
}

function toggleProtectedSection(chip) {
  const key = chip.dataset.section?.toLowerCase();
  if (!key) return;
  if (state.protectedSections.has(key)) {
    state.protectedSections.delete(key);
    chip.classList.remove('locked');
  } else {
    state.protectedSections.add(key);
    chip.classList.add('locked');
  }
}

function getLockedSectionIds(ast) {
  if (!ast || !state.protectedSections.size) return new Set();
  const locked = new Set();
  ast.sections.forEach(section => {
    const titleLower = section.title.toLowerCase();
    for (const protectedKey of state.protectedSections) {
      if (titleLower.includes(protectedKey)) {
        locked.add(section.id);
      }
    }
  });
  return locked;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function openSettings() { el.settingsDrawer.classList.remove('hidden'); }
function closeSettings() { el.settingsDrawer.classList.add('hidden'); }

function saveSettings() {
  state.apiKey = el.apiKeyInput.value.trim();
  state.model = el.modelSelect.value;
  localStorage.setItem('gemini_api_key', state.apiKey);
  localStorage.setItem('gemini_model', state.model);
  closeSettings();
  updateStatusBadge(state.apiKey ? 'ready' : 'error', state.apiKey ? '' : 'API Key Missing');
}

// ---------------------------------------------------------------------------
// Version History drawer
// ---------------------------------------------------------------------------
function openHistory() {
  renderHistoryList();
  el.historyDrawer.classList.remove('hidden');
}

function closeHistory() { el.historyDrawer.classList.add('hidden'); }

function renderHistoryList() {
  const versions = listVersions();
  if (!el.historyList) return;
  if (versions.length === 0) {
    el.historyList.innerHTML = '<p class="history-empty">No saved sessions yet. Run the pipeline to create history entries.</p>';
    return;
  }
  el.historyList.innerHTML = versions.map(v => `
    <div class="history-entry" data-id="${v.id}">
      <div class="history-entry-header">
        <span class="history-job">${escapeHtml(v.jobTitle || 'Untitled Job')}</span>
        <span class="history-mode history-mode-${v.mode}">${v.mode}</span>
      </div>
      <div class="history-entry-meta">
        <span class="history-date">${formatTimestamp(v.timestamp)}</span>
        <span class="history-score">ATS: ${v.atsScoreBefore || 0}% → <strong>${v.atsScoreAfter || 0}%</strong></span>
        <span class="history-delta ${(v.scoreDelta || 0) >= 0 ? 'positive' : 'negative'}">
          ${(v.scoreDelta || 0) >= 0 ? '+' : ''}${v.scoreDelta || 0}pts
        </span>
      </div>
      <div class="history-entry-actions">
        <button class="flat-btn restore-btn" data-id="${v.id}">Restore</button>
        <button class="flat-btn delete-btn" data-id="${v.id}">Delete</button>
      </div>
    </div>
  `).join('');

  el.historyList.querySelectorAll('.restore-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const entry = loadVersion(btn.dataset.id);
      if (entry) {
        el.latexInputTextarea.value = entry.originalLatex;
        el.jdInputTextarea.value = entry.jobDescription;
        closeHistory();
        alert(`Restored session from ${formatTimestamp(entry.timestamp)}. Click "Run Pipeline" to re-process.`);
      }
    });
  });

  el.historyList.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      deleteVersion(btn.dataset.id);
      renderHistoryList();
    });
  });
}

// ---------------------------------------------------------------------------
// Pipeline Status Tracker
// ---------------------------------------------------------------------------
const PIPELINE_STAGES = [
  { id: 'stage-parse', label: 'Parsing LaTeX' },
  { id: 'stage-jd', label: 'Analyzing JD' },
  { id: 'stage-ats-pre', label: 'Pre-scoring ATS' },
  { id: 'stage-generate', label: 'Generating Variants' },
  { id: 'stage-rank', label: 'Ranking Candidates' },
  { id: 'stage-reconstruct', label: 'Reconstructing LaTeX' },
  { id: 'stage-validate', label: 'Validating & Repairing' },
];

function renderPipelineTracker() {
  if (!el.pipelineTracker) return;
  el.pipelineTracker.innerHTML = PIPELINE_STAGES.map(s =>
    `<div class="pipeline-stage" id="${s.id}">
       <span class="stage-icon">○</span>
       <span class="stage-label">${s.label}</span>
     </div>`
  ).join('');
  el.pipelineTracker.classList.remove('hidden');
}

function setStageStatus(stageId, status) {
  const stage = $(stageId);
  if (!stage) return;
  const icon = stage.querySelector('.stage-icon');
  stage.className = `pipeline-stage stage-${status}`;
  if (icon) icon.textContent = status === 'done' ? '✓' : status === 'running' ? '⟳' : status === 'error' ? '✕' : '○';
}

// ---------------------------------------------------------------------------
// UI Status
// ---------------------------------------------------------------------------
function updateStatusBadge(stateName, customMsg = '') {
  el.statusIndicator.className = 'status-indicator-badge';
  const stateMap = {
    ready: ['state-ready', 'Ready'],
    processing: ['state-processing', 'Processing...'],
    validating: ['state-validating', 'Validating...'],
    success: ['state-success', 'Optimized!'],
    error: ['state-error', 'Error'],
  };
  const [cls, defaultMsg] = stateMap[stateName] || ['state-ready', 'Ready'];
  el.statusIndicator.classList.add(cls);
  el.statusText.textContent = customMsg || defaultMsg;
}

function setProcessingState(processing) {
  state.isProcessing = processing;
  el.tailorBtn.disabled = processing;
  el.tailorBtnText.textContent = processing ? 'Running Pipeline...' : 'Run Pipeline';
  el.tailorBtnSpinner.classList.toggle('hidden', !processing);
}

// ---------------------------------------------------------------------------
// Main Pipeline
// ---------------------------------------------------------------------------
async function handleTailorAction() {
  const originalLatex = el.latexInputTextarea.value.trim();
  const jobDescription = el.jdInputTextarea.value.trim();

  if (!state.apiKey) {
    alert('Please set your Gemini API Key in the settings panel.');
    openSettings();
    return;
  }
  if (!originalLatex) { alert('Please enter or upload your LaTeX resume.'); return; }
  if (!jobDescription) {
    alert('Please paste the target Job Description.');
    $q('[data-tab="jd-tab"]')?.click();
    return;
  }

  setProcessingState(true);
  updateStatusBadge('processing');
  renderPipelineTracker();
  resetOutputPanels();

  try {
    // === Stage 1: Parse LaTeX ===
    setStageStatus('stage-parse', 'running');
    const ast = parseLatex(originalLatex);
    state.originalAst = ast;
    setStageStatus('stage-parse', 'done');

    // === Stage 2: Analyze JD ===
    setStageStatus('stage-jd', 'running');
    const jdAnalysis = await analyzeJobDescription(state.apiKey, state.model, jobDescription);
    state.jdAnalysis = jdAnalysis;
    setStageStatus('stage-jd', 'done');

    // === Stage 3: ATS Pre-score ===
    setStageStatus('stage-ats-pre', 'running');
    const resumePlainText = latexToPlainText(originalLatex);
    state.atsReportBefore = computeATSScore(resumePlainText, jdAnalysis);
    setStageStatus('stage-ats-pre', 'done');

    // Compute semantic similarity (embeddings)
    let similarity = null;
    try {
      const [resumeEmbed, jdEmbed] = await Promise.all([
        computeEmbedding(state.apiKey, resumePlainText.substring(0, 3000)),
        computeEmbedding(state.apiKey, jobDescription.substring(0, 3000)),
      ]);
      similarity = cosineSimilarity(resumeEmbed, jdEmbed);
      state.semanticSimilarity = similarity;
    } catch {
      // Embedding failure is non-fatal
    }

    // === Stage 4: Multi-Generation ===
    setStageStatus('stage-generate', 'running');
    const lockedSectionIds = getLockedSectionIds(ast);
    const generationMode = el.generationModeSelect?.value || 'single';
    const singleMode = el.tailorModeSelect?.value || 'moderate';

    let candidates = [];

    if (generationMode === 'multi') {
      const modes = ['conservative', 'moderate', 'aggressive'];
      const results = await Promise.allSettled(
        modes.map(mode => tailorResumeAST(state.apiKey, state.model, ast, jdAnalysis, { mode }, lockedSectionIds))
      );
      results.forEach((result, i) => {
        if (result.status === 'fulfilled' && result.value?.sections) {
          const modMap = buildModificationMap(result.value.sections);
          const reconstructed = reconstructLatex(ast, modMap, lockedSectionIds);
          candidates.push({ mode: modes[i], latex: reconstructed, changes: result.value.changes || [] });
        }
      });
      if (candidates.length === 0) throw new Error('All generation variants failed.');
    } else {
      const result = await tailorResumeAST(state.apiKey, state.model, ast, jdAnalysis, { mode: singleMode }, lockedSectionIds);
      if (result?.sections) {
        const modMap = buildModificationMap(result.sections);
        const reconstructed = reconstructLatex(ast, modMap, lockedSectionIds);
        candidates.push({ mode: singleMode, latex: reconstructed, changes: result.changes || [] });
      } else {
        throw new Error('AI returned invalid section data.');
      }
    }
    state.candidates = candidates;
    setStageStatus('stage-generate', 'done');

    // === Stage 5: Rank Candidates ===
    setStageStatus('stage-rank', 'running');
    const ranked = rankCandidates(originalLatex, candidates, jdAnalysis);
    state.rankedCandidates = ranked;
    const best = pickBest(ranked);
    setStageStatus('stage-rank', 'done');

    // === Stage 6: Reconstruct best ===
    setStageStatus('stage-reconstruct', 'running');
    let tailoredLatex = best.latex;
    state.changesLog = candidates.find(c => c.mode === best.mode)?.changes || [];
    setStageStatus('stage-reconstruct', 'done');

    // === Stage 7: Validate → Repair Loop ===
    setStageStatus('stage-validate', 'running');
    updateStatusBadge('validating');

    let validationResult = validateLatexDeterministic(tailoredLatex);
    let repairAttempts = 0;
    const MAX_REPAIRS = 2;

    while (!validationResult.valid && repairAttempts < MAX_REPAIRS) {
      repairAttempts++;
      const errorStr = formatErrorsForRepair(validationResult.errors);
      const repairResult = await repairLatex(state.apiKey, state.model, tailoredLatex, errorStr);
      tailoredLatex = repairResult.fixedLatex || tailoredLatex;
      validationResult = validateLatexDeterministic(tailoredLatex);
    }

    state.tailoredLatex = tailoredLatex;
    state.validationReport = {
      ...validationResult,
      repairAttempts,
    };
    setStageStatus('stage-validate', validationResult.valid ? 'done' : 'error');

    // === ATS Post-score ===
    state.atsReportAfter = computeATSScore(latexToPlainText(tailoredLatex), jdAnalysis);

    // === Save Version ===
    const savedVersion = saveVersion({
      jobTitle: jdAnalysis.role_title || 'Untitled Role',
      originalLatex,
      jobDescription,
      tailoredLatex,
      mode: best.mode,
      atsScoreBefore: state.atsReportBefore.score,
      atsScoreAfter: state.atsReportAfter.score,
      scoreDelta: state.atsReportAfter.score - state.atsReportBefore.score,
      changesCount: state.changesLog.length,
    });
    state.currentSessionId = savedVersion.id;
    state.feedbackSubmitted = false;

    // === Render all output panels ===
    renderResults(originalLatex);
    updateStatusBadge('success', `ATS: ${state.atsReportBefore.score}% → ${state.atsReportAfter.score}%`);

  } catch (error) {
    console.error('Pipeline failed:', error);
    PIPELINE_STAGES.forEach(s => {
      const el2 = $(s.id);
      if (el2?.classList.contains('stage-running')) setStageStatus(s.id, 'error');
    });
    updateStatusBadge('error', 'Pipeline Failed');
    alert(`Pipeline error: ${error.message}\n\nCheck your API key and network connection.`);
  } finally {
    setProcessingState(false);
  }
}

// ---------------------------------------------------------------------------
// Render Results
// ---------------------------------------------------------------------------
function resetOutputPanels() {
  if (el.diffView) el.diffView.innerHTML = '<div class="placeholder-msg"><p>Processing...</p></div>';
  if (el.atsPanel) el.atsPanel.innerHTML = '';
  if (el.confidencePanel) el.confidencePanel.innerHTML = '';
  if (el.candidatesPanel) el.candidatesPanel.innerHTML = '';
  if (el.logView) el.logView.innerHTML = '';
}

function renderResults(originalLatex) {
  // 1. Semantic diff
  try {
    const sectionDiffs = computeSemanticDiff(originalLatex, state.tailoredLatex);
    el.diffView.innerHTML = renderSemanticDiffHtml(sectionDiffs);
    el.diffView.className = 'diff-container';
  } catch (e) {
    el.diffView.innerHTML = `<div class="placeholder-msg"><p>Diff rendering error: ${escapeHtml(e.message)}</p></div>`;
  }

  // 2. LaTeX output
  el.latexOutputTextarea.value = state.tailoredLatex;
  el.downloadBtn.disabled = false;

  // 3. Validation badge
  renderValidationBadge();

  // 4. ATS panel
  renderATSPanel();

  // 5. Confidence + explainability report
  renderConfidencePanel();

  // 6. Candidate ranking (multi-gen mode)
  renderCandidatesPanel();

  // 7. Explanation log
  renderExplanationLog();

  // 8. Feedback widget
  showFeedbackWidget();

  // Auto-switch to diff tab
  $q('[data-tab="diff-tab"]')?.click();
}

function renderValidationBadge() {
  const report = state.validationReport;
  if (!report) return;
  el.validationBadgeBullet.className = 'status-bullet';
  if (report.valid) {
    el.validationBadgeBullet.classList.add('verified');
    el.validationBadgeText.textContent = report.repairAttempts > 0
      ? `Repaired (${report.repairAttempts} pass${report.repairAttempts > 1 ? 'es' : ''})`
      : 'Perfect LaTeX Syntax';
  } else {
    el.validationBadgeBullet.classList.add('failed');
    el.validationBadgeText.textContent = `${report.errors?.length || 0} issue(s) remain`;
  }
}

function renderATSPanel() {
  if (!el.atsPanel || !state.atsReportBefore || !state.atsReportAfter) return;

  const before = state.atsReportBefore;
  const after = state.atsReportAfter;
  const delta = after.score - before.score;
  const jd = state.jdAnalysis;

  const simPct = state.semanticSimilarity !== null
    ? Math.round(state.semanticSimilarity * 100)
    : null;

  el.atsPanel.innerHTML = `
    <div class="ats-score-section">
      <div class="ats-gauge-row">
        <div class="ats-gauge-wrapper">
          <svg class="ats-gauge" viewBox="0 0 120 120" width="120" height="120">
            <circle cx="60" cy="60" r="50" fill="none" stroke="var(--border-subtle)" stroke-width="10"/>
            <circle cx="60" cy="60" r="50" fill="none" stroke="${scoreColor(before.score)}" stroke-width="10"
              stroke-dasharray="${(before.score / 100) * 314.16} 314.16"
              stroke-dashoffset="78.54" stroke-linecap="round" opacity="0.3"/>
            <circle cx="60" cy="60" r="50" fill="none" stroke="${scoreColor(after.score)}" stroke-width="10"
              stroke-dasharray="${(after.score / 100) * 314.16} 314.16"
              stroke-dashoffset="78.54" stroke-linecap="round"/>
            <text x="60" y="55" text-anchor="middle" fill="var(--text-primary)" font-size="22" font-weight="700">${after.score}</text>
            <text x="60" y="72" text-anchor="middle" fill="var(--text-muted)" font-size="10">ATS Score</text>
          </svg>
          <div class="ats-delta ${delta >= 0 ? 'positive' : 'negative'}">${delta >= 0 ? '+' : ''}${delta} pts</div>
        </div>

        <div class="ats-breakdown">
          ${renderCoverageBar('Required Skills', after.requiredCoverage, after.foundRequired.length, (jd?.required_skills || []).length)}
          ${renderCoverageBar('ATS Keywords', after.atsCoverage, after.foundAtsKeywords.length, (jd?.ats_keywords || []).length)}
          ${renderCoverageBar('Preferred Skills', after.preferredCoverage, after.foundPreferred.length, (jd?.preferred_skills || []).length)}
          ${renderCoverageBar('Soft Skills', after.softCoverage, after.foundSoft.length, (jd?.soft_skills || []).length)}
          ${simPct !== null ? `<div class="coverage-bar-row">
            <span class="cov-label">Semantic Similarity</span>
            <div class="cov-bar-track"><div class="cov-bar-fill" style="width:${simPct}%;background:var(--accent-purple)"></div></div>
            <span class="cov-pct">${simPct}%</span>
          </div>` : ''}
        </div>
      </div>

      ${after.missingRequired.length > 0 ? `
        <div class="ats-keywords-section">
          <div class="kw-section-title">⚠ Missing Required Skills</div>
          <div class="kw-chips missing">
            ${after.missingRequired.map(k => `<span class="kw-chip missing">${escapeHtml(k)}</span>`).join('')}
          </div>
        </div>` : ''}

      ${after.foundRequired.length > 0 ? `
        <div class="ats-keywords-section">
          <div class="kw-section-title">✓ Matched Required Skills</div>
          <div class="kw-chips found">
            ${after.foundRequired.map(k => `<span class="kw-chip found">${escapeHtml(k)}</span>`).join('')}
          </div>
        </div>` : ''}

      ${after.skillGaps.length > 0 ? `
        <div class="ats-keywords-section">
          <div class="kw-section-title">🎯 Top Skill Gaps to Address</div>
          <div class="kw-chips gap">
            ${after.skillGaps.map((k, i) => `<span class="kw-chip gap">#${i+1} ${escapeHtml(k)}</span>`).join('')}
          </div>
        </div>` : ''}
    </div>
  `;
}

function renderCoverageBar(label, pct, found, total) {
  const color = pct >= 80 ? 'var(--accent-cyan)' : pct >= 60 ? 'var(--accent-yellow)' : 'var(--accent-red)';
  return `
    <div class="coverage-bar-row">
      <span class="cov-label">${label}</span>
      <div class="cov-bar-track">
        <div class="cov-bar-fill" style="width:${pct}%;background:${color}"></div>
      </div>
      <span class="cov-pct">${found}/${total} (${pct}%)</span>
    </div>
  `;
}

function scoreColor(score) {
  if (score >= 80) return 'var(--accent-cyan)';
  if (score >= 60) return 'var(--accent-yellow)';
  return 'var(--accent-red)';
}

function renderConfidencePanel() {
  if (!el.confidencePanel || !state.atsReportAfter || !state.jdAnalysis) return;

  const after = state.atsReportAfter;
  const jd = state.jdAnalysis;
  const changes = state.changesLog;

  const skillMatchConf = Math.round((after.foundRequired.length / Math.max(1, (jd.required_skills || []).length)) * 100);
  const atsCovConf = after.atsCoverage;
  const overallConf = Math.round((skillMatchConf * 0.5 + atsCovConf * 0.5));

  const recommendations = [];
  if (after.missingRequired.length > 0) {
    recommendations.push(`Add these required skills: ${after.missingRequired.slice(0, 3).join(', ')}`);
  }
  if (after.missingAtsKeywords.length > 0) {
    recommendations.push(`Include ATS keywords: ${after.missingAtsKeywords.slice(0, 3).join(', ')}`);
  }
  if (changes.length < 3) {
    recommendations.push('Consider more aggressive tailoring depth for better alignment');
  }
  if (jd.experience_level) {
    recommendations.push(`Role targets ${jd.experience_level}-level candidates — ensure experience section reflects this`);
  }
  if (after.industryTerms.length > 0) {
    recommendations.push(`Industry terms matched: ${after.industryTerms.slice(0, 3).join(', ')}`);
  }

  el.confidencePanel.innerHTML = `
    <div class="confidence-header">
      <div class="conf-score-ring">
        <svg viewBox="0 0 80 80" width="80" height="80">
          <circle cx="40" cy="40" r="30" fill="none" stroke="var(--border-subtle)" stroke-width="8"/>
          <circle cx="40" cy="40" r="30" fill="none" stroke="${scoreColor(overallConf)}" stroke-width="8"
            stroke-dasharray="${(overallConf / 100) * 188.5} 188.5"
            stroke-dashoffset="47.1" stroke-linecap="round"/>
          <text x="40" y="45" text-anchor="middle" fill="var(--text-primary)" font-size="16" font-weight="700">${overallConf}%</text>
        </svg>
        <span class="conf-label">Match Confidence</span>
      </div>
      <div class="conf-metrics">
        <div class="conf-metric">
          <span class="conf-metric-label">Skill Match</span>
          <span class="conf-metric-value" style="color:${scoreColor(skillMatchConf)}">${skillMatchConf}%</span>
        </div>
        <div class="conf-metric">
          <span class="conf-metric-label">ATS Coverage</span>
          <span class="conf-metric-value" style="color:${scoreColor(atsCovConf)}">${atsCovConf}%</span>
        </div>
        <div class="conf-metric">
          <span class="conf-metric-label">Changes Made</span>
          <span class="conf-metric-value">${changes.length}</span>
        </div>
        <div class="conf-metric">
          <span class="conf-metric-label">Experience Level</span>
          <span class="conf-metric-value">${escapeHtml(jd.experience_level || 'N/A')}</span>
        </div>
      </div>
    </div>

    ${recommendations.length > 0 ? `
    <div class="conf-recommendations">
      <div class="conf-rec-title">💡 Recommended Improvements</div>
      <ul class="conf-rec-list">
        ${recommendations.map(r => `<li>${escapeHtml(r)}</li>`).join('')}
      </ul>
    </div>` : `<div class="conf-recommendations"><p class="conf-excellent">✨ Excellent alignment — all critical requirements addressed.</p></div>`}

    <div class="conf-jd-summary">
      <div class="conf-rec-title">Job Intelligence</div>
      <div class="jd-intel-grid">
        <div class="jd-intel-item"><span class="jd-intel-key">Role</span><span class="jd-intel-val">${escapeHtml(jd.role_title || 'N/A')}</span></div>
        <div class="jd-intel-item"><span class="jd-intel-key">Level</span><span class="jd-intel-val">${escapeHtml(jd.experience_level || 'N/A')}</span></div>
        <div class="jd-intel-item"><span class="jd-intel-key">Company</span><span class="jd-intel-val">${escapeHtml(jd.company_context || 'N/A')}</span></div>
        <div class="jd-intel-item"><span class="jd-intel-key">Industry Terms</span><span class="jd-intel-val">${(jd.industry_terms || []).slice(0,4).map(t => escapeHtml(t)).join(', ') || 'N/A'}</span></div>
      </div>
    </div>
  `;
}

function renderCandidatesPanel() {
  if (!el.candidatesPanel) return;
  const ranked = state.rankedCandidates;
  if (!ranked || ranked.length <= 1) {
    el.candidatesPanel.innerHTML = '<div class="placeholder-msg"><p>Multi-Generation mode not used. Switch to "Multi-Gen (All 3)" in generation settings to compare Conservative / Moderate / Aggressive variants.</p></div>';
    return;
  }

  el.candidatesPanel.innerHTML = `
    <div class="candidates-header">
      <span class="candidates-title">Multi-Generation Rankings</span>
      <span class="candidates-subtitle">Candidates ranked by composite ATS + preservation score</span>
    </div>
    <div class="candidates-grid">
      ${ranked.map((c, i) => `
        <div class="candidate-card ${i === 0 ? 'candidate-best' : ''}">
          <div class="candidate-rank">#${i + 1}</div>
          <div class="candidate-mode-badge candidate-mode-${c.mode}">${c.mode}</div>
          <div class="candidate-scores">
            <div class="cand-score-row"><span>Total Score</span><span class="cand-score-val">${c.totalScore}</span></div>
            <div class="cand-score-row"><span>ATS Score</span><span class="cand-score-val">${c.atsScore}%</span></div>
            <div class="cand-score-row"><span>Preservation</span><span class="cand-score-val">${c.preservationScore}%</span></div>
            <div class="cand-score-row"><span>Changes</span><span class="cand-score-val">${c.changeCount} bullets</span></div>
          </div>
          <ul class="candidate-recs">
            ${c.recommendations.map(r => `<li>${escapeHtml(r)}</li>`).join('')}
          </ul>
          <button class="secondary-btn btn-sm use-candidate-btn" data-mode="${c.mode}">
            ${i === 0 ? '✓ Currently Applied' : 'Apply This Version'}
          </button>
        </div>
      `).join('')}
    </div>
  `;

  // Wire up candidate selection buttons
  el.candidatesPanel.querySelectorAll('.use-candidate-btn').forEach(btn => {
    if (btn.textContent.trim() === '✓ Currently Applied') return;
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      const candidate = state.candidates.find(c => c.mode === mode);
      if (candidate) {
        state.tailoredLatex = candidate.latex;
        el.latexOutputTextarea.value = candidate.latex;
        renderResults(el.latexInputTextarea.value.trim());
        // Re-rank with new selection at top
        const reranked = [...state.rankedCandidates].sort((a, b) => {
          if (a.mode === mode) return -1;
          if (b.mode === mode) return 1;
          return b.totalScore - a.totalScore;
        });
        state.rankedCandidates = reranked;
        renderCandidatesPanel();
      }
    });
  });
}

function renderExplanationLog() {
  if (!el.logView) return;
  const changes = state.changesLog;
  const valReport = state.validationReport;

  let html = '';

  // Validation summary
  if (valReport) {
    const repairNote = valReport.repairAttempts > 0
      ? ` — ${valReport.repairAttempts} repair pass(es) applied`
      : '';
    html += `<div class="log-item log-item-validation">
      <div class="log-item-header">
        <span class="log-item-title">LaTeX Validation${repairNote}</span>
        <span class="log-item-type ${valReport.valid ? 'log-type-syntax' : 'log-type-error'}">${valReport.valid ? 'Passed' : 'Issues Remain'}</span>
      </div>
      <p class="log-item-desc">${escapeHtml(valReport.summary)}</p>
    </div>`;
  }

  if (changes.length > 0) {
    const typeClasses = { skill: 'log-type-skill', metric: 'log-type-metric', keyword: 'log-type-keyword', restructure: 'log-type-restructure', syntax: 'log-type-syntax' };
    const typeLabels = { skill: 'Skill Alignment', metric: 'Impact Metric', keyword: 'ATS Keyword', restructure: 'Restructured', syntax: 'Syntax Fix' };

    changes.forEach(change => {
      const tc = typeClasses[change.type] || 'log-type-skill';
      const tl = typeLabels[change.type] || 'Adjustment';
      html += `
        <div class="log-item">
          <div class="log-item-header">
            <span class="log-item-title">${escapeHtml(change.title)}</span>
            <span class="log-item-type ${tc}">${tl}</span>
          </div>
          <p class="log-item-desc">${escapeHtml(change.description)}</p>
          ${change.oldText && change.newText ? `
            <div class="log-diff-preview">
              <div class="log-diff-old">− ${escapeHtml(change.oldText)}</div>
              <div class="log-diff-new">+ ${escapeHtml(change.newText)}</div>
            </div>` : ''}
        </div>`;
    });
  }

  if (!html) {
    html = '<div class="placeholder-msg"><p>No changes logged for this optimization.</p></div>';
  }

  el.logView.className = 'log-container';
  el.logView.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------
let _thumbRating = null;
let _starRating = 0;

function showFeedbackWidget() {
  if (!el.feedbackWidget) return;
  el.feedbackWidget.classList.remove('hidden');
  _thumbRating = null;
  _starRating = 0;
  if (el.correctionInput) el.correctionInput.value = '';
  el.thumbUp?.classList.remove('active');
  el.thumbDown?.classList.remove('active');
  highlightStars(0);
  if (el.submitFeedbackBtn) el.submitFeedbackBtn.disabled = false;
  if (el.feedbackWidget.querySelector('.feedback-success')) {
    el.feedbackWidget.querySelector('.feedback-success').remove();
  }
}

function setThumb(direction) {
  _thumbRating = direction;
  el.thumbUp?.classList.toggle('active', direction === 'up');
  el.thumbDown?.classList.toggle('active', direction === 'down');
}

function setStarRating(val) {
  _starRating = val;
  state._starRating = val;
  highlightStars(val);
}

function highlightStars(upTo) {
  el.starBtns?.forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.star) <= upTo);
  });
}

function handleFeedbackSubmit() {
  if (!state.currentSessionId) return;

  submitFeedback(
    state.currentSessionId,
    {
      resume: el.latexInputTextarea.value,
      jobDescription: el.jdInputTextarea.value,
      generatedOutput: state.tailoredLatex,
      mode: state.selectedCandidateMode || 'moderate',
      atsScoreBefore: state.atsReportBefore?.score || 0,
      atsScoreAfter: state.atsReportAfter?.score || 0,
    },
    {
      thumbRating: _thumbRating,
      starRating: _starRating || null,
      userCorrection: el.correctionInput?.value?.trim() || '',
    }
  );

  if (el.submitFeedbackBtn) el.submitFeedbackBtn.disabled = true;
  state.feedbackSubmitted = true;

  const successMsg = document.createElement('p');
  successMsg.className = 'feedback-success';
  successMsg.textContent = '✓ Feedback saved! Thank you.';
  el.feedbackWidget?.appendChild(successMsg);

  updateFeedbackCount();
}

function updateFeedbackCount() {
  const count = getFeedbackCount();
  if (el.feedbackCount) el.feedbackCount.textContent = `${count} record${count !== 1 ? 's' : ''} stored`;
}

// ---------------------------------------------------------------------------
// Dataset Export
// ---------------------------------------------------------------------------
function exportDataset() {
  const blob = exportDatasetBlob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `curricula_dataset_${Date.now()}.jsonl`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Copy / Download
// ---------------------------------------------------------------------------
function copyToClipboard() {
  if (!state.tailoredLatex) return;
  navigator.clipboard.writeText(state.tailoredLatex).then(() => {
    const orig = el.copyBtn.querySelector('span:last-child')?.textContent;
    const span = el.copyBtn.querySelector('span:last-child');
    if (span) span.textContent = 'Copied!';
    el.copyBtn.style.borderColor = 'var(--accent-cyan)';
    setTimeout(() => {
      if (span) span.textContent = orig;
      el.copyBtn.removeAttribute('style');
    }, 2000);
  }).catch(() => alert('Copy failed. Please select the text manually.'));
}

function downloadTexFile() {
  if (!state.tailoredLatex) return;
  const blob = new Blob([state.tailoredLatex], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'tailored_resume.tex';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Start app
// ---------------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', init);
