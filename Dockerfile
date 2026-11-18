# syntax=docker/dockerfile:1

# The simulator's image: the production build of packages/app, served by an unprivileged nginx (deploy/README.md).
#   docker build -t mpc-simulator .

# ---- build ----
FROM node:24-slim AS build
WORKDIR /src

# The manifests first: the install layer stays cached until a dependency changes.
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/worker/package.json packages/worker/
COPY packages/cli/package.json packages/cli/
COPY packages/app/package.json packages/app/
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts

COPY . .
RUN npm run build

# Compressed once, here: nginx serves the .gz files as they are (gzip_static) and spends no CPU per request.
RUN find packages/app/dist -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.svg' -o -name '*.glb' -o -name '*.txt' \) -exec gzip -9 -k -f {} +

# ---- serve ----
FROM nginxinc/nginx-unprivileged:stable-alpine
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /src/packages/app/dist /usr/share/nginx/html

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
