# syntax=docker/dockerfile:1

FROM python:3.12-slim

WORKDIR /app

# Install system dependencies for audio processing and PostgreSQL
RUN apt-get update && apt-get install -y --no-install-recommends \
    libsndfile1 \
    ffmpeg \
    libpq5 \
    && rm -rf /var/lib/apt/lists/*

# Install Python dependencies
COPY pyproject.toml ./
RUN pip install --no-cache-dir \
    fastapi uvicorn[standard] \
    sqlalchemy psycopg2-binary alembic \
    python-multipart aiofiles \
    librosa numpy scipy matplotlib \
    pydantic pydantic-settings \
    prometheus-fastapi-instrumentator

# Copy application
COPY ./app ./app

# Create non-root user
RUN useradd -m -u 1000 appuser && \
    mkdir -p /cache && \
    chown -R appuser:appuser /app /cache

USER appuser

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
