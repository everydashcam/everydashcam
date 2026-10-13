# Self-build image: builds the app from this clone, serves it with nginx
# (docs/self-hosting.md):
#   docker build -t everydashcam .
#   docker run -d -p 8080:80 everydashcam
# The prebuilt image at ghcr.io/everydashcam/everydashcam is NOT built from this
# file: the release workflow packages its already-built (and attested) dist/
# via docker/Dockerfile.prebuilt, so the image and the release archives are
# one artifact.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# nginx.conf sends no CSP header, so deliver the CSP as a <meta> tag
# (vite-plugins/csp-hash.ts) - same flavor the release artifact ships.
ENV META_CSP=1
ARG VITE_YANDEX_TILES_API_KEY
ARG VITE_DEFAULT_MAP_PROVIDER
RUN npm run build

FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
