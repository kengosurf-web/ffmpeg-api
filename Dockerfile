FROM jrottenberg/ffmpeg:4.4-alpine AS ffmpeg

FROM node:18-alpine

# cache-bust-1

WORKDIR /app

# ffmpeg と必要なライブラリをコピー
COPY --from=ffmpeg /usr/local/bin/ffmpeg /usr/local/bin/
COPY --from=ffmpeg /usr/local/bin/ffprobe /usr/local/bin/
COPY --from=ffmpeg /usr/local/lib /usr/local/lib   # ← これが必要！

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 8000

CMD ["node", "server.js"]

