FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN pip install --no-cache-dir kubernetes==31.0.0

COPY watchdog.py /app/watchdog.py
WORKDIR /app

ENTRYPOINT ["python3", "/app/watchdog.py"]
