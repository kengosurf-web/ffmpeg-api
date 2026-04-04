import express from "express";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// --------------------------------------------------
// 共通：GitHub Raw 対策（HTML/0byte/非バイナリをリトライ）
// --------------------------------------------------
async function fetchBinaryWithRetry(url, maxRetries = 5) {
  let attempt = 0;

  while (attempt < maxRetries) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        timeout: 15000,
      });

      const contentType = res.headers.get("content-type") || "";

      if (contentType.includes("text/html")) {
        console.log(`HTML detected on attempt ${attempt + 1}, retrying...`);
        await wait(300 + attempt * 200);
        attempt++;
        continue;
      }

      const buffer = Buffer.from(await res.arrayBuffer());

      if (buffer.length === 0) {
        console.log(`0-byte buffer on attempt ${attempt + 1}, retrying...`);
        await wait(300 + attempt * 200);
        attempt++;
        continue;
      }

      return buffer;

    } catch (err) {
      console.log(`Fetch error on attempt ${attempt + 1}:`, err.message);
      await wait(300 + attempt * 200);
      attempt++;
    }
  }

  throw new Error("Failed to fetch binary after multiple retries");
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --------------------------------------------------
// /merge（音声連結API）
// --------------------------------------------------
app.post("/merge", async (req, res) => {
  try {
    const { factUrl, opinionUrl } = req.body;

    if (!factUrl || !opinionUrl) {
      return res.status(400).json({ error: "Missing factUrl or opinionUrl" });
    }

    console.log("Fetching audio files...");

    const factBuffer = await fetchBinaryWithRetry(factUrl);
    const opinionBuffer = await fetchBinaryWithRetry(opinionUrl);

    const factPath = `/tmp/fact-${uuidv4()}.mp3`;
    const opinionPath = `/tmp/opinion-${uuidv4()}.mp3`;
    const outputPath = `/tmp/output-${uuidv4()}.mp3`;

    fs.writeFileSync(factPath, factBuffer);
    fs.writeFileSync(opinionPath, opinionBuffer);

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
        res.status(500).json({ error: "ffmpeg error", detail: err.message });
      })
      .mergeToFile(outputPath);

  } catch (err) {
    console.error("SERVER ERROR:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// --------------------------------------------------
// /render（動画レンダーAPI）
// --------------------------------------------------
app.post("/render", async (req, res) => {
  try {
    // ★★★ ここが唯一の変更点 ★★★
    let body = req.body;
    if (Array.isArray(body)) {
      body = body[0];
    }
    const { background, audio, subtitles } = body;
    // ★★★★★★★★★★★★★★★★★★★★

    if (!background || !audio || !Array.isArray(subtitles)) {
      return res.status(400).json({
        error: "Missing background, audio, or subtitles"
      });
    }

    console.log("Downloading assets...");

    const bgBuffer = await fetchBinaryWithRetry(background);
    const bgPath = `/tmp/bg-${uuidv4()}.mp4`;
    fs.writeFileSync(bgPath, bgBuffer);

    const audioBuffer = await fetchBinaryWithRetry(audio);
    const audioPath = `/tmp/audio-${uuidv4()}.mp3`;
    fs.writeFileSync(audioPath, audioBuffer);

    const pngPaths = [];
    for (const sub of subtitles) {
      const buf = await fetchBinaryWithRetry(sub.url);
      const p = `/tmp/sub-${uuidv4()}.png`;
      fs.writeFileSync(p, buf);
      pngPaths.push({ path: p, start: sub.start, length: sub.length });
    }

    const outputPath = `/tmp/video-${uuidv4()}.mp4`;

    let filter = "";
    let lastLabel = "[0:v]";

    pngPaths.forEach((sub, i) => {
      const label = `[v${i + 1}]`;
      const x = "(W-w)/2";
      const y = "H-h-288";

      filter += `${lastLabel}[${i + 1}:v] overlay=${x}:${y}:enable='between(t,${sub.start},${sub.start + sub.length})' ${label};`;
      lastLabel = label;
    });

    const command = ffmpeg()
      .input(bgPath)
      .input(audioPath);

    pngPaths.forEach((p) => command.input(p.path));

    command
      .complexFilter(filter, lastLabel.replace("]", "").replace("[", ""))
      .outputOptions([
        "-map", `${lastLabel.replace("[", "").replace("]", "")}`,
        "-map", "1:a",
        "-c:v", "libx264",
        "-c:a", "aac",
        "-pix_fmt", "yuv420p",
        "-preset", "veryfast",
        "-shortest"
      ])
      .on("end", () => {
        try {
          const file = fs.readFileSync(outputPath);
          res.setHeader("Content-Type", "video/mp4");
          res.send(file);
        } finally {
          fs.unlinkSync(bgPath);
          fs.unlinkSync(audioPath);
          fs.unlinkSync(outputPath);
          pngPaths.forEach((p) => fs.unlinkSync(p.path));
        }
      })
      .on("error", (err) => {
        console.error("FFMPEG ERROR:", err);
        res.status(500).json({ error: "ffmpeg error", detail: err.message });
      })
      .save(outputPath);

  } catch (err) {
    console.error("SERVER ERROR:", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// --------------------------------------------------
// Koyeb ポート
// --------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});

