# syntax=docker/dockerfile:1
#
# Whisper voice transcription.
#
# Default base is CPU-only (python:3.12-slim). For a CUDA/GPU image build with:
#   --build-arg BASE=nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04
# The cudnn-runtime variant is required: faster-whisper/CTranslate2 needs cuDNN
# and cuBLAS at runtime for the float16 CUDA path. The RUN below installs the
# Python runtime + ffmpeg on the CUDA base (which ships neither) and is a no-op
# on python:slim, so no other changes are needed to produce the GPU image.
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

# Upgrade pip first: the CUDA base ships Ubuntu 22.04's pip 22.0, which predates
# --break-system-packages (added in pip 23.0.1). python:slim already has a modern pip.
RUN python3 -m pip install --no-cache-dir --upgrade pip \
 && python3 -m pip install --no-cache-dir --break-system-packages \
      faster-whisper soundfile numpy

COPY transcribe.py /app/transcribe.py

CMD ["python3", "-u", "/app/transcribe.py"]
