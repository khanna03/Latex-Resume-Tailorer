# ==============================================================================
# LaTeX Resume Tailorer — Database Configuration
# ==============================================================================
# This module configures SQLAlchemy (our Object-Relational Mapper) to talk to
# PostgreSQL, defines the table schemas base model, and configures startup hooks
# to initialize the 'pgvector' extension inside Postgres.
# ==============================================================================

from sqlalchemy import create_engine, text
from sqlalchemy.orm import declarative_base, sessionmaker
from backend.config import settings

# --------------------------------------------------------------------------
# SQLAlchemy Engine Creation
# --------------------------------------------------------------------------
# The engine connects the Python code to the database socket.
# 'pool_pre_ping=True' is a health check that test-pings the database before
# each request to prevent crashing on stale/dropped TCP sockets.
engine = create_engine(
    settings.DATABASE_URL,
    echo=False,          # Set to True to print all generated SQL queries to stdout
    pool_pre_ping=True
)

# --------------------------------------------------------------------------
# Session Factory
# --------------------------------------------------------------------------
# This class behaves as a factory for database connections. We set autoflush to
# False so changes aren't written to disk until we explicitly call 'db.commit()'.
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# --------------------------------------------------------------------------
# Base Mapping Class
# --------------------------------------------------------------------------
# All our database model classes (User, Resume, Version) will inherit from this
# base class to register their fields and schemas with SQLAlchemy.
Base = declarative_base()

def init_db():
    """
    Initializes the PostgreSQL database.
    1. Installs the 'pgvector' (vector) extension if it doesn't already exist.
    2. Scans the 'models.py' file and creates any missing tables.
    
    Should be called inside FastAPI's lifspan/startup handler.
    """
    # Open a single transactional block to create the vector extension first
    with engine.begin() as conn:
        # pgvector must be enabled before SQLAlchemy can load any column type 'Vector'
        conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector;"))
    
    # Create tables defined on the Base metadata mapping
    Base.metadata.create_all(bind=engine)

def get_db():
    """
    FastAPI dependency injector that yields a database session.
    
    Usage in routes:
        @app.get("/items")
        def read_items(db: Session = Depends(get_db)):
            ...
            
    The 'yield' statement ensures that:
    1. A connection is opened for the database operations.
    2. Control is handed back to the endpoint logic.
    3. The connection is cleanly closed when the HTTP response is sent.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
