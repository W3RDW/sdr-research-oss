# syntax=docker/dockerfile:1
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      sox libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
      numpy scipy pillow soundfile pysstv

COPY sstv-entrypoint.py /app/sstv-entrypoint.py

CMD ["python3", "-u", "/app/sstv-entrypoint.py"]
