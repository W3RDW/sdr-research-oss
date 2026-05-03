# syntax=docker/dockerfile:1
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      sox libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir numpy scipy

COPY cw_decode.py /app/cw_decode.py

CMD ["python3", "-u", "/app/cw_decode.py"]
