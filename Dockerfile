FROM node:18

# 作業ディレクトリ
WORKDIR /app

# 依存関係をインストール
COPY package*.json ./
RUN npm install

# 残りのファイルをコピー
COPY . .

# Koyeb は 8000 を使う
EXPOSE 8000

# サーバー起動
CMD ["node", "server.js"]
