import express from "express";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import fetch from "node-fetch";

const app = express();
app.use(express.json());

// --------------------------------------------------
// GitHub Raw 対策（HTML/0byte/非バイナリをリトライ）
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
// /clip（★新構造：1文クリップ生成API）
// --------------------------------------------------
app.post("/clip", async (req, res) => {
  try {
    const { subtitlePng, audioUrl, backgroundVideo } = req.body;

    if (!subtitlePng || !audioUrl || !backgroundVideo) {
      return res.status(400).json({
        error: "Missing subtitlePng, audioUrl, or backgroundVideo"
      });
    }

    console.log("Generating 1-sentence clip...");

    const id = uuidv4();

    // 一時ファイル
    const bgPath = `/tmp/bg-${id}.mp4`;
    const audioPath = `/tmp/audio-${id}.mp3`;
    const subtitlePath = `/tmp/sub-${id}.png`;
    const outputPath = `/tmp/clip-${id}.mp4`;

    // GitHub API → raw URL に変換
    let audioDownloadUrl = audioUrl;
    if (audioUrl.includes("api.github.com")) {
      audioDownloadUrl = audioUrl
        .replace("api.github.com/repos", "raw.githubusercontent.com")
        .replace("/contents/", "/")
        .replace("?ref=main", "");
    }

    // ダウンロード
    const bgBuffer = await fetchBinaryWithRetry(backgroundVideo);
    fs.writeFileSync(bgPath, bgBuffer);

    const audioBuffer = await fetchBinaryWithRetry(audioDownloadUrl);
    fs.writeFileSync(audioPath, audioBuffer);

    const subBuffer = await fetchBinaryWithRetry(subtitlePng);
    fs.writeFileSync(subtitlePath, subBuffer);

    // 音声の長さを取得（背景を同じ長さにするため）
    const audioDuration = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(audioPath, (err, metadata) => {
        if (err) reject(err);
        else resolve(metadata.format.duration);
      });
    });

    // ffmpeg 合成（背景を音声と同じ長さに強制 + 字幕を50%縮小）
    ffmpeg()
      .input(bgPath)
      .inputOptions([`-t ${audioDuration}`])   // ★背景を音声と同じ長さに強制
      .input(audioPath)
      .input(subtitlePath)
      .complexFilter([
        // ★字幕PNGを50%縮小
        {
          filter: "scale",
          options: { w: "iw*0.5", h: "ih*0.5" },
          inputs: "2:v",
          outputs: "sub_scaled"
        },
        // ★字幕を画面下に配置（Y位置はそのまま）
        {
          filter: "overlay",
          inputs: ["0:v", "sub_scaled"],
          options: {
            x: "(W-w)/2",
            y: "H-h-80"
          }
        }
      ])
      .outputOptions([
        "-c:v libx264",
        "-c:a aac",
        "-pix_fmt yuv420p",
        "-shortest"
      ])
      .save(outputPath)
      .on("end", () => {
        try {
          const file = fs.readFileSync(outputPath);
          res.setHeader("Content-Type", "video/mp4");
          res.send(file);
        } finally {
          fs.unlinkSync(bgPath);
          fs.unlinkSync(audioPath);
          fs.unlinkSync(subtitlePath);
          fs.unlinkSync(outputPath);
        }
      })
      .on("error", (err) => {
        console.error("FFMPEG ERROR (/clip):", err);
        res.status(500).json({ error: "ffmpeg error", detail: err.message });
      });

  } catch (err) {
    console.error("SERVER ERROR (/clip):", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// --------------------------------------------------
// /render（★旧構造：タイムライン方式）
// → 後で削除予定のため “旧JS” と明記
// --------------------------------------------------
app.post("/render", async (req, res) => {
  try {
    let body = req.body;
    if (Array.isArray(body)) body = body[0];

    const { background, audio, top, bottom, subtitles } = body;

    if (!background || !audio || !top || !bottom || !Array.isArray(subtitles)) {
      return res.status(400).json({
        error: "Missing background, audio, top, bottom, or subtitles"
      });
    }

    console.log("Downloading assets... (OLD RENDER)");

    // 背景
    const bgBuffer = await fetchBinaryWithRetry(background);
    const bgPath = `/tmp/bg-${uuidv4()}.mp4`;
    fs.writeFileSync(bgPath, bgBuffer);

    // 音声
    const audioBuffer = await fetchBinaryWithRetry(audio);
    const audioPath = `/tmp/audio-${uuidv4()}.mp3`;
    fs.writeFileSync(audioPath, audioBuffer);

    // トップ画像
    const topBuffer = await fetchBinaryWithRetry(top);
    const topPath = `/tmp/top-${uuidv4()}.png`;
    fs.writeFileSync(topPath, topBuffer);

    // ボトム画像
    const bottomBuffer = await fetchBinaryWithRetry(bottom);
    const bottomPath = `/tmp/bottom-${uuidv4()}.png`;
    fs.writeFileSync(bottomPath, bottomBuffer);

    // 字幕 PNG
    const pngPaths = [];
    for (const sub of subtitles) {
      const buf = await fetchBinaryWithRetry(sub.url);
      const p = `/tmp/sub-${uuidv4()}.png`;
      fs.writeFileSync(p, buf);
      pngPaths.push({ path: p, start: sub.start, length: sub.length });
    }

    const outputPath = `/tmp/video-${uuidv4()}.mp4`;

    // --------------------------------------------------
    // 字幕 overlay（旧構造）
    // --------------------------------------------------
    const filter = [];

    filter.push({
      filter: "null",
      inputs: "0:v",
      outputs: "base"
    });

    filter.push({
      filter: "overlay",
      inputs: ["base", "2:v"],
      options: { x: "(W-w)/2", y: "0" },
      outputs: "v_top"
    });

    filter.push({
      filter: "overlay",
      inputs: ["v_top", "3:v"],
      options: { x: "(W-w)/2", y: "H-h" },
      outputs: "v_tb"
    });

    let lastLabel = "v_tb";

    pngPaths.forEach((sub, i) => {
      const label = `v_sub_${i}`;
      filter.push({
        filter: "overlay",
        inputs: [lastLabel, `${i + 4}:v`],
        options: {
          x: "(W-w)/2",
          y: "H-h-288",
          enable: `between(t,${sub.start},${sub.start + sub.length})`
        },
        outputs: label
      });
      lastLabel = label;
    });

    const command = ffmpeg()
      .input(bgPath)
      .input(audioPath)
      .input(topPath)
      .input(bottomPath);

    pngPaths.forEach((p) => command.input(p.path));

    command
      .complexFilter(filter)
      .outputOptions([
        "-map", `[${lastLabel}]`,
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
          fs.unlinkSync(topPath);
          fs.unlinkSync(bottomPath);
          fs.unlinkSync(outputPath);
          pngPaths.forEach((p) => fs.unlinkSync(p.path));
        }
      })
      .on("error", (err) => {
        console.error("FFMPEG ERROR (OLD RENDER):", err);
        res.status(500).json({ error: "ffmpeg error", detail: err.message });
      })
      .save(outputPath);

  } catch (err) {
    console.error("SERVER ERROR (OLD RENDER):", err);
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
