FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY encoder.py recorded.py fresh_prayer.py prepare_approved_batch.py ./
COPY assets ./assets
COPY media ./media
RUN python prepare_approved_batch.py
ENV FRESH_PRAYER_ENABLED=true
RUN useradd --create-home encoder
USER encoder
CMD ["python", "recorded.py"]
