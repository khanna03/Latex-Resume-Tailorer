# ==============================================================================
# conftest.py — Test Isolation for backend/tests/
# ==============================================================================
# The application imports create a real PostgreSQL engine at module-load time
# (database.py: create_engine(...) runs immediately). Since PostgreSQL is not
# available in the local dev environment, we must intercept that import before
# any test module loads, and swap in an in-memory SQLite engine instead.
#
# This conftest is picked up automatically by pytest before any test file
# in this directory is collected, so the patch is always applied first.
# ==============================================================================

import sys
from unittest.mock import MagicMock, patch

# ---------------------------------------------------------------------------
# Stub out psycopg2 so that SQLAlchemy's PostgreSQL dialect can be imported
# without a real PostgreSQL installation present.
# ---------------------------------------------------------------------------
sys.modules.setdefault('psycopg2', MagicMock())

# ---------------------------------------------------------------------------
# Stub out sentence_transformers which requires heavy ML model downloads
# ---------------------------------------------------------------------------
sys.modules.setdefault('sentence_transformers', MagicMock())

# ---------------------------------------------------------------------------
# Stub out pgvector so the Vector column type doesn't crash on import
# ---------------------------------------------------------------------------
sys.modules.setdefault('pgvector', MagicMock())
sys.modules.setdefault('pgvector.sqlalchemy', MagicMock())

# ---------------------------------------------------------------------------
# Override DATABASE_URL to use an in-memory SQLite database so that the engine
# is created successfully without needing a running PostgreSQL server.
# This must happen before backend.database is imported.
# ---------------------------------------------------------------------------
import os
os.environ.setdefault('DATABASE_URL', 'sqlite:///:memory:')
os.environ.setdefault('GEMINI_API_KEY', 'test-key-placeholder')
os.environ.setdefault('JWT_SECRET_KEY', 'test-jwt-secret-key-for-unit-tests-only')
