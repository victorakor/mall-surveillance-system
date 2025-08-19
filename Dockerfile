# syntax = docker/dockerfile:1.5
FROM python:3.9.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    SOCKETIO_ASYNC=eventlet \
    OPENCV_LOG_LEVEL=ERROR

# Install system dependencies (needed by OpenCV & video streaming)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg libgl1 libglib2.0-0 libsm6 libxrender1 libxext6 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies first (caching layer)
COPY requirements.txt .
RUN python -m pip install --upgrade pip && pip install -r requirements.txt

# Copy the rest of your app (templates, static, YOLO weights, etc.)
COPY . .

# Render sets $PORT automatically, bind to it
EXPOSE 10000
CMD ["bash","-lc","exec gunicorn -k eventlet -w 1 -b 0.0.0.0:$PORT app:app"]
