# syntax=docker/dockerfile:1
FROM python:3.14-slim@sha256:930e1abba7c4e8f96ed93e8012c35d174d7732752731bbd5e8e757d7ec6f3966

# Pull in Debian security updates that landed after the base image was cut.
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py ./

EXPOSE 8080

# MCP_TOKEN and SDR_API_BASE are injected via the Deployment env.
CMD ["python", "server.py"]
