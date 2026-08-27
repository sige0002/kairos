# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89

FROM python:3.12.13-slim@sha256:423ed6ab25b1921a477529254bfeeabf5855151dc2c3141699a1bfc852199fbf AS builder
COPY --from=ghcr.io/astral-sh/uv:0.10.0@sha256:78a7ff97cd27b7124a5f3c2aefe146170793c56a1e03321dd31a289f6d82a04f /uv /usr/local/bin/uv

ENV VENV=/opt/venv \
    UV_PYTHON_PREFERENCE=only-system \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_HTTP_TIMEOUT=600 \
    UV_HTTP_RETRIES=5
RUN uv venv --python python3 $VENV
ENV PATH="$VENV/bin:$PATH"

WORKDIR /app
COPY services/kokoro /app/services/kokoro
# Kokoro imports its eSpeak fallback eagerly, although native Misaki G2P
# covers our English/Japanese scope. Drop that import and the unused GPL
# fallback packages so the distributed image contains one speech engine.
RUN cd /app/services/kokoro \
    && uv sync --frozen --no-editable --no-dev --extra runtime \
    && sed -i '/from \.pipeline import KPipeline/d' \
        /opt/venv/lib/python3.12/site-packages/kokoro/__init__.py \
    && sed -i '1i# Modified by kairos: removed the unused eager KPipeline import.' \
        /opt/venv/lib/python3.12/site-packages/kokoro/__init__.py \
    && uv pip uninstall phonemizer-fork espeakng-loader
RUN python /app/services/kokoro/scripts/fetch_model.py /opt/kokoro-model

FROM python:3.12.13-slim@sha256:423ed6ab25b1921a477529254bfeeabf5855151dc2c3141699a1bfc852199fbf AS runtime
RUN apt-get update \
    && apt-get install --no-install-recommends -y libgomp1 libsndfile1 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --create-home --uid 10001 appuser

ENV VENV=/opt/venv \
    PATH="/opt/venv/bin:$PATH" \
    KOKORO_MODEL_DIR=/opt/kokoro-model \
    KOKORO_BIND=0.0.0.0 \
    KOKORO_PORT=8050 \
    KOKORO_THREADS=2 \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1
COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /opt/kokoro-model /opt/kokoro-model
COPY LICENSE /usr/share/licenses/kairos/LICENSE
COPY services/kokoro/NOTICE /usr/share/licenses/kairos-kokoro/NOTICE

USER appuser
EXPOSE 8050
CMD ["python", "-m", "kairos_kokoro.main"]

ARG KAIROS_GIT_SHA=unknown
ENV KAIROS_GIT_SHA=$KAIROS_GIT_SHA
