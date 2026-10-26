# アプリ一式の箱（画面＋API＋描画）。どこのサーバーでも、この1つを動かせば使える。
#   docker build -f docker/app/Dockerfile -t slidegen-app .
#   docker run -p 8787:8787 -v slidegen-data:/data -e SLIDEGEN_PASSWORD=… slidegen-app
# 描画は箱の中の LibreOffice で行う（SLIDEGEN_RENDER=local）。字体は fonts/ の静的フォントだけ（描画用の箱と同じ）。
FROM node:22.20.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx vite build web && npm prune --omit=dev && npm i --no-save tsx@4.23.15

FROM node:22.20.0-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends libreoffice-impress-nogui poppler-utils fontconfig fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*
COPY fonts/ /usr/share/fonts/slidegen/
RUN fc-cache -f
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /data && chown node:node /data
ENV SLIDEGEN_RENDER=local SLIDEGEN_DATA=/data HOST=0.0.0.0 PORT=8787 NODE_ENV=production
VOLUME /data
EXPOSE 8787
USER node
CMD ["npx", "tsx", "src/app/server.ts"]
