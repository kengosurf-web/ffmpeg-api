import express from "express";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import fetch from "node-fetch";
import axios from "axios";

const app = express();
app.use(express.json({ limit: "200mb" }));

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
// Health Check（Koyeb が /clip を叩かないようにする）
// --------------------------------------------------
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

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
// FINAL RENDER URL（フェード入り最終連結API）
// --------------------------------------------------
async function downloadToBuffer(url) {
  const res = await axios.get(url, { responseType: "arraybuffer" });
  return Buffer.from(res.data);
}

async function downloadToTmp(url, filePath) {
  const buffer = await downloadToBuffer(url);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

app.post("/final-render-url", async (req, res) => {
  try {
    const clips = JSON.parse(req.body.clips.replace(/^=/, ""));

    if (!clips || !Array.isArray(clips)) {
      return res.status(400).json({
        error: "Missing or invalid clips array"
      });
    }

    console.log("Starting FINAL RENDER (URL version)...");

    const id = uuidv4();
    const concatListPath = `/tmp/list-${id}.txt`;
    const concatOutput = `/tmp/concat-${id}.mp4`;
    const finalOutput = `/tmp/final-${id}.mp4`;

    let concatList = "";

    for (const clip of clips) {
      const clipId = clip.clipId;

      const bgPath = `/tmp/bg-${clipId}.mp4`;
      const audioPath = `/tmp/audio-${clipId}.mp3`;
      const subtitlePath = `/tmp/sub-${clipId}.png`;
      const outPath = `/tmp/clip-${clipId}.mp4`;

      await downloadToTmp(clip.backgroundVideo, bgPath);
      await downloadToTmp(clip.audioUrl, audioPath);
      await downloadToTmp(clip.subtitlePng, subtitlePath);

      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(bgPath)
          .input(audioPath)
          .input(subtitlePath)
          .complexFilter([
            "[0:v][2:v] overlay=(main_w-overlay_w)/2:(main_h-overlay_h)-50"
          ])
          .outputOptions([
            "-c:v libx264",
            "-c:a aac",
            "-pix_fmt yuv420p"
          ])
          .save(outPath)
          .on("end", resolve)
          .on("error", reject);
      });

      concatList += `file '${outPath}'\n`;
    }

    fs.writeFileSync(concatListPath, concatList);

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatListPath)
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

    fs.unlinkSync(concatListPath);
    fs.unlinkSync(concatOutput);
    fs.unlinkSync(finalOutput);

    for (const clip of clips) {
      const clipId = clip.clipId;
      fs.unlinkSync(`/tmp/bg-${clipId}.mp4`);
      fs.unlinkSync(`/tmp/audio-${clipId}.mp3`);
      fs.unlinkSync(`/tmp/sub-${clipId}.png`);
      fs.unlinkSync(`/tmp/clip-${clipId}.mp4`);
    }

  } catch (err) {
    console.error("SERVER ERROR (/final-render-url):", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// --------------------------------------------------
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});