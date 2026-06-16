/**
 * Gemini API Service — Hybrid AI + ML Pipeline
 *
 * All AI calls operate on STRUCTURED JSON (AST), never on raw LaTeX directly.
 * Raw LaTeX is handled deterministically by the parser and reconstruction engine.
 */

/**
 * Core Gemini API call.
 * @param {string} apiKey
 * @param {string} model
 * @param {string} prompt
 * @param {boolean} jsonMode
 * @param {number[]} [embeddingInput] - unused here, for clarity
 * @returns {Promise<any>}
 */
async function callGemini(apiKey, model, prompt, jsonMode = false) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const requestBody = {
    contents: [{ parts: [{ text: prompt }] }],
  };

  if (jsonMode) {
    requestBody.generationConfig = { responseMimeType: 'application/json' };
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error?.message || `HTTP ${response.status}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty response from Gemini API.');

  if (jsonMode) {
    try {
      return JSON.parse(text.trim());
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]);
      throw new Error('Gemini returned invalid JSON: ' + text.substring(0, 200));
    }
  }

  return text;
}

// ---------------------------------------------------------------------------
// Stage: PDF → LaTeX Conversion
// ---------------------------------------------------------------------------

/**
 * Convert plain text extracted from a PDF resume into a structured LaTeX document.
 * Called after pdf-parser.js extracts text from an uploaded PDF.
 *
 * @param {string} apiKey
 * @param {string} model
 * @param {string} extractedText - Raw text from PDF
 * @returns {Promise<string>} Full LaTeX document string
 */
export async function pdfToLatex(apiKey, model, extractedText) {
  const prompt = `You are a LaTeX document expert. Convert the following plain-text resume (extracted from a PDF) into a clean, compilable LaTeX document.

Extracted Resume Text:
---
${extractedText}
---

REQUIREMENTS:
1. Use the "article" document class with standard resume margins
2. Use \\usepackage{geometry} for margins: left=0.75in, right=0.75in, top=0.75in, bottom=0.75in
3. Use \\usepackage{enumitem} for bullet points
4. Preserve ALL content exactly — do not add, remove, or infer any information
5. Structure into appropriate LaTeX sections: \\section{} for major sections
6. Use \\begin{itemize} / \\item for bullet points
7. Properly escape ALL special characters: & → \\&, % → \\%, _ → \\_, $ → \\$, # → \\#
8. Include \\begin{document} and \\end{document}
9. Do NOT add any content that wasn't in the original text
10. Return ONLY the raw LaTeX code — no markdown, no backticks, no explanation

Start your response with \\documentclass{article}`;

  // Use plain text mode (not JSON) since we want raw LaTeX back
  return await callGemini(apiKey, model, prompt, false);
}

// ---------------------------------------------------------------------------
// Stage: Job Description Intelligence Engine
// ---------------------------------------------------------------------------


/**
 * Analyze a job description and extract structured intelligence.
 * @param {string} apiKey
 * @param {string} model
 * @param {string} jdText
 * @returns {Promise<import('./jd-engine').JDAnalysis>}
 */
export async function analyzeJobDescription(apiKey, model, jdText) {
  const prompt = `You are an expert recruiter and ATS specialist. Analyze the following Job Description and extract structured intelligence.

Job Description:
---
${jdText}
---

Extract and return a JSON object with EXACTLY this schema:
{
  "role_title": "The exact job title",
  "company_context": "Company name and brief context if mentioned",
  "experience_level": "junior|mid|senior|lead|executive",
  "required_skills": ["List of hard skills explicitly required — tech, tools, frameworks, languages"],
  "preferred_skills": ["List of nice-to-have / preferred skills"],
  "soft_skills": ["Communication", "Leadership", etc.],
  "industry_terms": ["Domain-specific terminology, methodologies, standards"],
  "ats_keywords": ["Top 15-20 high-priority ATS keywords a resume MUST contain to pass screening"],
  "responsibilities": ["Key responsibilities listed in the JD"]
}

Rules:
- required_skills should reflect must-have qualifications only
- ats_keywords are the most critical terms ATS systems scan for; include variations (e.g. "ML" and "Machine Learning")
- Be specific: "React.js" not just "JavaScript frameworks"
- Return ONLY valid JSON, no markdown, no explanation`;

  return await callGemini(apiKey, model, prompt, true);
}

// ---------------------------------------------------------------------------
// Stage: AST-Based Resume Tailoring (AI never sees raw LaTeX)
// ---------------------------------------------------------------------------

/**
 * Tailor a resume based on its AST representation and JD intelligence.
 * The AI works purely on plain-text bullet content extracted from the AST.
 *
 * @param {string} apiKey
 * @param {string} model
 * @param {import('./latex-parser').ResumeAST} resumeAst
 * @param {object} jdAnalysis - Output from analyzeJobDescription
 * @param {object} config - { mode: 'conservative'|'moderate'|'aggressive', customInstructions }
 * @param {Set<string>} lockedSectionIds - Section IDs to skip
 * @returns {Promise<{ sections: Array<{id, bullets}>, changes: Array<{title, type, description, oldText, newText}> }>}
 */
export async function tailorResumeAST(apiKey, model, resumeAst, jdAnalysis, config = {}, lockedSectionIds = new Set()) {
  const { mode = 'moderate', customInstructions = '' } = config;

  const modeInstructions = {
    conservative: 'Make MINIMAL changes. Only add missing critical ATS keywords by rephrasing existing bullets. Preserve 90%+ of original wording. Do NOT restructure sentences.',
    moderate: 'Refine bullet points to incorporate required skills and ATS keywords. Rephrase for impact. Add quantifiable metrics where logical. Preserve document structure.',
    aggressive: 'Substantially rewrite bullets to maximally align with the job requirements. Restructure experience statements for maximum ATS score. Emphasize impact and results. Add technical depth.',
  };

  // Build the section data the AI will work with (plain text only)
  const editableSections = resumeAst.sections
    .filter(s => !lockedSectionIds.has(s.id) && !s.locked)
    .map(s => ({
      id: s.id,
      title: s.title,
      bullets: s.bullets.map(b => b.text),
    }));

  const prompt = `You are an expert resume optimization specialist and ATS engineer.
Your task is to tailor resume bullet points to maximize ATS score for the target job.

=== TARGET JOB ANALYSIS ===
Role: ${jdAnalysis.role_title || 'Not specified'}
Level: ${jdAnalysis.experience_level || 'Not specified'}
Required Skills: ${(jdAnalysis.required_skills || []).join(', ')}
Preferred Skills: ${(jdAnalysis.preferred_skills || []).join(', ')}
Critical ATS Keywords: ${(jdAnalysis.ats_keywords || []).join(', ')}
Industry Terms: ${(jdAnalysis.industry_terms || []).join(', ')}

=== TAILORING MODE ===
${modeInstructions[mode] || modeInstructions.moderate}

${customInstructions ? `=== CUSTOM INSTRUCTIONS ===\n${customInstructions}` : ''}

=== RESUME SECTIONS (plain text, structured) ===
${JSON.stringify(editableSections, null, 2)}

=== INSTRUCTIONS ===
For each section, return updated bullet text. Rules:
1. NEVER fabricate companies, degrees, certifications, dates, or years of experience
2. You MAY rephrase experience to emphasize relevant skills that the candidate demonstrably has
3. Incorporate ATS keywords naturally — do NOT keyword-stuff unnaturally
4. Maintain professional, first-person implied tone (no "I" statements)
5. Bullets should be concise (under 25 words ideal)
6. If a bullet is already well-aligned, return it unchanged
7. Return plain text only — NO LaTeX commands in your output

Respond ONLY with this JSON schema:
{
  "sections": [
    {
      "id": "section_id_matching_input",
      "bullets": ["Updated bullet 1", "Updated bullet 2", ...]
    }
  ],
  "changes": [
    {
      "title": "Section title - what changed",
      "type": "skill|metric|keyword|restructure",
      "description": "Why this change improves ATS alignment",
      "oldText": "Original bullet text",
      "newText": "New bullet text"
    }
  ]
}`;

  return await callGemini(apiKey, model, prompt, true);
}

// ---------------------------------------------------------------------------
// Stage: Targeted LaTeX Repair (AI repair loop)
// ---------------------------------------------------------------------------

/**
 * Ask Gemini to repair specific LaTeX validation errors.
 * Only called when the deterministic validator finds errors.
 *
 * @param {string} apiKey
 * @param {string} model
 * @param {string} latex - The LaTeX with errors
 * @param {string} formattedErrors - Error list from formatErrorsForRepair()
 * @returns {Promise<{ fixedLatex: string, corrections: Array<{errorFound, fix}> }>}
 */
export async function repairLatex(apiKey, model, latex, formattedErrors) {
  const prompt = `You are a LaTeX compilation expert. Fix the following specific errors in the LaTeX document.

Errors to fix:
${formattedErrors}

LaTeX document:
---
${latex}
---

REPAIR RULES:
1. Only fix the specific errors listed above
2. Do NOT change any content, wording, or structure beyond what is needed to fix the errors
3. For unescaped '&' in text: replace with '\\&'
4. For unescaped '%' in text: replace with '\\%'
5. For unbalanced braces: add the missing '{' or '}'
6. For unclosed environments: add the missing \\end{envname}
7. Remove any markdown backticks or triple-backtick blocks
8. Do NOT add explanations or comments inside the LaTeX

Respond with JSON:
{
  "fixedLatex": "The complete corrected LaTeX document",
  "corrections": [
    { "errorFound": "Description of error", "fix": "What was done to fix it" }
  ]
}`;

  return await callGemini(apiKey, model, prompt, true);
}

// Removed semantic embeddings (Phase 1 scope)

// ---------------------------------------------------------------------------
// Legacy exports (kept for backwards compatibility)
// ---------------------------------------------------------------------------

/**
 * @deprecated Use tailorResumeAST + reconstructLatex instead.
 * Kept for fallback in case AST parsing fails.
 */
export async function tailorResume(apiKey, model, latexResume, jobDescription, config = {}) {
  const { depth = '2', focus = 'balanced', customInstructions = '' } = config;

  const depthMap = {
    '1': 'conservative', '2': 'moderate', '3': 'aggressive',
  };

  const prompt = `You are an expert LaTeX CV formatting assistant. Tailor the resume for the job description.

LaTeX Resume:
---
${latexResume}
---

Job Description:
---
${jobDescription}
---

Mode: ${depthMap[depth] || 'moderate'}
Focus: ${focus}
Custom: ${customInstructions || 'None'}

RULES:
1. Preserve ALL LaTeX structure, packages, commands, environments
2. Only modify \\item content, skills, and summary text
3. Escape special chars: & → \\&, % → \\%, _ → \\_, $ → \\$, # → \\#
4. No hallucination of facts
5. No placeholder comments

Return JSON: { "tailoredLatex": "...", "changes": [{ "title": "", "type": "skill|metric|syntax", "description": "", "oldText": "", "newText": "" }] }`;

  return await callGemini(apiKey, model, prompt, true);
}

/**
 * @deprecated Use validateLatexDeterministic + repairLatex instead.
 */
export async function validateLatex(apiKey, model, tailoredLatex) {
  const prompt = `You are a LaTeX compilation expert. Check this LaTeX for errors and fix them.

LaTeX:
---
${tailoredLatex}
---

Check: unescaped &, unbalanced {}, invalid environments, unescaped %, _, $, #, markdown backticks.

Return JSON: { "isValid": true/false, "fixedLatex": "...", "corrections": [{ "errorFound": "...", "fix": "..." }] }`;

  return await callGemini(apiKey, model, prompt, true);
}
