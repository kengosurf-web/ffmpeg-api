import express from "express";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import axios from "axios";
import path from "path";

const app = express();
app.use(express.json({ limit: "10mb" }));

ffmpeg.setFfmpegPath("/usr/bin/ffmpeg");

// URL からファイルをダウンロードして保存する関数
async function downloadFile(url, outputPath) {
  const response = await axios({
    url,
    method: "GET",
    responseType: "arraybuffer",
    headers: {
      "User-Agent": "Mozilla/5.0" // GitHub raw 対策
    }
  });

  fs.writeFileSync(outputPath, response.data);
  return outputPath;
}

app.post("/concat", async (req, res) => {
  try {
    const { factUrl, opinionUrl } = req.body;

    if (!factUrl || !opinionUrl) {
      return res.status(400).send("Missing factUrl or opinionUrl");
    }

    // 一時フォルダ
    if (!fs.existsSync("tmp")) fs.mkdirSync("tmp");

    const factPath = path.join("tmp", `fact_${Date.now()}.mp3`);
    const opinionPath = path.join("tmp", `opinion_${Date.now()}.mp3`);
    const outputPath = path.join("tmp", `merged_${Date.now()}.mp3`);

    // ① URL から音声をダウンロード
    await downloadFile(factUrl, factPath);
    await downloadFile(opinionUrl, opinionPath);

    // ② ffmpeg で連結
    ffmpeg()
      .input(factPath)
      .input(opinionPath)
      .on("start", cmd => console.log("FFmpeg:", cmd))
      .on("error", err => {
        console.error("FFmpeg error:", err);
        res.status(500).send("Error processing audio");
      })
      .on("end", () => {
        console.log("FFmpeg finished:", outputPath);

        const file = fs.readFileSync(outputPath);
        res.setHeader("Content-Type", "audio/mpeg");
        res.send(file);

        // 一時ファイル削除
        fs.unlinkSync(factPath);
        fs.unlinkSync(opinionPath);
        fs.unlinkSync(outputPath);
      })
      .mergeToFile(outputPath);

  } catch (err) {
    console.error("Server error:", err);
    res.status(500).send("Server error");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));