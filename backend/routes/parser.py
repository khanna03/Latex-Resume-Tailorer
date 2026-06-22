# ==============================================================================
# LaTeX Resume Tailorer — Resume Parser Router
# ==============================================================================
# This router implements endpoints to upload, parse, and store resumes.
# It translates '.tex' files natively into a structured AST, and converts '.pdf'
# files into LaTeX format using Gemini's multi-modal capabilities.
# ==============================================================================

import re
from typing import Dict, Any, List
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, status, Header
from sqlalchemy.orm import Session
import google.generativeai as genai

from backend.database import get_db
from backend.models import Resume, AuditLog
from backend.schemas import ResumeDetailOut, UserOut, ResumeOut
from backend.auth import get_current_user
from backend.embeddings import save_resume_bullets
from backend.config import settings

router = APIRouter(prefix="/resumes", tags=["Resume Parser"])

# --------------------------------------------------------------------------
# Deterministic LaTeX → JSON AST Parser (Python Translation of JS Parser)
# --------------------------------------------------------------------------

def latex_to_plain_text(latex: str) -> str:
    """Strips formatting commands to approximate plain text for ATS matching."""
    if not latex:
        return ""
    text = latex
    # Remove text-formatting wraps: \textbf{abc} -> abc
    text = re.sub(r"\\(?:textbf|textit|texttt|emph|underline|textsf|textsc|text|mbox|hbox)\{([^}]*)\}", r"\1", text)
    # Remove links: \href{url}{label} -> label
    text = re.sub(r"\\(?:href|url)\{[^}]*\}\{([^}]*)\}", r"\1", text)
    text = re.sub(r"\\(?:href|url)\{([^}]*)\}", r"\1", text)
    # Remove general macros: \foo{abc} -> abc
    text = re.sub(r"\\[a-zA-Z]+\{([^}]*)\}", r"\1", text)
    # Strip standalone commands: \hfill -> space
    text = re.sub(r"\\[a-zA-Z]+\*", " ", text)
    text = re.sub(r"\\[a-zA-Z]+", " ", text)
    # Clean left-over syntax braces
    text = re.sub(r"[{}]", "", text)
    # Collapse consecutive spaces
    text = re.sub(r"\s+", " ", text)
    return text.strip()

def blank_comments(body: str) -> str:
    """Replaces LaTeX comments with spaces to keep index offsets identical."""
    # Matches unescaped '%' comments up to the end of the line
    return re.sub(r"(?<!\\)%[^\n]*", lambda m: " " * len(m.group(0)), body)

def parse_latex_to_ast(raw_latex: str) -> Dict[str, Any]:
    """
    Parses a raw LaTeX document into a structured AST JSON schema.
    Deterministic: same input always produces identical output.
    """
    if not raw_latex:
        return {
            "preamble": "", "postamble": "", "sections": [],
            "packages": [], "customCommands": [], "rawFull": "", "plainText": ""
        }

    # Split document boundaries
    begin_str, end_str = "\\begin{document}", "\\end{document}"
    begin_idx = raw_latex.find(begin_str)
    end_idx = raw_latex.find(end_str)
    
    has_preamble = begin_idx >= 0
    has_postamble = end_idx >= 0
    
    preamble = raw_latex[0 : begin_idx + len(begin_str)] if has_preamble else ""
    postamble = raw_latex[end_idx:] if has_postamble else ""
    
    body_start = begin_idx + len(begin_str) if has_preamble else 0
    body_end = end_idx if has_postamble else len(raw_latex)
    body = raw_latex[body_start:body_end]
    
    # Extract packages from preamble
    packages = []
    for m in re.finditer(r"\\usepackage(?:\[[^\]]*\])?\{([^}]+)\}", preamble):
        for pkg in m.group(1).split(","):
            packages.append(pkg.strip())
            
    # Extract custom command macros
    custom_commands = []
    for m in re.finditer(r"\\(?:newcommand|renewcommand|providecommand)\{([^}]+)\}", preamble):
        custom_commands.append(m.group(1))
        
    # Find section headings
    blanked = blank_comments(body)
    section_pattern = re.compile(
        r"\\(section|subsection|subsubsection|cvsection|cvsubsection|cventry|cvitem|cvline|datedsubsection|namesection|resumeSection|resumeSubheading|resumeSubItem|roSection|workexp|education|skills?[Ss]ection|project[Ss]ection|ecvsection|ecvtitle|cvevent|cvachievement|cvskill|cvref)(?:\*)?(?:\[([^\]]*)\])?\{([^}]*)\}",
        re.IGNORECASE
    )
    
    matches = []
    for m in section_pattern.finditer(blanked):
        raw_title = body[m.start() : m.end()]
        title_text = latex_to_plain_text(m.group(3) or m.group(2) or "")
        matches.append({
            "type": m.group(1).lower(),
            "raw_title": raw_title,
            "title": title_text,
            "body_offset": m.start()
        })
        
    sections = []
    all_plain_texts = []
    
    for i, match in enumerate(matches):
        content_start = match["body_offset"] + len(match["raw_title"])
        content_end = matches[i + 1]["body_offset"] if i + 1 < len(matches) else len(body)
        
        raw_content = body[content_start:content_end]
        abs_start = body_start + content_start
        abs_end = body_start + content_end
        section_id = f"section_{i}"
        
        # Extract \item bullets
        bullets = []
        item_re = re.compile(r"\\item(?:\[[^\]]*\])?")
        item_starts = [m.start() for m in item_re.finditer(raw_content)]
        
        for idx, start in enumerate(item_starts):
            end = item_starts[idx + 1] if idx + 1 < len(item_starts) else len(raw_content)
            raw_item = raw_content[start:end].rstrip()
            item_body = re.sub(r"^\\item(?:\[[^\]]*\])?\s*", "", raw_item)
            
            bullets.append({
                "id": f"{section_id}_bullet_{idx}",
                "raw": raw_item,
                "text": latex_to_plain_text(item_body),
                "_offsetStart": abs_start + start,
                "_offsetEnd": abs_start + end
            })
            
        for b in bullets:
            all_plain_texts.append(b["text"])
            
        sections.append({
            "id": section_id,
            "type": match["type"],
            "title": match["title"],
            "rawTitle": match["raw_title"],
            "bullets": bullets,
            "rawContent": raw_content,
            "_offsetStart": abs_start,
            "_offsetEnd": abs_end,
            "locked": False
        })
        
    # Fallback if no headings were parsed
    if not sections and body.strip():
        section_id = "section_0"
        bullets = []
        item_re = re.compile(r"\\item(?:\[[^\]]*\])?")
        item_starts = [m.start() for m in item_re.finditer(body)]
        for idx, start in enumerate(item_starts):
            end = item_starts[idx + 1] if idx + 1 < len(item_starts) else len(body)
            raw_item = body[start:end].rstrip()
            item_body = re.sub(r"^\\item(?:\[[^\]]*\])?\s*", "", raw_item)
            bullets.append({
                "id": f"{section_id}_bullet_{idx}",
                "raw": raw_item,
                "text": latex_to_plain_text(item_body),
                "_offsetStart": body_start + start,
                "_offsetEnd": body_start + end
            })
        for b in bullets:
            all_plain_texts.append(b["text"])
            
        sections.append({
            "id": section_id,
            "type": "section",
            "title": "Document Body",
            "rawTitle": "",
            "bullets": bullets,
            "rawContent": body,
            "_offsetStart": body_start,
            "_offsetEnd": body_end,
            "locked": False
        })
        
    return {
        "preamble": preamble,
        "postamble": postamble,
        "sections": sections,
        "packages": packages,
        "customCommands": custom_commands,
        "rawFull": raw_latex,
        "plainText": " ".join(all_plain_texts)
    }

# --------------------------------------------------------------------------
# API Endpoints
# --------------------------------------------------------------------------

@router.post("/upload", response_model=ResumeDetailOut)
async def upload_resume(
    file: UploadFile = File(...),
    title: str = Form("My Resume"),
    current_user: UserOut = Depends(get_current_user),
    db: Session = Depends(get_db),
    x_api_key: str = Header(None),
    x_ai_model: str = Header(None)
):
    """
    Accepts LaTeX (.tex) or PDF (.pdf) resume uploads:
    1. If LaTeX, reads text file directly.
    2. If PDF, uses server-side Gemini to parse the PDF document directly
       and reconstruct it into standard compilable LaTeX format.
    3. Runs the deterministic parser to generate the structured AST.
    4. Computes semantic embeddings for every bullet point and saves them
       to pgvector table for ATS similarity matching.
    5. Saves the original resume and AST to the database.
    """
    filename = file.filename.lower()
    
    if filename.endswith(".tex"):
        # LaTeX Source Flow
        content_bytes = await file.read()
        raw_latex = content_bytes.decode("utf-8")
        
    elif filename.endswith(".pdf"):
        # PDF Multimodal Conversion Flow
        api_key = x_api_key.strip() if x_api_key else settings.GEMINI_API_KEY
        model_name = x_ai_model.strip() if x_ai_model else settings.GEMINI_MODEL
        
        if not api_key:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="A Gemini API Key is required for PDF parsing. Please select a Gemini model and provide a key."
            )
            
        pdf_bytes = await file.read()
        
        # Configure the Google generative AI client
        genai.configure(api_key=api_key)
        
        # We prompt Gemini using application/pdf parts to output clean raw LaTeX code
        prompt = """
        You are a LaTeX document expert. Convert the following PDF resume document
        into a clean, compilable LaTeX document.
        
        REQUIREMENTS:
        1. Use the "article" document class with standard margins: left=0.75in, right=0.75in, top=0.75in, bottom=0.75in.
        2. Use \\usepackage{geometry} for margin sizing and \\usepackage{enumitem} for bulleted items.
        3. Preserve ALL original wording and dates exactly - do not add or infer any experience.
        4. Structure sections logically: \\section{} for headings, and \\begin{itemize}/\\item for bullets.
        5. Escape all LaTeX command-reserved characters (e.g. & -> \\&, % -> \\%, _ -> \\_).
        6. Return ONLY the raw LaTeX string starting with \\documentclass{article}. No markdown backticks or commentary.
        """
        
        try:
            model = genai.GenerativeModel(model_name)
            response = model.generate_content([
                {"mime_type": "application/pdf", "data": pdf_bytes},
                prompt
            ])
            raw_latex = response.text
            
            # Clean up markdown code wraps if present
            raw_latex = re.sub(r"^```(?:latex|tex)?\s*", "", raw_latex, flags=re.IGNORECASE)
            raw_latex = re.sub(r"\s*```$", "", raw_latex)
            raw_latex = raw_latex.strip()
            
        except Exception as e:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Gemini PDF-to-LaTeX conversion failed: {str(e)}"
            )
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Unsupported file format. Please upload a .tex or .pdf file."
        )

    # 3. Parse LaTeX to AST
    try:
        ast = parse_latex_to_ast(raw_latex)
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Failed to parse LaTeX structure: {str(e)}"
        )
        
    # 4. Save Resume to database
    db_resume = Resume(
        user_id=current_user.id,
        title=title,
        raw_latex=raw_latex,
        parsed_ast=ast
    )
    db.add(db_resume)
    db.commit()
    db.refresh(db_resume)
    
    # 5. Compute and store bullet embeddings for pgvector matches
    save_resume_bullets(db_resume.id, ast["sections"], db)
    
    # Record action in AuditLog
    log_entry = AuditLog(
        user_id=current_user.id,
        action="parse_resume"
    )
    db.add(log_entry)
    db.commit()
    
    return db_resume

@router.get("", response_model=List[ResumeOut])
def get_user_resumes(
    current_user: UserOut = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Retrieves a list of all resume uploads saved by the current user."""
    return db.query(Resume).filter(Resume.user_id == current_user.id).order_by(Resume.created_at.desc()).all()

@router.get("/{resume_id}", response_model=ResumeDetailOut)
def get_resume_detail(
    resume_id: int,
    current_user: UserOut = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """Retrieves the full details (raw LaTeX and parsed AST JSON) for a specific resume."""
    resume = db.query(Resume).filter(Resume.id == resume_id, Resume.user_id == current_user.id).first()
    if not resume:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Resume not found."
        )
    return resume
