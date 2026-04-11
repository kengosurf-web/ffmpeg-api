// ------------------------------
// Imports & ESM __dirname
// ------------------------------
import express from "express";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ------------------------------
// Express app
// ------------------------------
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

// ------------------------------
// downloadToTmp（Jamendo / Koyeb 対応版）
// ------------------------------
async function downloadToTmp(url, destPath) {
  console.log("Downloading:", url);

  const response = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "*/*",
    },
  });

  console.log("Status:", response.status);

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  console.log("Downloaded bytes:", buffer.length);

  fs.writeFileSync(destPath, buffer);
  console.log("Saved to:", destPath);
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
// /clip（1文クリップ生成API）完全同期版
// ------------------------------
app.post("/clip", async (req, res) => {
  try {
    const { subtitlePng, audioUrl, backgroundVideo } = req.body;

    if (!subtitlePng || !audioUrl || !backgroundVideo) {
      return res.status(400).json({
        error: "Missing subtitlePng, audioUrl, or backgroundVideo",
      });
    }

    console.log("Generating 1-sentence clip (perfect sync version)...");

    const unique = `${uuidv4()}-${Date.now()}-${Math.random()}`;

    const bgPath = `/tmp/bg-${unique}.mp4`;
    const audioPath = `/tmp/audio-${unique}.mp3`;
    const subtitlePath = `/tmp/sub-${unique}.png`;
    const outputPath = `/tmp/clip-${unique}.mp4`;
    const normalizedPath = `/tmp/clip-normalized-${unique}.mp4`;

    // GitHub API URL → raw URL に変換
    let audioDownloadUrl = audioUrl;
    if (audioUrl.includes("api.github.com")) {
      audioDownloadUrl = audioUrl
        .replace("api.github.com/repos", "raw.githubusercontent.com")
        .replace("/contents/", "/")
        .replace("?ref=main", "");
    }

    const clipBuffer = await enqueueFfmpegJob(async () => {
      // ---- ダウンロード ----
      fs.writeFileSync(bgPath, await fetchBinaryWithRetry(backgroundVideo));
      fs.writeFileSync(audioPath, await fetchBinaryWithRetry(audioDownloadUrl));
      fs.writeFileSync(subtitlePath, await fetchBinaryWithRetry(subtitlePng));

      // ---- 音声の duration を取得 ----
      const audioDuration = await new Promise((resolve, reject) => {
        ffmpeg.ffprobe(audioPath, (err, metadata) => {
          if (err) reject(err);
          else resolve(metadata.format.duration);
        });
      });

      // ---- ① クリップ生成 ----
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(bgPath)        // 0:v 背景動画
          .input(audioPath)     // 1:a 音声
          .input(subtitlePath)  // 2:v 字幕PNG
          .complexFilter([
            {
              filter: "setpts",
              options: "PTS-STARTPTS",
              inputs: "0:v",
              outputs: "bg_reset",
            },
            {
              filter: "asetpts",
              options: "PTS-STARTPTS",
              inputs: "1:a",
              outputs: "audio_reset",
            },
            {
              filter: "scale",
              options: { w: "iw*0.5", h: "ih*0.5" },
              inputs: "2:v",
              outputs: "sub_scaled",
            },
            {
              filter: "overlay",
              inputs: ["bg_reset", "sub_scaled"],
              options: {
                x: "(W-w)/2",
                y: "H-h-80",
              },
              outputs: "video_overlaid",
            },
            {
              filter: "setpts",
              options: "PTS-STARTPTS",
              inputs: "video_overlaid",
              outputs: "video_fixed",
            },
            {
              filter: "asetpts",
              options: "PTS-STARTPTS",
              inputs: "audio_reset",
              outputs: "audio_fixed",
            },
            {
              filter: "apad",
              options: "pad_dur=0.02",
              inputs: "audio_fixed",
              outputs: "audio_padded",
            },
          ])
          .outputOptions([
            "-map [video_fixed]",
            "-map [audio_padded]",
            "-c:v libx264",
            "-preset ultrafast",
            "-c:a aac",
            "-pix_fmt yuv420p",
            `-t ${audioDuration}`,
          ])
          .save(outputPath)
          .on("end", resolve)
          .on("error", reject);
      });

      // ---- ② 正規化ステップ ----
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(outputPath)
          .outputOptions([
            "-c:v libx264",
            "-preset ultrafast",
            "-c:a aac",
            "-pix_fmt yuv420p",
            "-movflags +faststart",
          ])
          .save(normalizedPath)
          .on("end", resolve)
          .on("error", reject);
      });

      const file = fs.readFileSync(normalizedPath);

      try { fs.unlinkSync(bgPath); } catch {}
      try { fs.unlinkSync(audioPath); } catch {}
      try { fs.unlinkSync(subtitlePath); } catch {}
      try { fs.unlinkSync(outputPath); } catch {}
      try { fs.unlinkSync(normalizedPath); } catch {}

      return file;
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
const jobs = {};

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

    console.log(`Final render job registered: ${jobId}`);

    enqueueFfmpegJob(() => processFinalRenderJob(jobId, clips))
      .catch((err) => {
        console.error("FINAL RENDER JOB ERROR (queued):", err);
        if (jobs[jobId]) jobs[jobId].status = "error";
      });

    res.json({ jobId, status: "processing" });

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

  res.json({ jobId, status: job.status });
});

// ------------------------------
// POST /bgm-mix（正しい実装）
// ------------------------------
app.post("/bgm-mix", async (req, res) => {
  try {
    const { finalVideoUrl, bgmUrl } = req.body;

    if (!finalVideoUrl || !bgmUrl) {
      return res.status(400).json({ error: "finalVideoUrl and bgmUrl are required" });
    }

    const jobId = uuidv4();
    jobs[jobId] = { status: "processing", outputPath: null };

    console.log(`BGM mix job registered: ${jobId}`);

    enqueueFfmpegJob(() => processBgmMixJob(jobId, finalVideoUrl, bgmUrl))
      .catch((err) => {
        console.error("BGM MIX JOB ERROR (queued):", err);
        if (jobs[jobId]) jobs[jobId].status = "error";
      });

    res.json({ jobId, status: "processing" });

  } catch (err) {
    console.error("SERVER ERROR (/bgm-mix):", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// ------------------------------
// GET /bgm-mix-status
// ------------------------------
app.get("/bgm-mix-status", (req, res) => {
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

  res.json({ jobId, status: job.status });
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

  const stat = fs.statSync(filePath);
  res.setHeader("Content-Type", "video/mp4");
  res.setHeader("Content-Length", stat.size);
  res.setHeader("Accept-Ranges", "bytes");

  res.sendFile(filePath);
});

// ------------------------------
// 最終レンダー処理
// ------------------------------
async function processFinalRenderJob(jobId, clips) {
  console.log(`Processing final render job: ${jobId}`);

  const id = uuidv4();
  const concatListPath = `/tmp/list-${id}.txt`;
  const concatOutput = `/tmp/concat-${id}.mp4`;
  const finalOutput = `/tmp/final-${id}.mp4`;

  try {
    let concatList = "";
    let totalDuration = 0;

    for (const clip of clips) {
      const localPath = `/tmp/clip-${uuidv4()}.mp4`;
      await downloadToTmp(clip.clipUrl, localPath);

      const videoDuration = await new Promise((resolve, reject) => {
        ffmpeg.ffprobe(localPath, (err, metadata) => {
          if (err) reject(err);
          else resolve(metadata.format.duration);
        });
      });

      totalDuration += videoDuration;
      concatList += `file '${localPath}'\n`;
    }

    fs.writeFileSync(concatListPath, concatList);

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatListPath)
        .inputOptions(["-f concat", "-safe 0"])
        .outputOptions(["-c copy"])
        .save(concatOutput)
        .on("end", () => resolve())
        .on("error", reject);
    });

    const fadeInSec = 0.8;
    const fadeOutSec = 0.8;
    const fadeOutStart = Math.max(totalDuration - fadeOutSec, 0);

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatOutput)
        .videoFilters([
          "setpts=PTS-STARTPTS",
          `fade=t=in:st=0:d=${fadeInSec}`,
          `fade=t=out:st=${fadeOutStart}:d=${fadeOutSec}`,
        ])
        .audioFilters([
          "asetpts=PTS-STARTPTS",
          `afade=t=in:st=0:d=${fadeInSec}`,
          `afade=t=out:st=${fadeOutStart}:d=${fadeOutSec}`,
        ])
        .outputOptions(["-c:v libx264", "-c:a aac", "-pix_fmt yuv420p"])
        .save(finalOutput)
        .on("end", resolve)
        .on("error", reject);
    });

    jobs[jobId].status = "done";
    jobs[jobId].outputPath = finalOutput;

    console.log(`Final render job completed: ${jobId}`);

  } catch (err) {
    console.error("FINAL RENDER JOB ERROR:", err);
    jobs[jobId].status = "error";
    throw err;
  }
}

// ------------------------------
// BGM ミックス処理（正しい実装）
// ------------------------------
async function processBgmMixJob(jobId, finalVideoUrl, bgmUrl) {
  console.log(`Processing BGM mix job: ${jobId}`);

  const id = uuidv4();
  const videoPath = `/tmp/video-${id}.mp4`;
  const bgmPath = `/tmp/bgm-${id}.mp3`;
  const outputPath = `/tmp/bgm-final-${id}.mp4`;

  try {
    await downloadToTmp(finalVideoUrl, videoPath);
    await downloadToTmp(bgmUrl, bgmPath);

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(videoPath)
        .input(bgmPath)
        .complexFilter([
          "[0:a][1:a]amix=inputs=2:duration=first:dropout_transition=0[aout]"
        ])
        .outputOptions(["-map 0:v", "-map [aout]", "-c:v copy", "-c:a aac"])
        .save(outputPath)
        .on("end", resolve)
        .on("error", reject);
    });

    jobs[jobId].status = "done";
    jobs[jobId].outputPath = outputPath;

    console.log(`BGM mix job completed: ${jobId}`);

  } catch (err) {
    console.error("BGM MIX JOB ERROR:", err);
    jobs[jobId].status = "error";
    throw err;
  }
}

// ------------------------------
// PORT
// ------------------------------
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});
