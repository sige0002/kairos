# syntax=docker/dockerfile:1
# frontend — Vite + React + TS. Multi-stage: build static assets with node,
# then serve them with nginx (which also reverse-proxies /api to the
# orchestrator so the browser talks to a single origin).

# ---- build ------------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app
# Copy the manifest AND the committed lockfile, then install from the lockfile
# (`npm ci`) for a reproducible, pinned build (fails if they disagree).
COPY services/frontend/package.json services/frontend/package-lock.json ./
RUN npm ci
COPY services/frontend/ ./
RUN npm run build

# ---- serve ------------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime
# nginx envsubst template: the image entrypoint expands the ports
# (${FRONTEND_PORT} / ${API_ORCH_PORT} / ${WEBRTC_PORT} / ${TOPIC_PROBE_PORT})
# and the upstream hosts (${API_HOST} / ${WEBRTC_HOST} / ${PROBE_HOST}), all
# passed by compose.yaml, into /etc/nginx/conf.d/default.conf at startup — so
# ports/hosts stay driven by .env / settings.py instead of being hardcoded in
# the served config. Keep this list in sync with default.conf.template.
COPY services/frontend/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
