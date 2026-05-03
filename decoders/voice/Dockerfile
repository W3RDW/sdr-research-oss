# syntax=docker/dockerfile:1
#
# Whisper voice transcription. Default base is CPU; for GPU build with
#   --build-arg BASE=nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04
# and add the appropriate Python runtime.
ARG BASE=python:3.12-slim
FROM ${BASE}

# Install Python on CUDA base; no-op on python:slim
RUN if [ ! -x "$(command -v python3)" ]; then \
      apt-get update && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg \
      && rm -rf /var/lib/apt/lists/* ; \
    else \
      apt-get update && apt-get install -y --no-install-recommends ffmpeg \
      && rm -rf /var/lib/apt/lists/* ; \
    fi

RUN pip install --no-cache-dir --break-system-packages \
      faster-whisper soundfile numpy

COPY transcribe.py /app/transcribe.py

CMD ["python3", "-u", "/app/transcribe.py"]
