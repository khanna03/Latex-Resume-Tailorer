# ==============================================================================
# LaTeX Resume Tailorer — FastAPI Application Entrypoint
# ==============================================================================
# This module bootstraps the FastAPI application server, sets up CORS rules
# for frontend connection, hooks database tables initialization on startup,
# registers the SlowAPI rate limiter, and aggregates all sub-routers under /api.
# ==============================================================================

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

from backend.config import settings
from backend.database import init_db
from backend.routes import auth, parser, tailor, feedback

# --------------------------------------------------------------------------
# Rate Limiter Initialization
# --------------------------------------------------------------------------
# We initialize the slowapi rate limiter. It uses the client IP address by
# default to track API request volumes.
limiter = Limiter(key_func=get_remote_address)

app = FastAPI(
    title="Curricula AI Backend",
    description="Hybrid AI + ML LaTeX resume tailoring pipeline API",
    version="1.0.0"
)

# Connect the rate limiter instance and register its exception handler
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)

# --------------------------------------------------------------------------
# CORS (Cross-Origin Resource Sharing) Middleware
# --------------------------------------------------------------------------
# Configures CORS to allow our Vite-based frontend (running on port 5173)
# to query the backend endpoints.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"], # Allow all HTTP verbs (GET, POST, OPTIONS, etc.)
    allow_headers=["*"], # Allow all headers (Authorization, Content-Type, etc.)
)

# --------------------------------------------------------------------------
# Startup Event
# --------------------------------------------------------------------------
@app.on_event("startup")
def on_startup():
    """
    Executes database setups on server launch:
    Installs the Postgres vector extension and validates schemas.
    """
    print("Initializing database connection...")
    init_db()
    print("Database tables validated.")

# --------------------------------------------------------------------------
# API Router Registrations
# --------------------------------------------------------------------------
# We prefix all endpoints under /api to segment api operations cleanly
app.include_router(auth.router, prefix="/api")
app.include_router(parser.router, prefix="/api")
app.include_router(tailor.router, prefix="/api")
app.include_router(feedback.router, prefix="/api")

# --------------------------------------------------------------------------
# Root Endpoint
# --------------------------------------------------------------------------
@app.get("/")
def get_root_status(request: Request):
    """Simple health-check endpoint confirming backend state."""
    return {
        "status": "online",
        "app": "LaTeX Resume Tailorer Backend",
        "version": "1.0.0",
        "features": ["FastAPI", "pgvector", "all-MiniLM-L6-v2", "Tectonic compiler"]
    }
