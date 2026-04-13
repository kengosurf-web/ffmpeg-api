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

async function downloadToTmp(url, dest) {
  console.log("Downloading:", url);

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Pragma": "no-cache",
      "Expires": "0"
    }
  });

  if (!res.ok) {
    throw new Error(`Download failed: ${res.status} ${res.statusText}`);
  }

  const fileStream = fs.createWriteStream(dest);

  await new Promise((resolve, reject) => {
    res.body.pipe(fileStream);
    res.body.on("error", reject);
    fileStream.on("finish", resolve);
  });

  console.log("Saved to:", dest);
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
// 非同期ジョブ管理
// ------------------------------
const jobs = {};

// ------------------------------
// /clip（最軽量 A 切り版）
// ------------------------------
app.post("/clip", async (req, res) => {
  try {
    const { subtitlePng, audioUrl, backgroundVideo } = req.body;

    // ------------------------------
    // fetchBinaryWithRetry（忘れていたので追加）
    // ------------------------------
    async function fetchBinaryWithRetry(url, retries = 3) {
      for (let i = 0; i < retries; i++) {
        try {
          const res = await fetch(url, {
            method: "GET",
            redirect: "follow",
            headers: {
              "User-Agent": "Mozilla/5.0",
              "Accept": "*/*",
              "Cache-Control": "no-cache, no-store, must-revalidate",
              "Pragma": "no-cache",
              "Expires": "0"
            }
          });

          if (!res.ok) throw new Error(`HTTP ${res.status}`);

          return Buffer.from(await res.arrayBuffer());
        } catch (err) {
          console.error(`fetchBinaryWithRetry failed (${i + 1}/${retries}):`, err);
          if (i === retries - 1) throw err;
          await new Promise(r => setTimeout(r, 300));
        }
      }
    }

    // ------------------------------
    // パス生成
    // ------------------------------
    const unique = `${uuidv4()}-${Date.now()}-${Math.random()}`;

    const bgPath = `/tmp/bg-${unique}.mp4`;
    const bgA = `/tmp/bgA-${unique}.mp4`;

    const audioPath = `/tmp/audio-${unique}.mp3`;
    const audioFixed = `/tmp/audioF-${unique}.m4a`;
    const subtitlePath = `/tmp/sub-${unique}.png`;

    const clip = `/tmp/clip-${unique}.mp4`;
    const clipFast = `/tmp/clipF-${unique}.mp4`;

    // ------------------------------
    // ダウンロード（軽量）
    // ------------------------------
    fs.writeFileSync(bgPath, await fetchBinaryWithRetry(backgroundVideo));
    fs.writeFileSync(audioPath, await fetchBinaryWithRetry(audioUrl));
    fs.writeFileSync(subtitlePath, await fetchBinaryWithRetry(subtitlePng));

    // ------------------------------
    // 音声を AAC に安定化
    // ------------------------------
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(audioPath)
        .audioCodec("aac")
        .audioFrequency(48000)
        .audioChannels(2)
        .outputOptions(["-movflags +faststart"])
        .save(audioFixed)
        .on("end", resolve)
        .on("error", reject);
    });

    // ------------------------------
    // A（音声の長さ）
    // ------------------------------
    const durationA = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(audioFixed, (err, meta) => {
        if (err) reject(err);
        else resolve(meta.format.duration);
      });
    });

    // ------------------------------
    // 背景を A で切る（copy → 最軽量）
    // ------------------------------
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(bgPath)
        .outputOptions([`-t ${durationA}`, "-c copy"])
        .save(bgA)
        .on("end", resolve)
        .on("error", reject);
    });

    // ------------------------------
    // overlay（clip）
    // ------------------------------
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(bgA)
        .input(audioFixed)
        .input(subtitlePath)
        .complexFilter([
          {
            filter: "overlay",
            inputs: ["0:v", "2:v"],
            options: { x: "(W-w)/2", y: "(H-h)/2" },
            outputs: "v"
          }
        ])
        .outputOptions([
          "-map [v]",
          "-map 1:a",
          "-c:v libx264",
          "-preset ultrafast",
          "-c:a aac",
          "-pix_fmt yuv420p"
        ])
        .save(clip)
        .on("end", resolve)
        .on("error", reject);
    });

    // ------------------------------
    // 正規化（faststart）
    // ------------------------------
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(clip)
        .outputOptions([
          "-c:v libx264",
          "-preset ultrafast",
          "-c:a aac",
          "-pix_fmt yuv420p",
          "-movflags +faststart"
        ])
        .save(clipFast)
        .on("end", resolve)
        .on("error", reject);
    });

    // ------------------------------
    // 出力
    // ------------------------------
    const file = fs.readFileSync(clipFast);

    // cleanup
    for (const p of [bgPath, bgA, audioPath, audioFixed, subtitlePath, clip, clipFast]) {
      try { fs.unlinkSync(p); } catch {}
    }

    res.setHeader("Content-Type", "video/mp4");
    res.send(file);

  } catch (err) {
    console.error("SERVER ERROR (/clip):", err);
    res.status(500).json({ error: err.message });
  }
});


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
    jobs[jobId] = {
      status: "processing",
      currentStep: "queued",
      progress: 0,
      outputPath: null,
      errorMessage: null
    };

    console.log(`Final render job registered: ${jobId}`);

    enqueueFfmpegJob(() => processFinalRenderJob(jobId, clips))
      .catch((err) => {
        console.error("FINAL RENDER JOB ERROR (queued):", err);
        if (jobs[jobId]) {
          jobs[jobId].status = "error";
          jobs[jobId].currentStep = "error";
          jobs[jobId].progress = 0;
          jobs[jobId].errorMessage = err.message || String(err);
        }
      });

    res.json({ jobId, status: "processing", currentStep: "queued", progress: 0 });

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

  if (job.status === "error") {
    return res.json({
      jobId,
      status: "error",
      currentStep: job.currentStep || null,
      progress: job.progress || 0,
      errorMessage: job.errorMessage || "Unknown error"
    });
  }

  if (job.status === "done") {
    return res.json({
      jobId,
      status: "done",
      currentStep: "completed",
      progress: 100,
      url: `/final-result/${jobId}`,
    });
  }

  res.json({
    jobId,
    status: job.status,
    currentStep: job.currentStep || "processing",
    progress: job.progress || 0
  });
});

// ------------------------------
// 新しい最終レンダー（concat filter + ffprobe + 再エンコード + 進捗）
// ------------------------------
async function processFinalRenderJob(jobId, clips) {
  console.log(`Processing final render job (concat filter): ${jobId}`);

  const id = uuidv4();
  const filterList = [];
  const finalOutput = `/tmp/final-${id}.mp4`;

  try {
    // 10%
    jobs[jobId].currentStep = "downloading clips";
    jobs[jobId].progress = 10;

    const cacheBust = `?v=${Date.now()}&cb=${Math.random()}&nocache=1`;

    for (const clip of clips) {
      const localPath = `/tmp/clip-${uuidv4()}.mp4`;
      const clipDownloadUrl = clip.clipUrl + cacheBust;

      await downloadToTmp(clipDownloadUrl, localPath);

      // 30%
      jobs[jobId].currentStep = "probing streams";
      jobs[jobId].progress = 30;

      const probe = await new Promise((resolve, reject) => {
        ffmpeg.ffprobe(localPath, (err, data) => {
          if (err) reject(err);
          else resolve(data);
        });
      });

      const videoStream = probe.streams.find(s => s.codec_type === "video");
      const audioStream = probe.streams.find(s => s.codec_type === "audio");

      if (!videoStream) throw new Error(`Video stream missing: ${clip.clipUrl}`);
      if (!audioStream) throw new Error(`Audio stream missing: ${clip.clipUrl}`);

      filterList.push({
        path: localPath,
        v: videoStream.index,
        a: audioStream.index
      });
    }

    // 50%
    jobs[jobId].currentStep = "building filter graph";
    jobs[jobId].progress = 50;

    const ff = ffmpeg();
    filterList.forEach((c) => ff.input(c.path));

    const filterComplex =
      filterList.map((c, i) => `[${i}:v][${i}:a]`).join("") +
      `concat=n=${filterList.length}:v=1:a=1[v][a]`;

    // 70%
    jobs[jobId].currentStep = "concatenating video";
    jobs[jobId].progress = 70;

    await new Promise((resolve, reject) => {
      ff
        .complexFilter(filterComplex)
        .outputOptions([
          "-map [v]",
          "-map [a]",
          "-c:v libx264",
          "-preset veryfast",
          "-crf 23",
          "-c:a aac",
          "-b:a 192k",
          "-movflags +faststart"
        ])
        .save(finalOutput)
        .on("end", resolve)
        .on("error", reject);
    });

    // 90%
    jobs[jobId].currentStep = "uploading to GitHub";
    jobs[jobId].progress = 90;

    const uploadedUrl = await uploadToGitHub(finalOutput, `final/${jobId}.mp4`);

    jobs[jobId].status = "done";
    jobs[jobId].currentStep = "completed";
    jobs[jobId].progress = 100;
    jobs[jobId].outputPath = uploadedUrl;

    console.log(`Final render job completed: ${jobId}`);

  } catch (err) {
    console.error("FINAL RENDER JOB ERROR:", err);
    jobs[jobId].status = "error";
    jobs[jobId].currentStep = "error";
    jobs[jobId].progress = 0;
    jobs[jobId].errorMessage = err.message || String(err);
  }
}

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
// POST /bgm-mix
// ------------------------------
app.post("/bgm-mix", async (req, res) => {
  try {
    const { finalVideoUrl, bgmUrl } = req.body;

    if (!finalVideoUrl || !bgmUrl) {
      return res.status(400).json({ error: "finalVideoUrl and bgmUrl are required" });
    }

    const jobId = uuidv4();
    jobs[jobId] = { 
      status: "processing", 
      currentStep: "queued",
      progress: 0,
      outputPath: null, 
      errorMessage: null 
    };

    console.log(`BGM mix job registered: ${jobId}`);

    enqueueFfmpegJob(() => processBgmMixJob(jobId, finalVideoUrl, bgmUrl))
      .catch((err) => {
        console.error("BGM MIX JOB ERROR (queued):", err);
        if (jobs[jobId]) {
          jobs[jobId].status = "error";
          jobs[jobId].currentStep = "error";
          jobs[jobId].progress = 0;
          jobs[jobId].errorMessage = err.message || String(err);
        }
      });

    res.json({ jobId, status: "processing", currentStep: "queued", progress: 0 });

  } catch (err) {
    console.error("SERVER ERROR (/bgm-mix):", err);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

// ------------------------------
// BGM ミックス処理（音量調整 + フェードアウト付き + 進捗）
// ------------------------------
async function processBgmMixJob(jobId, finalVideoUrl, bgmUrl) {
  console.log(`Processing BGM mix job: ${jobId}`);

  const id = uuidv4();
  const videoPath = `/tmp/video-${id}.mp4`;
  const bgmPath = `/tmp/bgm-${id}.mp3`;
  const outputPath = `/tmp/bgm-final-${id}.mp4`;

  try {
    // 20%
    jobs[jobId].currentStep = "downloading video & bgm";
    jobs[jobId].progress = 20;

    await downloadToTmp(finalVideoUrl, videoPath);
    await downloadToTmp(bgmUrl, bgmPath);

    // 40%
    jobs[jobId].currentStep = "probing video duration";
    jobs[jobId].progress = 40;

    const videoDuration = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) reject(err);
        else resolve(metadata.format.duration);
      });
    });

    const fadeStart = Math.max(videoDuration - 1, 0); // 最後の1秒でフェードアウト

    // 60%
    jobs[jobId].currentStep = "mixing audio";
    jobs[jobId].progress = 60;

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(videoPath)  // 0:v, 0:a
        .input(bgmPath)    // 1:a
        .complexFilter([
          // BGM の音量を下げる（20%）
          {
            filter: "volume",
            options: "0.2",
            inputs: "1:a",
            outputs: "bgm_low"
          },
          // BGM をフェードアウト
          {
            filter: "afade",
            options: `t=out:st=${fadeStart}:d=1`,
            inputs: "bgm_low",
            outputs: "bgm_faded"
          },
          // 元の音声 + BGM をミックス
          {
            filter: "amix",
            options: {
              inputs: 2,
              duration: "first",
              dropout_transition: 0
            },
            inputs: ["0:a", "bgm_faded"],
            outputs: "aout"
          }
        ])
        .outputOptions([
          "-map 0:v",     // 元の映像
          "-map [aout]",  // ミックス後の音声
          "-c:v copy",
          "-c:a aac",
          "-movflags +faststart"
        ])
        .save(outputPath)
        .on("end", resolve)
        .on("error", reject);
    });

    // 90%
    jobs[jobId].currentStep = "finalizing bgm mix";
    jobs[jobId].progress = 90;

    jobs[jobId].status = "done";
    jobs[jobId].currentStep = "completed";
    jobs[jobId].progress = 100;
    jobs[jobId].outputPath = outputPath;

    console.log(`BGM mix job completed: ${jobId}`);

  } catch (err) {
    console.error("BGM MIX JOB ERROR:", err);
    jobs[jobId].status = "error";
    jobs[jobId].currentStep = "error";
    jobs[jobId].progress = 0;
    jobs[jobId].errorMessage = err.message || String(err);
  }
}

// ------------------------------
// GET /bgm-mix-status
// ------------------------------
app.get("/bgm-mix-status", (req, res) => {
  const { jobId } = req.query;

  if (!jobId || !jobs[jobId]) {
    return res.status(404).json({ error: "Invalid jobId" });
  }

  const job = jobs[jobId];

  if (job.status === "error") {
    return res.json({
      jobId,
      status: "error",
      currentStep: job.currentStep || null,
      progress: job.progress || 0,
      errorMessage: job.errorMessage || "Unknown error"
    });
  }

  if (job.status === "done") {
    return res.json({
      jobId,
      status: "done",
      currentStep: "completed",
      progress: 100,
      url: `/final-result/${jobId}`,
    });
  }

  res.json({
    jobId,
    status: job.status,
    currentStep: job.currentStep || "processing",
    progress: job.progress || 0
  });
});

// ------------------------------
// ポート起動
// ------------------------------
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});
