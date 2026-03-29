import express from "express";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";

// uploads フォルダが無ければ作成
if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

const app = express();

// JSON の受け取りを許可（50MBまで）
app.use(express.json({ limit: "50mb" }));

// テスト用エンドポイント
app.get("/test", (req, res) => {
  res.send("API is working");
});

// Render / Koyeb の ffmpeg を使用
ffmpeg.setFfmpegPath("/usr/bin/ffmpeg");
console.log("FFmpeg path set to /usr/bin/ffmpeg");

app.post("/concat", async (req, res) => {
  try {
    const { factBase64, opinionBase64 } = req.body;

    if (!factBase64 || !opinionBase64) {
      return res.status(400).send("Missing audio data");
    }

    // 一時ファイルとして保存
    const factPath = `uploads/fact_${Date.now()}.mp3`;
    const opinionPath = `uploads/opinion_${Date.now()}.mp3`;
    const output = `uploads/merged_${Date.now()}.mp3`;

    fs.writeFileSync(factPath, Buffer.from(factBase64, "base64"));
    fs.writeFileSync(opinionPath, Buffer.from(opinionBase64, "base64"));

    ffmpeg()
      .input(factPath)
      .input(opinionPath)
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

        fs.unlinkSync(factPath);
        fs.unlinkSync(opinionPath);
        fs.unlinkSync(output);
      })
      .mergeToFile(output);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});

// Koyeb は PORT=8000 を環境変数で渡す
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`FFmpeg API running on port ${PORT}`);
});