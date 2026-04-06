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
// /clip（1文クリップ生成API）
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

    const bgPath = `/tmp/bg-${id}.mp4`;
    const audioPath = `/tmp/audio-${id}.mp3`;
    const subtitlePath = `/tmp/sub-${id}.png`;
    const outputPath = `/tmp/clip-${id}.mp4`;

    let audioDownloadUrl = audioUrl;
    if (audioUrl.includes("api.github.com")) {
      audioDownloadUrl = audioUrl
        .replace("api.github.com/repos", "raw.githubusercontent.com")
        .replace("/contents/", "/")
        .replace("?ref=main", "");
    }

    const bgBuffer = await fetchBinaryWithRetry(backgroundVideo);
    fs.writeFileSync(bgPath, bgBuffer);

    const audioBuffer = await fetchBinaryWithRetry(audioDownloadUrl);
    fs.writeFileSync(audioPath, audioBuffer);

    const subBuffer = await fetchBinaryWithRetry(subtitlePng);
    fs.writeFileSync(subtitlePath, subBuffer);

    const audioDuration = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(audioPath, (err, metadata) => {
        if (err) reject(err);
        else resolve(metadata.format.duration);
      });
    });

    ffmpeg()
      .input(bgPath)
      .input(audioPath)
      .input(subtitlePath)
      .complexFilter([
        {
          filter: "scale",
          options: { w: "iw*0.5", h: "ih*0.5" },
          inputs: "[2:v]",
          outputs: "sub_scaled"
        },
        {
          filter: "overlay",
          inputs: ["[0:v]", "sub_scaled"],
          options: {
            x: "(W-w)/2",
            y: "H-h-80"
          }
        }
      ])
      .outputOptions([
        "-map 0:v",
        "-map 1:a",
        "-c:v libx264",
        "-c:a aac",
        "-pix_fmt yuv420p",
        `-t ${audioDuration}`,
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
// /final-render（フェード入り最終連結API）
// --------------------------------------------------
app.post("/final-render", async (req, res) => {
  try {
    const { concatList } = req.body;
    const files = req.files;

    if (!concatList || !files) {
      return res.status(400).json({
        error: "Missing concatList or binary clips"
      });
    }

    console.log("Starting FINAL RENDER with fade...");

    const id = uuidv4();
    const listPath = `/tmp/list-${id}.txt`;
    const concatOutput = `/tmp/concat-${id}.mp4`;
    const finalOutput = `/tmp/final-${id}.mp4`;

    const clipKeys = Object.keys(files);

    for (const key of clipKeys) {
      const filePath = `/tmp/${key}.mp4`;
      fs.writeFileSync(filePath, files[key].data);
    }

    fs.writeFileSync(listPath, concatList);

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(listPath)
        .inputOptions(["-f concat", "-safe 0"])
        .outputOptions(["-c copy"])
        .save(concatOutput)
        .on("end", resolve)
        .on("error", reject);
    });

    const duration = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(concatOutput, (err, metadata) => {
        if (err) reject(err);
        else resolve(metadata.format.duration);
      });
    });

    const fadeInSec = 0.8;
    const fadeOutSec = 0.8;

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatOutput)
        .videoFilters([
          `fade=t=in:st=0:d=${fadeInSec}`,
          `fade=t=out:st=${duration - fadeOutSec}:d=${fadeOutSec}`
        ])
        .audioFilters([
          `afade=t=in:st=0:d=${fadeInSec}`,
          `afade=t=out:st=${duration - fadeOutSec}:d=${fadeOutSec}`
        ])
        .outputOptions([
          "-c:v libx264",
          "-c:a aac",
          "-pix_fmt yuv420p"
        ])
        .save(finalOutput)
        .on("end", resolve)
        .on("error", reject);
    });

    const finalBuffer = fs.readFileSync(finalOutput);
    res.setHeader("Content-Type", "video/mp4");
    res.send(finalBuffer);

    fs.unlinkSync(listPath);
    fs.unlinkSync(concatOutput);
    fs.unlinkSync(finalOutput);
    for (const key of clipKeys) {
      fs.unlinkSync(`/tmp/${key}.mp4`);
    }

  } catch (err) {
    console.error("SERVER ERROR (/final-render):", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// --------------------------------------------------
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});
