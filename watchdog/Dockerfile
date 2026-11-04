FROM python:3.12-slim@sha256:b18b261e1b4974b4f321451ad5251ded85abb22c2b8b262da527dda1d031ab30

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# Pull in Debian security updates that landed after the base image was cut.
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# certifi floor: older CA bundles carry a critical advisory (GHSA-6q48-6c7w-9gw2).
RUN pip install --no-cache-dir kubernetes==31.0.0 "certifi>=2026.10.18"

COPY watchdog.py /app/watchdog.py
WORKDIR /app

ENTRYPOINT ["python3", "/app/watchdog.py"]
