# ==============================================================================
# LaTeX Resume Tailorer — Backend Dockerfile
# ==============================================================================
# Builds a lightweight Python container. It pre-downloads the ML model weights
# during image compilation so that runtime container startup is instantaneous.
# ==============================================================================

FROM python:3.11-slim

WORKDIR /app

# Install build dependencies required to build libraries like psycopg2-binary
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements mapping
COPY backend/requirements.txt .

# Install python packages
RUN pip install --no-cache-dir -r requirements.txt

# --------------------------------------------------------------------------
# Caching ML Model Weights (Build-Time Optimization)
# --------------------------------------------------------------------------
# Downloads sentence-transformers/all-MiniLM-L6-v2 during the image build step.
# This ensures that launching the container doesn't block on downloading
# 90MB weights over the network at runtime.
RUN python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('all-MiniLM-L6-v2')"

# Copy remaining code files
COPY backend /app/backend

# Expose standard FastAPI port
EXPOSE 8000

# Start FastAPI uvicorn server mapping globally
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
