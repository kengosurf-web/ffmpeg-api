import express from "express";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";

const app = express();

// JSON を受け取る（URL だけ渡す）
app.use(express.json({ limit: "5mb" }));

// テスト用
app.get("/test", (req, res) => {
  res.send("FFmpeg URL concat API is working");
});

// Koyeb / Render の ffmpeg パス
ffmpeg.setFfmpegPath("/usr/bin/ffmpeg");
console.log("FFmpeg path set to /usr/bin/ffmpeg");

app.post("/concat", async (req, res) => {
  try {
    const { factUrl, opinionUrl } = req.body;

    if (!factUrl || !opinionUrl) {
      return res.status(400).send("Missing factUrl or opinionUrl");
    }

    // 一時出力ファイル
    if (!fs.existsSync("uploads")) {
      fs.mkdirSync("uploads");
    }
    const output = `uploads/merged_${Date.now()}.mp3`;

    ffmpeg()
      .input(factUrl)      // ← GitHub などの URL
      .input(opinionUrl)   // ← GitHub などの URL
      .on("start", cmd => {
        console.log("FFmpeg started:", cmd);
      })
      .on("error", err => {
        console.error("FFmpeg error:", err);
        if (fs.existsSync(output)) fs.unlinkSync(output);
        res.status(500).send("Error processing audio");
      })
      .on("end", () => {
        console.log("FFmpeg finished:", output);

        const file = fs.readFileSync(output);
        res.setHeader("Content-Type", "audio/mpeg");
        res.send(file);

        fs.unlinkSync(output);
      })
      .mergeToFile(output);
  } catch (err) {
    console.error("Server error:", err);
    res.status(500).send("Server error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`FFmpeg URL concat API running on port ${PORT}`);
});