# syntax=docker/dockerfile:1
# frontend — Vite + React + TS. Multi-stage: build static assets with node,
# then serve them with nginx (which also reverse-proxies /api to the
# orchestrator so the browser talks to a single origin).

# ---- build ------------------------------------------------------------------
FROM node:22-slim AS build
WORKDIR /app
COPY services/frontend/package.json ./
# No lockfile committed yet (Stage 0); resolve from package.json.
RUN npm install
COPY services/frontend/ ./
RUN npm run build

# ---- serve ------------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime
# nginx envsubst template: the image entrypoint expands ${FRONTEND_PORT} /
# ${API_ORCH_PORT} / ${WEBRTC_PORT} (passed by compose.yaml) into
# /etc/nginx/conf.d/default.conf at startup, so ports stay driven by .env /
# settings.py instead of being hardcoded in the served config.
COPY services/frontend/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
