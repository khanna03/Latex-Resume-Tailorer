# ==============================================================================
# LaTeX Resume Tailorer — Tailoring Engine Router
# ==============================================================================
# This router coordinates the core AI-based resume optimization pipeline.
# It exposes routes to analyze JDs, score resumes against JD intelligence,
# generate tailored candidate variations via Gemini, rank results, run the
# compile error repair loop, and save version histories in PostgreSQL.
# ==============================================================================

import json
import re
from typing import List, Dict, Any, Set
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
import google.generativeai as genai

from backend.database import get_db
from backend.models import Resume, Version, AuditLog
from backend.schemas import JDInput, JDAnalysisOut, TailorRequest, TailorResponse, UserOut, VersionOut
from backend.auth import get_current_user
from backend.config import settings
from backend.routes.parser import latex_to_plain_text
from backend.pipeline_helpers import (
    reconstruct_latex,
    validate_locked_sections,
    check_fabrication,
    validate_latex_deterministic,
    format_errors_for_repair,
    compute_ats_score,
    rank_candidates
)

router = APIRouter(prefix="/tailor", tags=["Tailoring Pipeline"])

# --------------------------------------------------------------------------
# Gemini Tailoring API Callers
# --------------------------------------------------------------------------

def generate_tailoring_candidate(
    api_key: str,
    model_name: str,
    ast: Dict[str, Any],
    jd: Dict[str, Any],
    mode: str,
    custom_instructions: str,
    locked_section_ids: Set = None
) -> Dict[str, Any]:
    """
    Prompts Gemini to suggest plain-text bullet point edits for editable sections.
    Operates strictly on JSON (AST) input and output schemas.
    """
    if locked_section_ids is None:
        locked_section_ids = set()

    genai.configure(api_key=api_key)

    # Style guidance per mode matching ats-engine.js assumptions
    mode_instructions = {
        "conservative": (
            "Make MINIMAL changes. Only add missing critical ATS keywords by "
            "rephrasing existing bullets. Preserve 90%+ of original wording. "
            "Do NOT restructure sentences."
        ),
        "moderate": (
            "Refine bullet points to incorporate required skills and ATS keywords. "
            "Rephrase for impact. Add quantifiable metrics where logical. "
            "Preserve document structure."
        ),
        "aggressive": (
            "Substantially rewrite bullets to maximally align with the job requirements. "
            "Restructure experience statements for maximum ATS score. "
            "Emphasize impact and results. Add technical depth."
        ),
    }

    # Extract only editable sections for the prompt (minimizes LLM context size)
    editable_sections = []
    for section in ast.get("sections", []):
        if section["id"] not in locked_section_ids and not section.get("locked"):
            editable_sections.append({
                "id": section["id"],
                "title": section["title"],
                "bullets": [b["text"] for b in section.get("bullets", [])]
            })

    prompt = f"""You are an expert resume optimization specialist and ATS engineer.
Your task is to tailor resume bullet points to maximize ATS score for the target job.

=== TARGET JOB ANALYSIS ===
Role: {jd.get('role_title', 'Not specified')}
Level: {jd.get('experience_level', 'Not specified')}
Required Skills: {', '.join(jd.get('required_skills', []))}
Preferred Skills: {', '.join(jd.get('preferred_skills', []))}
Critical ATS Keywords: {', '.join(jd.get('ats_keywords', []))}
Industry Terms: {', '.join(jd.get('industry_terms', []))}

=== TAILORING MODE ===
{mode_instructions.get(mode, mode_instructions['moderate'])}

{f"=== CUSTOM INSTRUCTIONS ===\n{custom_instructions}" if custom_instructions else ""}

=== RESUME SECTIONS (plain text, structured) ===
{json.dumps(editable_sections, indent=2)}

=== INSTRUCTIONS ===
For each section, return updated bullet text. Rules:
1. NEVER fabricate companies, degrees, certifications, dates, or years of experience.
2. You MAY rephrase experience to emphasize relevant skills that the candidate demonstrably has.
3. Incorporate ATS keywords naturally — do NOT keyword-stuff.
4. Maintain professional, first-person implied tone (no "I" statements).
5. Bullets should be concise (under 25 words ideal).
6. If a bullet is already well-aligned, return it unchanged.
7. Return plain text only — NO LaTeX commands in your output.

Respond ONLY with this JSON schema:
{{
  "sections": [
    {{
      "id": "section_id_matching_input",
      "bullets": ["Updated bullet 1", "Updated bullet 2", ...]
    }}
  ],
  "changes": [
    {{
      "title": "Section title - what changed",
      "type": "skill|metric|keyword|restructure",
      "description": "Why this change improves ATS alignment",
      "oldText": "Original bullet text",
      "newText": "New bullet text"
    }}
  ]
}}"""

    model = genai.GenerativeModel(model_name)
    
    # Request structured JSON format
    response = model.generate_content(
        prompt,
        generation_config={"response_mime_type": "application/json"}
    )
    
    try:
        return json.loads(response.text.strip())
    except Exception:
        # Regex fallback to extract JSON braces if markdown logs contaminate string
        match = re.search(r"\{[\s\S]*\}", response.text)
        if match:
            return json.loads(match.group(0))
        raise ValueError("Gemini returned invalid JSON structure: " + response.text[:200])

def repair_latex_via_gemini(api_key: str, model_name: str, latex: str, formatted_errors: str) -> str:
    """Invokes Gemini in JSON mode to correct specific syntax compiler errors."""
    genai.configure(api_key=api_key)
    
    prompt = f"""You are a LaTeX compilation expert. Fix the following specific errors in the LaTeX document.

Errors to fix:
{formatted_errors}

LaTeX document:
---
{latex}
---

REPAIR RULES:
1. Only fix the specific errors listed above.
2. Do NOT change any content, wording, or structure beyond what is needed to fix the errors.
3. For unescaped '&' in text: replace with '\\&'.
4. For unescaped '%' in text: replace with '\\%'.
5. For unbalanced braces: add the missing '{{' or '}}'.
6. For unclosed environments: add the missing \\end{{envname}}.
7. Remove any markdown backticks or triple-backtick blocks.
8. Do NOT add explanations or comments inside the LaTeX.

Respond with JSON:
{{
  "fixedLatex": "The complete corrected LaTeX document",
  "corrections": [
    {{ "errorFound": "Description of error", "fix": "What was done to fix it" }}
  ]
}}"""

    model = genai.GenerativeModel(model_name)
    response = model.generate_content(
        prompt,
        generation_config={"response_mime_type": "application/json"}
    )
    
    try:
        data = json.loads(response.text.strip())
        return data.get("fixedLatex", latex)
    except Exception:
        match = re.search(r"\{[\s\S]*\}", response.text)
        if match:
            try:
                data = json.loads(match.group(0))
                return data.get("fixedLatex", latex)
            except Exception:
                pass
        return latex

# --------------------------------------------------------------------------
# API Endpoints
# --------------------------------------------------------------------------

@router.post("/analyze-jd", response_model=JDAnalysisOut)
def analyze_job_description(payload: JDInput, current_user: UserOut = Depends(get_current_user)):
    """Extracts structured intelligence (skills, keywords) from a job posting."""
    if not settings.GEMINI_API_KEY:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Gemini API Key is not configured on the server."
        )

    genai.configure(api_key=settings.GEMINI_API_KEY)

    prompt = f"""You are an expert recruiter and ATS specialist. Analyze the following Job Description and extract structured intelligence.

Job Description:
---
{payload.jd_text}
---

Extract and return a JSON object with EXACTLY this schema:
{{
  "role_title": "The exact job title",
  "company_context": "Company name and brief context if mentioned",
  "experience_level": "junior|mid|senior|lead|executive",
  "required_skills": ["List of hard skills explicitly required — tech, tools, frameworks, languages"],
  "preferred_skills": ["List of nice-to-have / preferred skills"],
  "soft_skills": ["Communication", "Leadership", etc.],
  "industry_terms": ["Domain-specific terminology, methodologies, standards"],
  "ats_keywords": ["Top 15-20 high-priority ATS keywords a resume MUST contain to pass screening"],
  "responsibilities": ["Key responsibilities listed in the JD"]
}}

Rules:
- required_skills should reflect must-have qualifications only.
- ats_keywords are the most critical terms ATS systems scan for; include variations (e.g. "ML" and "Machine Learning").
- Be specific: "React.js" not just "JavaScript frameworks".
- Return ONLY valid JSON, no markdown, no explanation."""

    try:
        model = genai.GenerativeModel(settings.GEMINI_MODEL)
        response = model.generate_content(
            prompt,
            generation_config={"response_mime_type": "application/json"}
        )
        data = json.loads(response.text.strip())
        
        # Ensure Pydantic schema validation is satisfied with arrays
        for k in ["required_skills", "preferred_skills", "soft_skills", "industry_terms", "ats_keywords", "responsibilities"]:
            if k not in data or not isinstance(data[k], list):
                data[k] = []
        if "role_title" not in data:
            data["role_title"] = "Unknown Role"
        if "company_context" not in data:
            data["company_context"] = ""
        if "experience_level" not in data:
            data["experience_level"] = "mid"

        return data
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Gemini Job Description extraction failed: {str(e)}"
        )

@router.post("/run", response_model=TailorResponse)
def run_tailoring_pipeline(
    payload: TailorRequest,
    current_user: UserOut = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Executes the full LaTeX Resume Tailoring pipeline on the server:
    1. Fetches user's resume and verifies authorization ownership.
    2. Computes pre-scoring using hybrid keyword + pgvector semantic matching.
    3. Runs single-mode or multi-generation variants in parallel via Gemini.
    4. For each variant:
       - Splicing tailored bullets (offset-based).
       - Enforces locked section reverts (validateLockedSections).
       - Runs post-generation fabrication NER checking.
    5. Ranks all candidates and selects the highest scoring variant.
    6. Triggers validation & Gemini repair loops on the selected best candidate.
    7. Saves the tailored document as a Version in PostgreSQL.
    """
    if not settings.GEMINI_API_KEY:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Gemini API Key is not configured on the server."
        )

    # 1. Fetch resume and verify ownership
    resume = db.query(Resume).filter(Resume.id == payload.resume_id, Resume.user_id == current_user.id).first()
    if not resume:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Resume not found or access denied."
        )

    ast = resume.parsed_ast
    original_latex = resume.raw_latex

    # 2. Compute ATS pre-scoring (with database semantic lookup fallback)
    pre_score = compute_ats_score(latex_to_plain_text(original_latex), payload.jd_analysis, resume.id, db)

    # Convert locked section ids list to a set
    locked_set = set(payload.locked_section_ids)

    # 3. Candidate Generation Loop
    raw_candidates = []
    # If using Multi-Gen (specified by UI selections), run three styles, otherwise single mode
    # Default is the requested UI configuration
    modes = ["conservative", "moderate", "aggressive"] if payload.config.mode == "multi" else [payload.config.mode]

    for mode in modes:
        try:
            # Query Gemini for plain-text bullet modifications
            gpt_res = generate_tailoring_candidate(
                settings.GEMINI_API_KEY,
                settings.GEMINI_MODEL,
                ast,
                payload.jd_analysis.model_dump(),
                mode,
                payload.config.custom_instructions,
                locked_set
            )
            
            # Splicing modifications back into LaTeX using offset tracker
            mod_map = {sec["id"]: {"bullets": sec["bullets"]} for sec in gpt_res.get("sections", [])}
            reconstructed = reconstruct_latex(ast, mod_map, locked_set)
            
            # Locked sections revert enforcement
            final_reconstructed, reverted = validate_locked_sections(ast, reconstructed, locked_set)
            
            # Fabrication NER pass
            flagged, has_fab, fab_summary = check_fabrication(
                latex_to_plain_text(original_latex),
                latex_to_plain_text(final_reconstructed)
            )
            
            raw_candidates.append({
                "mode": mode,
                "latex": final_reconstructed,
                "changes": gpt_res.get("changes", []),
                "fabricationFlags": flagged,
                "revertedSections": reverted
            })
            
        except Exception as e:
            # Log individual variant failures but continue if at least one candidate passes
            print(f"Warning: candidate generation variant '{mode}' failed: {str(e)}")

    if not raw_candidates:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="AI generation failed for all resume tailoring variants."
        )

    # 4. Rank Candidates and pick the best
    ranked = rank_candidates(original_latex, raw_candidates, payload.jd_analysis)
    best_candidate = ranked[0]
    
    tailored_latex = best_candidate["latex"]

    # 5. Syntax validation & Gemini repair loop
    val_report = validate_latex_deterministic(tailored_latex)
    repair_attempts = 0
    max_repairs = 2

    while not val_report["valid"] and repair_attempts < max_repairs:
        repair_attempts += 1
        error_log = format_errors_for_repair(val_report["errors"])
        tailored_latex = repair_latex_via_gemini(
            settings.GEMINI_API_KEY,
            settings.GEMINI_MODEL,
            tailored_latex,
            error_log
        )
        val_report = validate_latex_deterministic(tailored_latex)

    # Recalculate candidate fields using the repaired LaTeX
    best_candidate["latex"] = tailored_latex
    
    # 6. Compute ATS post-scoring (with database semantic lookup fallback)
    post_score = compute_ats_score(latex_to_plain_text(tailored_latex), payload.jd_analysis, resume.id, db)

    # 7. Save Version History
    db_version = Version(
        resume_id=resume.id,
        job_title=payload.jd_analysis.role_title,
        tailored_latex=tailored_latex,
        ats_score_before=pre_score["score"],
        ats_score_after=post_score["score"],
        mode=best_candidate["mode"]
    )
    db.add(db_version)
    db.commit()
    db.refresh(db_version)

    # Write AuditLog
    log_entry = AuditLog(
        user_id=current_user.id,
        action="tailor_resume"
    )
    db.add(log_entry)
    db.commit()

    # Reassemble Pydantic TailorCandidate schemas for response
    candidates_out = []
    for cand in ranked:
        candidates_out.append({
            "mode": cand["mode"],
            "latex": cand["latex"],
            "changes": cand["changes"],
            "fabrication_flags": cand["fabricationFlags"],
            "reverted_sections": cand["revertedSections"]
        })

    return {
        "version_id": db_version.id,
        "best_mode": best_candidate["mode"],
        "ats_score_before": pre_score["score"],
        "ats_score_after": post_score["score"],
        "ats_score_min": post_score["scoreMin"],
        "ats_score_max": post_score["scoreMax"],
        "ats_method_note": post_score["methodNote"],
        "candidates": candidates_out
    }

@router.get("/history", response_model=List[VersionOut])
def get_version_history(
    current_user: UserOut = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Retrieves all tailored versions across all resumes owned by the user."""
    # Join Version and Resume tables to verify user ownership
    return db.query(Version)\
        .join(Resume)\
        .filter(Resume.user_id == current_user.id)\
        .order_by(Version.created_at.desc())\
        .all()

@router.get("/history/{version_id}")
def get_version_detail(
    version_id: int,
    current_user: UserOut = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Retrieves full details (including tailored LaTeX code) for a specific history version."""
    version = db.query(Version)\
        .join(Resume)\
        .filter(Version.id == version_id, Resume.user_id == current_user.id)\
        .first()
        
    if not version:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Version history entry not found."
        )
        
    # Return details along with the associated original resume details
    resume = db.query(Resume).filter(Resume.id == version.resume_id).first()
    return {
        "id": version.id,
        "resume_id": version.resume_id,
        "job_title": version.job_title,
        "tailored_latex": version.tailored_latex,
        "ats_score_before": version.ats_score_before,
        "ats_score_after": version.ats_score_after,
        "mode": version.mode,
        "created_at": version.created_at,
        "original_latex": resume.raw_latex if resume else ""
    }

