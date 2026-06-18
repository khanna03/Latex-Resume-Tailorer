# ==============================================================================
# LaTeX Resume Tailorer — Feedback, Datasets & Compiler Router
# ==============================================================================
# This router implements endpoints to:
# 1. Save user ratings & thumbs-up/down review feedback to PostgreSQL.
# 2. Export tailored runs + ratings in JSONL format for ML training datasets.
# 3. Compile LaTeX code dynamically into downloadable binary PDF streams.
# ==============================================================================

import io
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from backend.database import get_db
from backend.models import Feedback, Version, Resume, AuditLog
from backend.schemas import FeedbackCreate, FeedbackOut, UserOut
from backend.auth import get_current_user
from backend.compiler import compile_latex_to_pdf
from pydantic import BaseModel

router = APIRouter(prefix="/feedback", tags=["Feedback & Compiler"])

# Request schema for arbitrary LaTeX compilation
class CompileRequest(BaseModel):
    latex_code: str

# --------------------------------------------------------------------------
# API Endpoints
# --------------------------------------------------------------------------

@router.post("/submit", response_model=FeedbackOut, status_code=status.HTTP_201_CREATED)
def submit_user_feedback(
    payload: FeedbackCreate,
    current_user: UserOut = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Saves candidate rating evaluation to the database:
    1. Verifies that the associated tailored version exists.
    2. Saves the star score, thumbs-up/down, and comments to the feedback table.
    """
    # Verify version exists
    version = db.query(Version).filter(Version.id == payload.version_id).first()
    if not version:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tailored version not found."
        )

    db_feedback = Feedback(
        version_id=payload.version_id,
        score_stars=payload.score_stars,
        thumbs_direction=payload.thumbs_direction,
        comments=payload.comments
    )
    db.add(db_feedback)
    db.commit()
    db.refresh(db_feedback)

    # Record action in AuditLog
    log_entry = AuditLog(
        user_id=current_user.id,
        action="submit_feedback"
    )
    db.add(log_entry)
    db.commit()

    return db_feedback

@router.get("/export")
def export_ml_dataset(
    current_user: UserOut = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Exports all tailored resumes along with user feedback as a JSONL stream.
    Used to build local dataset streams to fine-tune local models (Phase 5/6 spec).
    """
    # Query all feedback records joined with versions and parent resumes
    feedbacks = db.query(Feedback).all()
    
    # We write JSON lines in memory
    output = io.StringIO()
    
    for f in feedbacks:
        version = db.query(Version).filter(Version.id == f.version_id).first()
        if not version:
            continue
            
        resume = db.query(Resume).filter(Resume.id == version.resume_id).first()
        if not resume:
            continue

        # Create the training dictionary structure
        record = {
            "prompt_job_title": version.job_title,
            "original_latex": resume.raw_latex,
            "tailored_latex": version.tailored_latex,
            "mode": version.mode,
            "rating_stars": f.score_stars,
            "rating_thumbs": f.thumbs_direction,
            "user_comments": f.comments,
            "ats_score_before": version.ats_score_before,
            "ats_score_after": version.ats_score_after
        }
        
        # Append to the string stream as a single JSON line
        import json
        output.write(json.dumps(record) + "\n")

    # Reset buffer position
    output.seek(0)
    
    # Return as an attachment file download
    response = StreamingResponse(
        io.BytesIO(output.getvalue().encode("utf-8")),
        media_type="application/x-jsonlines"
    )
    response.headers["Content-Disposition"] = "attachment; filename=resume_training_dataset.jsonl"
    return response

@router.post("/compile")
def compile_latex(
    payload: CompileRequest,
    current_user: UserOut = Depends(get_current_user),
    db: Session = Depends(get_db)
):
    """
    Compiles input LaTeX source code and returns a binary PDF file stream.
    If compilation fails, returns diagnostic logs.
    """
    # Execute the local or Docker-sandboxed Tectonic compile process
    success, pdf_data, compile_logs = compile_latex_to_pdf(payload.latex_code)
    
    if not success:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "message": "LaTeX compilation failed. Check code syntax.",
                "logs": compile_logs
            }
        )

    # Record action in AuditLog
    log_entry = AuditLog(
        user_id=current_user.id,
        action="compile_resume_pdf"
    )
    db.add(log_entry)
    db.commit()

    # Stream the PDF file binary stream directly back to the client browser
    return StreamingResponse(
        io.BytesIO(pdf_data),
        media_type="application/pdf",
        headers={"Content-Disposition": "attachment; filename=tailored_resume.pdf"}
    )
