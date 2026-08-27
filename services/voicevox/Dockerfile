# syntax=docker/dockerfile:1@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89
# Optional local neural Japanese TTS. The upstream multi-arch image is pinned so
# an offline delivery archive always contains the exact model/runtime tested.
FROM voicevox/voicevox_engine:cpu-ubuntu22.04-0.25.2@sha256:148b7ade1e698893d8722b6bbd92c059f8796b4ab45449cf45e0601369e63455

ARG KAIROS_GIT_SHA=unknown
LABEL org.opencontainers.image.revision=$KAIROS_GIT_SHA
