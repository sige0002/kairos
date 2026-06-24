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
COPY services/frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
CMD ["nginx", "-g", "daemon off;"]
