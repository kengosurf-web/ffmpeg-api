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

# ポート（Koyeb は 8000 にフォワードする）
EXPOSE 3000

# サーバー起動
CMD ["node", "server.js"]