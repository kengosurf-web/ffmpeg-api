FROM node:18

# ffmpeg をインストール
RUN apt-get update && apt-get install -y ffmpeg

# 作業ディレクトリ
WORKDIR /app

# 依存関係をインストール
COPY package.json .
RUN npm install

# 残りのファイルをコピー
COPY . .

# ★ Koyeb は 8000 を使うので必ず 8000 を公開
EXPOSE 8000

# サーバー起動
CMD ["node", "server.js"]
