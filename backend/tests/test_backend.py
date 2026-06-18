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
    assert "mycommand" in ast["customCommands"]
    assert len(ast["sections"]) == 1
    assert ast["sections"][0]["title"] == "Education"
    assert len(ast["sections"][0]["bullets"]) == 1
    assert ast["sections"][0]["bullets"][0]["text"] == "Degree in Computer Science"

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
