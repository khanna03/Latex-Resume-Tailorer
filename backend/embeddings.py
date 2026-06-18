# ==============================================================================
# LaTeX Resume Tailorer — ML Semantic Embeddings Engine
# ==============================================================================
# This module loads the 'all-MiniLM-L6-v2' Sentence-Transformer model locally
# to convert resume bullets and job requirements into 384-dimensional vectors.
# These vectors are stored in PostgreSQL using the pgvector extension, enabling
# semantic searches (cosine similarity) that detect synonyms and abbreviations.
# ==============================================================================

import numpy as np
from sqlalchemy import text
from sqlalchemy.orm import Session
from sentence_transformers import SentenceTransformer

from backend.models import ResumeBulletVector

# --------------------------------------------------------------------------
# Model Initialization
# --------------------------------------------------------------------------
# Initialize the model on module import. SentenceTransformer downloads the
# weights (~90MB) on the first execution and caches them locally.
# all-MiniLM-L6-v2 is an extremely fast, high-quality general-purpose text encoder.
print("Loading sentence-transformers/all-MiniLM-L6-v2...")
embedding_model = SentenceTransformer("all-MiniLM-L6-v2")
print("Model loaded successfully.")

def get_embedding(text_string: str) -> list:
    """
    Encodes a single sentence or phrase into a 384-dimensional float vector.
    Returns a Python list of floats.
    """
    if not text_string.strip():
        # Return zero vector for empty fields to prevent mathematical errors
        return [0.0] * 384
    return embedding_model.encode(text_string).tolist()

def get_embeddings(text_list: list) -> list:
    """
    Encodes a list of sentences in a single batch, improving GPU/CPU efficiency.
    Returns a list of lists of floats.
    """
    if not text_list:
        return []
    return embedding_model.encode(text_list).tolist()

# --------------------------------------------------------------------------
# pgvector Database Operations
# --------------------------------------------------------------------------

def save_resume_bullets(resume_id: int, ast_sections: list, db: Session):
    """
    Processes the parsed LaTeX resume AST:
    1. Deletes any old vector records for this resume (for update safety).
    2. Runs batch vector encoding for every bullet point in all sections.
    3. Saves the texts and embeddings to the 'resume_bullet_vectors' table.
    
    Parameters:
        resume_id: ID of the resume in PostgreSQL
        ast_sections: List of sections from the parsed AST JSON
        db: Active SQLAlchemy database session
    """
    # Delete old bullet vectors (clean state)
    db.query(ResumeBulletVector).filter(ResumeBulletVector.resume_id == resume_id).delete()
    
    bullet_records = []
    
    for section in ast_sections:
        section_id = section.get("id")
        bullets = section.get("bullets", [])
        
        for idx, bullet in enumerate(bullets):
            bullet_text = bullet.get("text", "")
            if not bullet_text.strip():
                continue
                
            # Compute embedding vector for this bullet point
            vector = get_embedding(bullet_text)
            
            bullet_records.append(
                ResumeBulletVector(
                    resume_id=resume_id,
                    section_id=section_id,
                    bullet_index=idx,
                    bullet_text=bullet_text,
                    embedding=vector
                )
            )
            
    if bullet_records:
        # Perform database bulk insert to maximize performance
        db.bulk_save_objects(bullet_records)
        db.commit()

def check_semantic_match(keyword: str, resume_id: int, db: Session, threshold: float = 0.35) -> bool:
    """
    Determines if a target keyword/skill is semantically matched within the resume
    using pgvector cosine distance.
    
    This is extremely useful when the resume uses a synonym or abbreviation
    not verbatim in the job description (e.g., 'GCP' vs 'Google Cloud Platform').
    
    Cosine distance formula: 1 - cosine_similarity
    Values range from 0.0 (identical vectors) to 2.0 (orthogonal).
    A distance <= 0.35 typically indicates a close semantic match.
    
    Parameters:
        keyword: The skill name to search for (e.g. "Kubernetes")
        resume_id: ID of the resume to search against
        db: Active database session
        threshold: Cosine distance matching limit
    """
    kw_emb = get_embedding(keyword)
    
    match = db.query(
        ResumeBulletVector,
        ResumeBulletVector.embedding.cosine_distance(kw_emb).label("distance")
    ).filter(
        ResumeBulletVector.resume_id == resume_id
    ).order_by(
        ResumeBulletVector.embedding.cosine_distance(kw_emb)
    ).first()
        
    if match:
        bullet_instance, distance = match
        # If the distance is below the threshold, it is a valid semantic match
        return distance < threshold
        
    return False
