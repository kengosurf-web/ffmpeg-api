import express from "express";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// ------------------------------
// GitHub Raw 対策：URL から mp3 を安全に取得
// ------------------------------
async function fetchAudioWithRetry(url, maxRetries = 5) {
  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        timeout: 15000,
      });

      const contentType = res.headers.get("content-type") || "";

      // HTML → 即リトライ
      if (contentType.includes("text/html")) {
        console.log(`HTML detected on attempt ${attempt + 1}, retrying...`);
        await wait(300 + attempt * 200);
        attempt++;
        continue;
      }

      // バイナリ取得
      const buffer = Buffer.from(await res.arrayBuffer());

      // 0バイト → リトライ
      if (buffer.length === 0) {
        console.log(`0-byte buffer on attempt ${attempt + 1}, retrying...`);
        await wait(300 + attempt * 200);
        attempt++;
        continue;
      }

      // mp3 以外 → リトライ
      if (!contentType.includes("audio")) {
        console.log(`Non-audio content-type (${contentType}) on attempt ${attempt + 1}, retrying...`);
        await wait(300 + attempt * 200);
        attempt++;
        continue;
      }

      // 成功
      return buffer;

    } catch (err) {
      console.log(`Fetch error on attempt ${attempt + 1}:`, err.message);
      await wait(300 + attempt * 200);
      attempt++;
    }
  }

  throw new Error("Failed to fetch audio after multiple retries");
}

// 待機関数
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------
// /merge (URL方式)
// ------------------------------
app.post("/merge", async (req, res) => {
  try {
    const { factUrl, opinionUrl } = req.body;

    if (!factUrl || !opinionUrl) {
      return res.status(400).json({
        error: "Missing factUrl or opinionUrl",
      });
    }

    console.log("Fetching audio files...");

    // URL から mp3 を取得（リトライ付き）
    const factBuffer = await fetchAudioWithRetry(factUrl);
    const opinionBuffer = await fetchAudioWithRetry(opinionUrl);

    // 一時ファイル
    const factPath = `/tmp/fact-${uuidv4()}.mp3`;
    const opinionPath = `/tmp/opinion-${uuidv4()}.mp3`;
    const outputPath = `/tmp/output-${uuidv4()}.mp3`;

    // 保存
    fs.writeFileSync(factPath, factBuffer);
    fs.writeFileSync(opinionPath, opinionBuffer);

    // ffmpeg 結合
    ffmpeg()
      .input(factPath)
      .input(opinionPath)
      .on("end", () => {
        try {
          const file = fs.readFileSync(outputPath);
          res.setHeader("Content-Type", "audio/mpeg");
          res.send(file);
        } finally {
          fs.unlinkSync(factPath);
          fs.unlinkSync(opinionPath);
          fs.unlinkSync(outputPath);
        }
      })
      .on("error", (err) => {
        console.error("FFMPEG ERROR:", err);
        res.status(500).json({
          error: "ffmpeg error",
          detail: err.message,
        });
      })
      .mergeToFile(outputPath);

  } catch (err) {
    console.error("SERVER ERROR:", err);
    res.status(500).json({
      error: err.message || "Server error",
    });
  }
});

// ------------------------------
// Koyeb ポート
// ------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});