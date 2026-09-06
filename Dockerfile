# Бөхийн таавар — вэб апп + сервер нэг image дотор (bigtwo-ийн загвар).
# Render, Fly.io, Railway, ямар ч Docker дэмждэг газарт ажиллана.

# ── 1-р шат: Expo вэб хувилбар ─────────────────────────────────────────────
FROM node:24-slim AS web
ENV CI=1 EXPO_NO_TELEMETRY=1
WORKDIR /src/app
COPY app/package.json app/package-lock.json ./
RUN npm ci
COPY app/ ./
RUN npm run build:web

# ── 2-р шат: сервер (Node 24 — .ts-ийг шууд ажиллуулна) ────────────────────
FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /srv
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY server ./server
COPY app/src/shared ./app/src/shared
COPY --from=web /src/app/dist ./app/dist
# devjee архив (243к барилдаан, 21 870 бөх) — git-д gzip-ээр (archive/, ≈10 MB); эндээс задалж
# data/devjee-д тавина → сервер эхлэхэд хоорондын харьцаа, бүх бөхийн импорт, архивын Elo ажиллана.
COPY archive ./archive
RUN mkdir -p data/devjee \
 && for f in archive/*.gz; do gunzip -c "$f" > "data/devjee/$(basename "$f" .gz)"; done \
 && cp archive/summary.json data/devjee/ && rm -rf archive
# Архив + Engine ≈ 130 MB heap; heap-ийн дээд хязгаарыг тогтоож RSS-ийг 512 MB (free/starter) дотор барина
ENV NODE_OPTIONS=--max-old-space-size=384
ENV PORT=8787
EXPOSE 8787
CMD ["node", "server/index.ts"]
