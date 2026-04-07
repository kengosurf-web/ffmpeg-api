import express from "express";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import fetch from "node-fetch";
import axios from "axios";

const app = express();
app.use(express.json({ limit: "200mb" }));

// ------------------------------
// Utility
// ------------------------------
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function downloadToBuffer(url) {
  const res = await axios.get(url, { responseType: "arraybuffer" });
  return Buffer.from(res.data);
}

async function downloadToTmp(url, filePath) {
  const buffer = await downloadToBuffer(url);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

// ------------------------------
// Global FFmpeg Job Queue
// ------------------------------
const ffmpegQueue = [];
let isProcessingQueue = false;

function enqueueFfmpegJob(jobFn) {
  return new Promise((resolve, reject) => {
    ffmpegQueue.push({ jobFn, resolve, reject });
    processNextFfmpegJob();
  });
}

async function processNextFfmpegJob() {
  if (isProcessingQueue) return;
  const item = ffmpegQueue.shift();
  if (!item) return;

  isProcessingQueue = true;
  const { jobFn, resolve, reject } = item;

  try {
    const result = await jobFn();
    resolve(result);
  } catch (err) {
    reject(err);
  } finally {
    isProcessingQueue = false;
    if (ffmpegQueue.length > 0) {
      processNextFfmpegJob();
    }
  }
}

// ------------------------------
// Health Check
// ------------------------------
app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

// ------------------------------
// /clip（1文クリップ生成API）
// ------------------------------
app.post("/clip", async (req, res) => {
  try {
    const { subtitlePng, audioUrl, backgroundVideo } = req.body;

    if (!subtitlePng || !audioUrl || !backgroundVideo) {
      return res.status(400).json({
        error: "Missing subtitlePng, audioUrl, or backgroundVideo",
      });
    }

    console.log("Generating 1-sentence clip...");

    const id = uuidv4();

    const bgPath = `/tmp/bg-${id}.mp4`;
    const audioPath = `/tmp/audio-${id}.mp3`;
    const subtitlePath = `/tmp/sub-${id}.png`;
    const outputPath = `/tmp/clip-${id}.mp4`;

    // GitHub URL 修正
    let audioDownloadUrl = audioUrl;
    if (audioUrl.includes("api.github.com")) {
      audioDownloadUrl = audioUrl
        .replace("api.github.com/repos", "raw.githubusercontent.com")
        .replace("/contents/", "/")
        .replace("?ref=main", "");
    }

    // ダウンロード
    fs.writeFileSync(bgPath, await fetchBinaryWithRetry(backgroundVideo));
    fs.writeFileSync(audioPath, await fetchBinaryWithRetry(audioDownloadUrl));
    fs.writeFileSync(subtitlePath, await fetchBinaryWithRetry(subtitlePng));

    // 音声の長さ
    const audioDuration = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(audioPath, (err, metadata) => {
        if (err) reject(err);
        else resolve(metadata.format.duration);
      });
    });

    // ffmpeg 実行（キュー経由）
    const clipBuffer = await enqueueFfmpegJob(() => {
      return new Promise((resolve, reject) => {
        ffmpeg()
          .input(bgPath)       // 0:v（音声は無視）
          .input(audioPath)    // 1:a（TTS）
          .input(subtitlePath) // 2:v（字幕PNG）
          .complexFilter([
            // 字幕縮小
            {
              filter: "scale",
              options: { w: "iw*0.5", h: "ih*0.5" },
              inputs: "[2:v]",
              outputs: "sub_scaled",
            },

            // 字幕 overlay
            {
              filter: "overlay",
              inputs: ["[0:v]", "sub_scaled"],
              options: {
                x: "(W-w)/2",
                y: "H-h-80",
              },
              outputs: "video",
            },
          ])
          .outputOptions([
            "-an",                // 背景動画の音声を完全ミュート
            "-map [video]",       // 映像
            "-map 1:a",           // TTS 音声のみ
            "-c:v libx264",
            "-c:a aac",
            "-pix_fmt yuv420p",
            `-t ${audioDuration}`,
            "-shortest",
          ])
          .save(outputPath)
          .on("end", () => {
            try {
              const file = fs.readFileSync(outputPath);
              resolve(file);
            } catch (e) {
              reject(e);
            } finally {
              try { fs.unlinkSync(bgPath); } catch {}
              try { fs.unlinkSync(audioPath); } catch {}
              try { fs.unlinkSync(subtitlePath); } catch {}
              try { fs.unlinkSync(outputPath); } catch {}
            }
          })
          .on("error", (err) => {
            console.error("FFMPEG ERROR (/clip):", err);
            try { fs.unlinkSync(bgPath); } catch {}
            try { fs.unlinkSync(audioPath); } catch {}
            try { fs.unlinkSync(subtitlePath); } catch {}
            try { fs.unlinkSync(outputPath); } catch {}
            reject(err);
          });
      });
    });

    res.setHeader("Content-Type", "video/mp4");
    res.send(clipBuffer);

  } catch (err) {
    console.error("SERVER ERROR (/clip):", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});


// ------------------------------
// 非同期ジョブ管理
// ------------------------------
const jobs = {}; // jobId → { status, outputPath }

// ------------------------------
// POST /final-render-url
// ------------------------------
app.post("/final-render-url", async (req, res) => {
  try {
    const clips = JSON.parse(req.body.clips.replace(/^=/, ""));

    if (!clips || !Array.isArray(clips)) {
      return res.status(400).json({ error: "Invalid clips array" });
    }

    const jobId = uuidv4();
    jobs[jobId] = { status: "processing", outputPath: null };

    console.log(`Job registered: ${jobId}`);

    enqueueFfmpegJob(() => processFinalRenderJob(jobId, clips))
      .catch((err) => {
        console.error("JOB ERROR (queued):", err);
        if (jobs[jobId]) {
          jobs[jobId].status = "error";
        }
      });

    res.json({
      jobId,
      status: "processing",
    });

  } catch (err) {
    console.error("SERVER ERROR (/final-render-url):", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// ------------------------------
// GET /final-render-status
// ------------------------------
app.get("/final-render-status", (req, res) => {
  const { jobId } = req.query;

  if (!jobId || !jobs[jobId]) {
    return res.status(404).json({ error: "Invalid jobId" });
  }

  const job = jobs[jobId];

  if (job.status === "done") {
    return res.json({
      jobId,
      status: "done",
      url: `/final-result/${jobId}`,
    });
  }

  res.json({
    jobId,
    status: job.status,
  });
});

// ------------------------------
// GET /final-result/:jobId
// ------------------------------
app.get("/final-result/:jobId", (req, res) => {
  const { jobId } = req.params;

  if (!jobs[jobId] || jobs[jobId].status !== "done") {
    return res.status(404).json({ error: "Not ready" });
  }

  const filePath = jobs[jobId].outputPath;

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File missing" });
  }

  res.setHeader("Content-Type", "video/mp4");
  res.send(fs.readFileSync(filePath));
});

// ------------------------------
// 最終レンダー処理
// ------------------------------
async function processFinalRenderJob(jobId, clips) {
  console.log(`Processing job: ${jobId}`);

  const id = uuidv4();
  const concatListPath = `/tmp/list-${id}.txt`;
  const concatOutput = `/tmp/concat-${id}.mp4`;
  const finalOutput = `/tmp/final-${id}.mp4`;

  try {
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
            "[0:v][2:v] overlay=(main_w-overlay_w)/2:(main_h-overlay_h)-50",
          ])
          .outputOptions([
            "-c:v libx264",
            "-c:a aac",
            "-pix_fmt yuv420p",
          ])
          .save(outPath)
          .on("end", () => {
            try { fs.unlinkSync(bgPath); } catch {}
            try { fs.unlinkSync(audioPath); } catch {}
            try { fs.unlinkSync(subtitlePath); } catch {}
            resolve();
          })
          .on("error", (err) => {
            console.error("FFMPEG ERROR (per-clip in final):", err);
            try { fs.unlinkSync(bgPath); } catch {}
            try { fs.unlinkSync(audioPath); } catch {}
            try { fs.unlinkSync(subtitlePath); } catch {}
            reject(err);
          });
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
        .on("end", () => {
          try { fs.unlinkSync(concatListPath); } catch {}
          resolve();
        })
        .on("error", (err) => {
          console.error("FFMPEG ERROR (concat):", err);
          try { fs.unlinkSync(concatListPath); } catch {}
          reject(err);
        });
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
          `fade=t=out:st=${duration - fadeOutSec}:d=${fadeOutSec}`,
        ])
        .audioFilters([
          `afade=t=in:st=0:d=${fadeInSec}`,
          `afade=t=out:st=${duration - fadeOutSec}:d=${fadeOutSec}`,
        ])
        .outputOptions([
          "-c:v libx264",
          "-c:a aac",
          "-pix_fmt yuv420p",
        ])
        .save(finalOutput)
        .on("end", () => {
          try { fs.unlinkSync(concatOutput); } catch {}
          resolve();
        })
        .on("error", (err) => {
          console.error("FFMPEG ERROR (fade/final):", err);
          try { fs.unlinkSync(concatOutput); } catch {}
          reject(err);
        });
    });

    jobs[jobId].status = "done";
    jobs[jobId].outputPath = finalOutput;

    console.log(`Job completed: ${jobId}`);

  } catch (err) {
    console.error("JOB ERROR:", err);
    if (jobs[jobId]) {
      jobs[jobId].status = "error";
    }
    try { fs.unlinkSync(concatListPath); } catch {}
    try { fs.unlinkSync(concatOutput); } catch {}
    try { fs.unlinkSync(finalOutput); } catch {}
    throw err;
  }
}

// ------------------------------
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});
