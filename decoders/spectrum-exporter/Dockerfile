# syntax=docker/dockerfile:1
FROM python:3.12-slim

RUN pip install --no-cache-dir prometheus-client numpy

COPY spectrum_exporter.py /app/spectrum_exporter.py

EXPOSE 9091
CMD ["python3", "-u", "/app/spectrum_exporter.py"]
