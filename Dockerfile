FROM jrottenberg/ffmpeg:4.4-alpine AS ffmpeg

FROM node:18-alpine

WORKDIR /app

# ffmpeg をコピー
COPY --from=ffmpeg /usr/local/bin/ffmpeg /usr/local/bin/
COPY --from=ffmpeg /usr/local/bin/ffprobe /usr/local/bin/

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 8000

CMD ["node", "server.js"]
