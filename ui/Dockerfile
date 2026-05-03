# syntax=docker/dockerfile:1

# === Build Stage ===
FROM node:20-alpine as builder

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install

# Build app
COPY . .
RUN npm run build

# === Runtime Stage ===
FROM nginx:alpine

# Copy built assets
COPY --from=builder /app/dist /usr/share/nginx/html

# nginx config is rendered from a template at container start so deployers can
# point /api/ at any backend (compose: http://api:8000, Helm: http://<release>-api:8000, etc.)
COPY nginx.conf.template /etc/nginx/templates/default.conf.template

ENV API_UPSTREAM=http://api:8000

EXPOSE 80

# nginx:alpine ships /docker-entrypoint.d/20-envsubst-on-templates.sh which
# substitutes env vars into anything in /etc/nginx/templates/ at startup.
CMD ["nginx", "-g", "daemon off;"]
