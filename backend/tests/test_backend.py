# ==============================================================================
# LaTeX Resume Tailorer — Backend Unit Tests
# ==============================================================================
# This test suite verifies authentication password hashing, JWT token signature
# issuance, the deterministic regex parser, and mocks FastAPI API endpoints.
# Run 'pytest backend/tests/' to execute these tests.
# ==============================================================================

import pytest
from fastapi.testclient import TestClient

from backend.auth import get_password_hash, verify_password, create_access_token
from backend.routes.parser import parse_latex_to_ast, latex_to_plain_text
from backend.main import app

client = TestClient(app)

# --------------------------------------------------------------------------
# 1. Auth & Password Hashing Unit Tests
# --------------------------------------------------------------------------

def test_password_hashing_and_verification():
    """Verifies that passlib password hashing and check methods work correctly."""
    pwd = "MySuperSecretPassword123"
    hashed = get_password_hash(pwd)
    
    # Hash must be distinct from plaintext
    assert hashed != pwd
    # Verification should succeed with correct password
    assert verify_password(pwd, hashed) is True
    # Verification should fail with incorrect password
    assert verify_password("wrong_password", hashed) is False

def test_jwt_token_creation():
    """Verifies that JWT access token creation encodes the subject payload correctly."""
    email = "test_user@example.com"
    token = create_access_token(data={"sub": email})
    assert token is not None
    assert isinstance(token, str)

# --------------------------------------------------------------------------
# 2. LaTeX AST Regex Parser Unit Tests
# --------------------------------------------------------------------------

def test_latex_to_plain_text():
    """Verifies that format macros and href directives are stripped successfully."""
    latex = r"Hello \textbf{World} inside a \href{http://google.com}{link}."
    plain = latex_to_plain_text(latex)
    assert plain == "Hello World inside a link."

def test_parse_latex_to_ast_preamble():
    """Verifies that packages and custom commands are extracted from the preamble."""
    latex = r"""
    \documentclass{article}
    \usepackage{geometry}
    \usepackage{enumitem}
    \newcommand{\mycommand}{Custom Macro}
    \begin{document}
    \section{Education}
    \begin{itemize}
    \item Degree in Computer Science
    \end{itemize}
    \end{document}
    """
    ast = parse_latex_to_ast(latex)
    assert "geometry" in ast["packages"]
    assert "enumitem" in ast["packages"]
    assert "\\mycommand" in ast["customCommands"]
    assert len(ast["sections"]) == 1
    assert ast["sections"][0]["title"] == "Education"
    assert len(ast["sections"][0]["bullets"]) == 1
    assert ast["sections"][0]["bullets"][0]["text"].startswith("Degree in Computer Science")

def test_parse_latex_to_ast_offset_tracking():
    """Verifies that offset-based section boundary positions are calculated correctly."""
    latex = r"""\begin{document}
\section{Skills}
\begin{itemize}
\item Python coding
\item SQL queries
\end{itemize}
\end{document}"""
    ast = parse_latex_to_ast(latex)
    assert len(ast["sections"]) == 1
    section = ast["sections"][0]
    assert section["title"] == "Skills"
    assert len(section["bullets"]) == 2
    
    # Check offsets of bullets relative to the document
    b1 = section["bullets"][0]
    b2 = section["bullets"][1]
    assert b1["_offsetStart"] < b1["_offsetEnd"]
    assert b1["_offsetEnd"] <= b2["_offsetStart"]
    assert b2["_offsetStart"] < b2["_offsetEnd"]

# --------------------------------------------------------------------------
# 3. FastAPI Endpoint Connectivity Tests
# --------------------------------------------------------------------------

def test_root_endpoint_health():
    """Verifies that the root health check endpoint returns 200 OK and online status."""
    response = client.get("/")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "online"
    assert "FastAPI" in data["features"]


# --------------------------------------------------------------------------
# 4. Phase 3 — Fabrication Check Unit Tests
# --------------------------------------------------------------------------

from backend.pipeline_helpers import check_fabrication, extract_metrics, extract_proper_nouns

ORIGINAL_TEXT = (
    "Led development of Python-based microservices. "
    "Worked with PostgreSQL and Redis. "
    "Improved velocity by 20% over 6 months. "
    "Collaborated with Google team."
)

def test_fabrication_check_no_fabrication():
    """Returns no flags when generated text is identical to original."""
    flagged, has_fab, summary = check_fabrication(ORIGINAL_TEXT, ORIGINAL_TEXT)
    assert has_fab is False
    assert flagged == []

def test_fabrication_check_empty_inputs():
    """Returns no flags and no error when both inputs are empty."""
    flagged, has_fab, summary = check_fabrication("", "")
    assert has_fab is False

def test_fabrication_check_new_tech_term():
    """Flags a new tech term (Kubernetes) not present in original."""
    generated = ORIGINAL_TEXT + " Also uses Kubernetes for orchestration."
    flagged, has_fab, summary = check_fabrication(ORIGINAL_TEXT, generated)
    assert has_fab is True
    entities = [f["entity"].lower() for f in flagged]
    assert "kubernetes" in entities

def test_fabrication_check_new_metric():
    """Flags a new metric claim (3x) not present in original."""
    generated = ORIGINAL_TEXT + " Achieved 3x throughput improvement."
    flagged, has_fab, summary = check_fabrication(ORIGINAL_TEXT, generated)
    assert has_fab is True
    types = [f["type"] for f in flagged]
    assert "metric" in types

def test_fabrication_check_existing_metric_not_flagged():
    """Does NOT flag '20%' since it is already in the original text."""
    generated = ORIGINAL_TEXT  # 20% is in original
    flagged, has_fab, summary = check_fabrication(ORIGINAL_TEXT, generated)
    metric_flags = [f for f in flagged if f["type"] == "metric"]
    assert all("20%" not in f["entity"] for f in metric_flags)

def test_fabrication_check_flag_structure():
    """Each flag has entity, type, and context fields."""
    generated = ORIGINAL_TEXT + " Uses Kubernetes and Terraform."
    flagged, has_fab, summary = check_fabrication(ORIGINAL_TEXT, generated)
    for flag in flagged:
        assert "entity" in flag
        assert "type" in flag
        assert "context" in flag
        assert flag["type"] in ("tech", "metric", "proper_noun")

def test_extract_metrics_detects_patterns():
    """extract_metrics should find percentages, multipliers, and dollar amounts."""
    text = "Improved by 40%, achieved 3x speedup, and saved $2M."
    metrics = extract_metrics(text)
    assert any("40%" in m for m in metrics)
    assert any("3x" in m for m in metrics)
    assert any("$2M" in m for m in metrics)

def test_extract_metrics_empty_string():
    """extract_metrics returns empty list for empty input."""
    assert extract_metrics("") == []


# --------------------------------------------------------------------------
# 5. Phase 3 — Reconstruction & Locked Sections Tests
# --------------------------------------------------------------------------

from backend.pipeline_helpers import reconstruct_latex, validate_locked_sections

SIMPLE_LATEX = r"""\documentclass{article}
\begin{document}
\section{Experience}
\item Built APIs using Java.
\item Deployed on AWS EC2.
\section{Education}
\item B.S. Computer Science, MIT.
\end{document}"""

def test_reconstruct_latex_no_edits_returns_original():
    """Reconstructing with no section modifications returns the original unchanged."""
    from backend.routes.parser import parse_latex_to_ast
    ast = parse_latex_to_ast(SIMPLE_LATEX)
    result = reconstruct_latex(ast, {}, set())
    assert result == SIMPLE_LATEX

def test_reconstruct_latex_modifies_unlocked_section():
    """Modifying an unlocked section changes its content in the output."""
    from backend.routes.parser import parse_latex_to_ast
    ast = parse_latex_to_ast(SIMPLE_LATEX)
    exp_id = ast["sections"][0]["id"]  # Experience section
    mod_map = {exp_id: {"bullets": ["Led Python FastAPI backend.", "Deployed on Kubernetes."]}}
    result = reconstruct_latex(ast, mod_map, set())
    assert "Python FastAPI backend" in result
    assert "Built APIs using Java" not in result

def test_reconstruct_latex_locked_section_unchanged():
    """Providing a modification for a locked section ID produces no change."""
    from backend.routes.parser import parse_latex_to_ast
    ast = parse_latex_to_ast(SIMPLE_LATEX)
    edu_id = ast["sections"][1]["id"]  # Education section
    mod_map = {edu_id: {"bullets": ["Hacked education entry"]}}
    result = reconstruct_latex(ast, mod_map, locked_section_ids={edu_id})
    assert "B.S. Computer Science, MIT" in result
    assert "Hacked education entry" not in result

def test_validate_locked_sections_no_lock_unchanged():
    """validate_locked_sections with empty locked set returns original unchanged."""
    from backend.routes.parser import parse_latex_to_ast
    ast = parse_latex_to_ast(SIMPLE_LATEX)
    result, reverted = validate_locked_sections(ast, SIMPLE_LATEX, set())
    assert result == SIMPLE_LATEX
    assert reverted == []

def test_validate_locked_sections_reverts_tampered_content():
    """validate_locked_sections reverts locked section if AI altered it."""
    from backend.routes.parser import parse_latex_to_ast
    ast = parse_latex_to_ast(SIMPLE_LATEX)
    edu_id = ast["sections"][1]["id"]

    tampered = SIMPLE_LATEX.replace("B.S. Computer Science, MIT.", "Ph.D. Harvard.")
    result, reverted = validate_locked_sections(ast, tampered, {edu_id})
    assert "B.S. Computer Science, MIT" in result
    assert "Ph.D. Harvard" not in result
    assert edu_id in reverted


# --------------------------------------------------------------------------
# 6. Phase 3 — LaTeX Validator Tests
# --------------------------------------------------------------------------

from backend.pipeline_helpers import validate_latex_deterministic

VALID_LATEX = r"""\documentclass{article}
\begin{document}
\section{Skills}
\begin{itemize}
\item Python
\end{itemize}
\end{document}"""

def test_validate_latex_valid_document():
    """A well-formed LaTeX document should produce valid=True with no errors."""
    report = validate_latex_deterministic(VALID_LATEX)
    assert report["valid"] is True
    assert report["errors"] == []

def test_validate_latex_missing_end_document():
    """Missing \\end{document} should be flagged as an environment error."""
    bad_latex = r"""\documentclass{article}
\begin{document}
\section{Skills}
\item Python"""
    report = validate_latex_deterministic(bad_latex)
    assert report["valid"] is False
    error_types = [e["type"] for e in report["errors"]]
    assert "structure" in error_types or "environment" in error_types

def test_validate_latex_unescaped_ampersand():
    """An unescaped '&' outside a tabular context should be flagged."""
    bad_latex = r"""\documentclass{article}
\begin{document}
\section{Skills}
\item Python & Java
\end{document}"""
    report = validate_latex_deterministic(bad_latex)
    assert report["valid"] is False
    messages = [e["message"] for e in report["errors"]]
    assert any("&" in m for m in messages)

def test_validate_latex_unbalanced_brace():
    """An unclosed brace should be detected."""
    bad_latex = r"""\documentclass{article}
\begin{document}
\textbf{Unclosed
\end{document}"""
    report = validate_latex_deterministic(bad_latex)
    assert report["valid"] is False
    error_types = [e["type"] for e in report["errors"]]
    assert "brace" in error_types

def test_validate_latex_empty_string():
    """An empty string should produce valid=False."""
    report = validate_latex_deterministic("")
    assert report["valid"] is False


# --------------------------------------------------------------------------
# 7. Phase 3 — ATS Score & Ranking Tests
# --------------------------------------------------------------------------

from backend.pipeline_helpers import compute_ats_score, rank_candidates
from backend.schemas import JDAnalysisOut

JD = JDAnalysisOut(
    role_title="Backend Engineer",
    company_context="",
    experience_level="mid",
    required_skills=["Python", "FastAPI", "PostgreSQL"],
    preferred_skills=["Docker", "Kubernetes"],
    soft_skills=["Communication"],
    ats_keywords=["Python", "REST API", "Microservices"],
    industry_terms=["Backend"],
    responsibilities=["Build APIs"],
)

HIGH_ATS_TEXT = "Python FastAPI PostgreSQL microservices REST API Docker Kubernetes communication backend"
LOW_ATS_TEXT  = "Customer service, telephone support, filing documents, office tasks"

def test_compute_ats_score_high_match():
    """A resume with all required/ATS keywords scores high."""
    report = compute_ats_score(HIGH_ATS_TEXT, JD)
    assert report["score"] >= 80

def test_compute_ats_score_low_match():
    """An unrelated resume scores very low."""
    report = compute_ats_score(LOW_ATS_TEXT, JD)
    assert report["score"] < 20

def test_compute_ats_score_confidence_band():
    """scoreMin <= score <= scoreMax, all in [0, 100]."""
    report = compute_ats_score(HIGH_ATS_TEXT, JD)
    assert 0 <= report["scoreMin"] <= report["score"] <= report["scoreMax"] <= 100

def test_compute_ats_score_missing_skills_present():
    """missingRequired contains skills absent from resume."""
    report = compute_ats_score(LOW_ATS_TEXT, JD)
    missing = [s.lower() for s in report["missingRequired"]]
    assert "python" in missing

HIGH_ATS_LATEX = r"""\documentclass{article}
\begin{document}
\section{Experience}
\item Developed Python FastAPI microservices with PostgreSQL and REST API.
\item Built communication platform. Backend API architecture.
\end{document}"""

LOW_ATS_LATEX = r"""\documentclass{article}
\begin{document}
\section{Experience}
\item Answered phone calls. Filed documents.
\end{document}"""

def test_rank_candidates_orders_best_first():
    """rankCandidates places the higher-ATS candidate first."""
    candidates = [
        {"mode": "conservative", "latex": LOW_ATS_LATEX},
        {"mode": "aggressive",   "latex": HIGH_ATS_LATEX},
    ]
    ranked = rank_candidates(LOW_ATS_LATEX, candidates, JD)
    assert ranked[0]["mode"] == "aggressive"

def test_rank_candidates_descending_scores():
    """All candidates are ordered by totalScore descending."""
    candidates = [
        {"mode": "conservative", "latex": LOW_ATS_LATEX},
        {"mode": "aggressive",   "latex": HIGH_ATS_LATEX},
    ]
    ranked = rank_candidates(LOW_ATS_LATEX, candidates, JD)
    for i in range(len(ranked) - 1):
        assert ranked[i]["totalScore"] >= ranked[i + 1]["totalScore"]

def test_rank_candidates_filters_invalid():
    """None and empty-latex candidates are filtered out."""
    candidates = [
        None,
        {"mode": "moderate", "latex": ""},
        {"mode": "aggressive", "latex": HIGH_ATS_LATEX},
    ]
    ranked = rank_candidates(LOW_ATS_LATEX, candidates, JD)
    assert len(ranked) == 1
    assert ranked[0]["mode"] == "aggressive"

def test_rank_candidates_returns_empty_for_all_invalid():
    """Returns empty list when all candidates are invalid."""
    ranked = rank_candidates(LOW_ATS_LATEX, [None, {"mode": "x", "latex": ""}], JD)
    assert ranked == []

# --------------------------------------------------------------------------
# 8. Phase 4 — ML Dataset Generation & Export Tests
# --------------------------------------------------------------------------

from unittest.mock import MagicMock
from datetime import datetime
import asyncio
from backend.routes.feedback import export_ml_dataset, submit_user_feedback
from backend.schemas import UserOut, FeedbackCreate
from backend.models import Feedback, Version, Resume, AuditLog

def test_export_ml_dataset_empty():
    """Phase 4: Exporting an empty dataset returns a valid JSONL stream."""
    mock_db = MagicMock()
    mock_db.query.return_value.all.return_value = []
    
    mock_user = UserOut(id=1, email="test@example.com", is_active=True, created_at=datetime.utcnow())
    response = export_ml_dataset(current_user=mock_user, db=mock_db)
    
    assert response.media_type == "application/x-jsonlines"
    
    async def consume_stream(stream):
        return b"".join([chunk async for chunk in stream])
        
    body = asyncio.run(consume_stream(response.body_iterator))
    assert body == b""

def test_export_ml_dataset_with_data():
    """Phase 4: Exporting dataset with feedback serializes correctly to JSONL."""
    mock_db = MagicMock()
    
    mock_feedback = Feedback(version_id=10, score_stars=5, thumbs_direction="up", comments="Great")
    mock_version = Version(id=10, resume_id=20, job_title="SWE", tailored_latex="new_latex", ats_score_before=50.0, ats_score_after=90.0, mode="aggressive")
    mock_resume = Resume(id=20, raw_latex="old_latex")
    
    def mock_query(model):
        query_mock = MagicMock()
        if model == Feedback:
            query_mock.all.return_value = [mock_feedback]
        elif model == Version:
            query_mock.filter.return_value.first.return_value = mock_version
        elif model == Resume:
            query_mock.filter.return_value.first.return_value = mock_resume
        return query_mock
        
    mock_db.query.side_effect = mock_query
    
    mock_user = UserOut(id=1, email="test@example.com", is_active=True, created_at=datetime.utcnow())
    response = export_ml_dataset(current_user=mock_user, db=mock_db)
    
    async def consume_stream(stream):
        return b"".join([chunk async for chunk in stream])
        
    body = asyncio.run(consume_stream(response.body_iterator)).decode("utf-8")
    assert "old_latex" in body
    assert "new_latex" in body
    assert "SWE" in body
    assert "aggressive" in body
    assert "Great" in body

def test_submit_user_feedback():
    """Phase 4: Submitting feedback saves to DB and creates an audit log."""
    mock_db = MagicMock()
    mock_version = Version(id=10)
    
    def mock_query(model):
        query_mock = MagicMock()
        if model == Version:
            query_mock.filter.return_value.first.return_value = mock_version
        return query_mock
    
    mock_db.query.side_effect = mock_query
    
    mock_user = UserOut(id=1, email="test@example.com", is_active=True, created_at=datetime.utcnow())
    payload = FeedbackCreate(version_id=10, score_stars=4, thumbs_direction="up", comments="Good")
    
    result = submit_user_feedback(payload=payload, current_user=mock_user, db=mock_db)
    
    assert result.score_stars == 4
    assert result.thumbs_direction == "up"
    assert result.comments == "Good"
    
    assert mock_db.add.call_count == 2
    assert mock_db.commit.call_count == 2

# --------------------------------------------------------------------------
# 9. Phase 5/6 — Local Model Routing Tests
# --------------------------------------------------------------------------
from backend.llm_provider import generate_json_content
from backend.config import settings
from unittest.mock import patch

@patch("backend.llm_provider.OpenAI")
def test_generate_json_content_local_routing(mock_openai):
    """Phase 5/6: Local LLM base URL properly routes to OpenAI client."""
    settings.LOCAL_LLM_BASE_URL = "http://localhost:11434/v1"
    
    mock_client = MagicMock()
    mock_openai.return_value = mock_client
    mock_client.chat.completions.create.return_value = MagicMock(
        choices=[MagicMock(message=MagicMock(content='{"tailored_latex": "test"}'))]
    )
    
    result = generate_json_content(api_key="", model_name="unsloth/llama-3-8b", prompt="Hello")
    
    mock_openai.assert_called_once_with(api_key="local", base_url="http://localhost:11434/v1")
    
    mock_client.chat.completions.create.assert_called_once()
    call_kwargs = mock_client.chat.completions.create.call_args[1]
    assert call_kwargs["model"] == "unsloth/llama-3-8b"
    assert result == {"tailored_latex": "test"}
    
    settings.LOCAL_LLM_BASE_URL = None

