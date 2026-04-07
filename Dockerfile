FROM linuxserver/ffmpeg:latest as ffmpeg

FROM node:18

# cache-bust-9

WORKDIR /app

COPY --from=ffmpeg /usr/bin/ffmpeg /usr/local/bin/
COPY --from=ffmpeg /usr/bin/ffprobe /usr/local/bin/

COPY package*.json ./
RUN npm install

COPY . .

EXPOSE 8000

CMD ["node", "server.js"]
