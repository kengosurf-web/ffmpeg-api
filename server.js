
import express from "express";
import multer from "multer";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";

// uploads フォルダが無ければ作成
if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

const app = express();
const upload = multer({ dest: "uploads/" });

// テスト用エンドポイント
app.get("/test", (req, res) => {
  res.send("API is working");
});

// Render の ffmpeg を使用
ffmpeg.setFfmpegPath("/usr/bin/ffmpeg");

// ffmpeg パス確認（安全な方法）
console.log("FFmpeg path set to /usr/bin/ffmpeg");

app.post(
  "/concat",
  upload.fields([
    { name: "factAudio", maxCount: 1 },
    { name: "opinionAudio", maxCount: 1 }
  ]),
  (req, res) => {
    const fact = req.files["factAudio"][0].path;
    const opinion = req.files["opinionAudio"][0].path;

    const output = `uploads/merged_${Date.now()}.mp3`;

    ffmpeg()
      .input(fact)
      .input(opinion)
      .on("start", (cmd) => {
        console.log("FFmpeg started:", cmd);
      })
      .on("error", (err) => {
        console.error("FFmpeg error:", err);
        res.status(500).send("Error processing audio");
      })
      .on("end", () => {
        console.log("FFmpeg finished:", output);

        const file = fs.readFileSync(output);
        res.setHeader("Content-Type", "audio/mpeg");
        res.send(file);

        fs.unlinkSync(fact);
        fs.unlinkSync(opinion);
        fs.unlinkSync(output);
      })
      .mergeToFile(output);
  }
);

// ⭐⭐⭐ ここが最重要修正ポイント ⭐⭐⭐
// Koyeb は PORT=8000 を環境変数で渡すので、必ず process.env.PORT を使う
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`FFmpeg API running on port ${PORT}`);
});