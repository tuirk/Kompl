# nlp-service Dockerfile — Kompl v2 commit 3
#
# Build context: ./nlp-service (set in docker-compose.yml). Unlike app/Dockerfile,
# this image does NOT need files from outside its own directory — no shared
# migration scripts, no parent-relative COPYs. Keep it self-contained.
#
# System packages:
#   - ffmpeg:   required by MarkItDown's [all] extras to handle non-WAV audio
#               (MP3 → SpeechRecognition → pydub → ffmpeg). Without this,
#               .mp3 conversion fails silently. See
#               docs/research/2026-04-08-conversion-deps.md section 3.
#   - exiftool: required by MarkItDown to extract EXIF metadata from JPG/PNG
#               images. Without it, image conversion returns an empty string.
#               Same research artifact, same section.
# Intentionally NOT installed (defer per research artifact):
#   - tesseract-ocr (commit 14 PRD feature sweep if user needs scanned-PDF OCR)
#   - libreoffice  (never — tell users to save as modern formats)

FROM python:3.11-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        exiftool \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps BEFORE copying source so the layer is cached when only
# source files change.
COPY requirements.txt /app/requirements.txt

# Install CPU-only torch first. Without this, pip resolves the CUDA wheel
# (~2 GB) from PyPI, bloating the image to 10 GB+. sentence-transformers and
# keybert find torch already installed and skip their own resolution.
RUN pip install --no-cache-dir torch --index-url https://download.pytorch.org/whl/cpu

RUN pip install --no-cache-dir -r requirements.txt

# Part 2a: download spaCy model and NLTK corpora required by rake-nltk.
# en_core_web_sm is ~12 MB; punkt_tab and stopwords are small.
RUN python -m spacy download en_core_web_sm && \
    python -m nltk.downloader stopwords punkt_tab

# Copy the rest of the nlp-service source.
COPY . /app

ENV PYTHONUNBUFFERED=1
# gitpython (pulled in by huggingface_hub/sentence-transformers) warns about
# missing git binary on startup. Silence the message — git is not needed here.
ENV GIT_PYTHON_REFRESH=quiet

EXPOSE 8000

CMD ["uvicorn","main:app","--host","0.0.0.0","--port","8000","--workers","1"]
