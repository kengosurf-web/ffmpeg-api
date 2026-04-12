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
// 非同期ジョブ管理
// ------------------------------
const jobs = {};

// ------------------------------
// /clip（1文クリップ生成API）完全同期版（背景をBに強制）
// ------------------------------
app.post("/clip", async (req, res) => {
  try {
    const { subtitlePng, audioUrl, backgroundVideo } = req.body;

    if (!subtitlePng || !audioUrl || !backgroundVideo) {
      return res.status(400).json({
        error: "Missing subtitlePng, audioUrl, or backgroundVideo",
      });
    }

    console.log("Generating 1-sentence clip (perfect sync, force-B background)...");

    const unique = `${uuidv4()}-${Date.now()}-${Math.random()}`;

    const bgPath = `/tmp/bg-${unique}.mp4`;
    const bgTrimmedA = `/tmp/bgA-${unique}.mp4`;
    const bgTrimmedB = `/tmp/bgB-${unique}.mp4`;

    const audioPath = `/tmp/audio-${unique}.mp3`;
    const subtitlePath = `/tmp/sub-${unique}.png`;

    const clipA = `/tmp/clipA-${unique}.mp4`; // 仮クリップ（Aで切った背景）
    const clipB = `/tmp/clipB-${unique}.mp4`; // Bで背景を切り直した本番クリップ
    const clipNormalized = `/tmp/clipN-${unique}.mp4`;

    // GitHub API → raw URL
    let audioDownloadUrl = audioUrl;
    if (audioUrl.includes("api.github.com")) {
      audioDownloadUrl = audioUrl
        .replace("api.github.com/repos", "raw.githubusercontent.com")
        .replace("/contents/", "/")
        .replace("?ref=main", "");
    }

    const cacheBust = `?v=${Date.now()}`;
    const bgDownloadUrl = backgroundVideo + cacheBust;
    const audioDownloadUrlWithBust = audioDownloadUrl + cacheBust;
    const subtitleDownloadUrl = subtitlePng + cacheBust;

    const clipBuffer = await enqueueFfmpegJob(async () => {
      // ---- ダウンロード ----
      fs.writeFileSync(bgPath, await fetchBinaryWithRetry(bgDownloadUrl));
      fs.writeFileSync(audioPath, await fetchBinaryWithRetry(audioDownloadUrlWithBust));
      fs.writeFileSync(subtitlePath, await fetchBinaryWithRetry(subtitleDownloadUrl));

      // ---- 音声の duration（A） ----
      const audioDurationA = await new Promise((resolve, reject) => {
        ffmpeg.ffprobe(audioPath, (err, metadata) => {
          if (err) reject(err);
          else resolve(metadata.format.duration);
        });
      });

      // ---- 背景を A で切る（仮） ----
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(bgPath)
          .outputOptions([`-t ${audioDurationA}`, "-c copy"])
          .save(bgTrimmedA)
          .on("end", resolve)
          .on("error", reject);
      });

      // ---- ① 仮クリップ生成（Aで切った背景） ----
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(bgTrimmedA)
          .input(audioPath)
          .input(subtitlePath)
          .complexFilter([
            { filter: "setpts", options: "PTS-STARTPTS", inputs: "0:v", outputs: "bg_reset" },
            { filter: "asetpts", options: "PTS-STARTPTS", inputs: "1:a", outputs: "audio_reset" },

            {
              filter: "overlay",
              inputs: ["bg_reset", "2:v"],
              options: { x: "(W-w)/2", y: "(H-h)/2" },
              outputs: "video_overlaid",
            },

            { filter: "setpts", options: "PTS-STARTPTS", inputs: "video_overlaid", outputs: "video_fixed" },
            { filter: "asetpts", options: "PTS-STARTPTS", inputs: "audio_reset", outputs: "audio_fixed" },
          ])
          .outputOptions([
            "-map [video_fixed]",
            "-map [audio_fixed]",
            "-c:v libx264",
            "-preset ultrafast",
            "-c:a aac",
            "-pix_fmt yuv420p",
          ])
          .save(clipA)
          .on("end", resolve)
          .on("error", reject);
      });

      // ---- 仮クリップの実長（B）を取得 ----
      const durationB = await new Promise((resolve, reject) => {
        ffmpeg.ffprobe(clipA, (err, metadata) => {
          if (err) reject(err);
          else resolve(metadata.format.duration);
        });
      });

      // ---- 背景を B で切り直す（ここがズレゼロの核心） ----
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(bgPath)
          .outputOptions([`-t ${durationB}`, "-c copy"])
          .save(bgTrimmedB)
          .on("end", resolve)
          .on("error", reject);
      });

      // ---- ② 本番クリップ生成（背景をBに強制） ----
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(bgTrimmedB)
          .input(audioPath)
          .input(subtitlePath)
          .complexFilter([
            { filter: "setpts", options: "PTS-STARTPTS", inputs: "0:v", outputs: "bg_reset" },
            { filter: "asetpts", options: "PTS-STARTPTS", inputs: "1:a", outputs: "audio_reset" },

            {
              filter: "overlay",
              inputs: ["bg_reset", "2:v"],
              options: { x: "(W-w)/2", y: "(H-h)/2" },
              outputs: "video_overlaid",
            },

            { filter: "setpts", options: "PTS-STARTPTS", inputs: "video_overlaid", outputs: "video_fixed" },
            { filter: "asetpts", options: "PTS-STARTPTS", inputs: "audio_reset", outputs: "audio_fixed" },
          ])
          .outputOptions([
            "-map [video_fixed]",
            "-map [audio_fixed]",
            "-c:v libx264",
            "-preset ultrafast",
            "-c:a aac",
            "-pix_fmt yuv420p",
            `-t ${durationB}`,   // ★ B を絶対基準に固定
          ])
          .save(clipB)
          .on("end", resolve)
          .on("error", reject);
      });

      // ---- ③ 正規化（duration = B） ----
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(clipB)
          .outputOptions([
            "-c:v libx264",
            "-preset ultrafast",
            "-c:a aac",
            "-pix_fmt yuv420p",
            "-movflags +faststart",
          ])
          .save(clipNormalized)
          .on("end", resolve)
          .on("error", reject);
      });

      const file = fs.readFileSync(clipNormalized);

      // ---- Cleanup ----
      for (const p of [
        bgPath, bgTrimmedA, bgTrimmedB,
        audioPath, subtitlePath,
        clipA, clipB, clipNormalized
      ]) {
        try { fs.unlinkSync(p); } catch {}
      }

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
// POST /final-render-url
// ------------------------------
app.post("/final-render-url", async (req, res) => {
  try {
    const clips = JSON.parse(req.body.clips.replace(/^=/, ""));

    if (!clips || !Array.isArray(clips)) {
      return res.status(400).json({ error: "Invalid clips array" });
    }

    const jobId = uuidv4();
    jobs[jobId] = { status: "processing", outputPath: null, errorMessage: null };

    console.log(`Final render job registered: ${jobId}`);

    enqueueFfmpegJob(() => processFinalRenderJob(jobId, clips))
      .catch((err) => {
        console.error("FINAL RENDER JOB ERROR (queued):", err);
        if (jobs[jobId]) {
          jobs[jobId].status = "error";
          jobs[jobId].errorMessage = err.message || String(err);
        }
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

  if (job.status === "error") {
    return res.json({
      jobId,
      status: "error",
      errorMessage: job.errorMessage || "Unknown error"
    });
  }

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
// POST /bgm-mix
// ------------------------------
app.post("/bgm-mix", async (req, res) => {
  try {
    const { finalVideoUrl, bgmUrl } = req.body;

    if (!finalVideoUrl || !bgmUrl) {
      return res.status(400).json({ error: "finalVideoUrl and bgmUrl are required" });
    }

    const jobId = uuidv4();
    jobs[jobId] = { status: "processing", outputPath: null, errorMessage: null };

    console.log(`BGM mix job registered: ${jobId}`);

    enqueueFfmpegJob(() => processBgmMixJob(jobId, finalVideoUrl, bgmUrl))
      .catch((err) => {
        console.error("BGM MIX JOB ERROR (queued):", err);
        if (jobs[jobId]) {
          jobs[jobId].status = "error";
          jobs[jobId].errorMessage = err.message || String(err);
        }
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

  if (job.status === "error") {
    return res.json({
      jobId,
      status: "error",
      errorMessage: job.errorMessage || "Unknown error"
    });
  }

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
// 最終レンダー（ロングエスト基準 / concat filter / ffprobeでストリーム番号取得）
// ------------------------------
async function processFinalRenderJob(jobId, clips) {
  console.log(`Processing final render job (longest-PTS mode): ${jobId}`);

  const id = uuidv4();
  const filterList = [];
  const finalOutput = `/tmp/final-${id}.mp4`;

  try {
    // ★ キャッシュバスター強化（複数パラメータ）
    const cacheBust = `?v=${Date.now()}&cb=${Math.random()}&nocache=1`;

    for (const clip of clips) {
      const localPath = `/tmp/clip-${uuidv4()}.mp4`;
      const clipDownloadUrl = clip.clipUrl + cacheBust;

      // クリップをダウンロード（downloadToTmp 側もキャッシュ破壊対応する）
      await downloadToTmp(clipDownloadUrl, localPath);

      // ★ ffprobe でストリーム番号を取得
      const probe = await new Promise((resolve, reject) => {
        ffmpeg.ffprobe(localPath, (err, data) => {
          if (err) reject(err);
          else resolve(data);
        });
      });

      const videoStream = probe.streams.find(s => s.codec_type === "video");
      const audioStream = probe.streams.find(s => s.codec_type === "audio");

      if (!videoStream) {
        throw new Error(`Video stream missing in clip: ${clip.clipUrl}`);
      }
      if (!audioStream) {
        throw new Error(`Audio stream missing in clip: ${clip.clipUrl}`);
      }

      filterList.push({
        path: localPath,
        v: videoStream.index,
        a: audioStream.index
      });
    }

    // ffmpeg filter_complex の入力を構築
    const ff = ffmpeg();
    filterList.forEach((c) => ff.input(c.path));

    // ★ filterComplex を完全1行で生成（改行禁止）
    const filterComplex =
      filterList.map((c, i) => `[${i}:v][${i}:a]`).join("") +
      `concat=n=${filterList.length}:v=1:a=1[v][a]`;

    await new Promise((resolve, reject) => {
      ff
        .complexFilter(filterComplex)
        .outputOptions([
          "-map [v]",
          "-map [a]",
          "-c:v libx264",
          "-preset veryfast",
          "-c:a aac",
          "-movflags +faststart"
        ])
        .save(finalOutput)
        .on("end", resolve)
        .on("error", reject);
    });

    jobs[jobId].status = "done";
    jobs[jobId].outputPath = finalOutput;

    console.log(`Final render job completed (longest-PTS mode): ${jobId}`);

  } catch (err) {
    console.error("FINAL RENDER JOB ERROR:", err);
    jobs[jobId].status = "error";
    jobs[jobId].errorMessage = err.message || String(err);
    return;
  }
}

// ------------------------------
// BGM ミックス処理（音量調整 + フェードアウト付き）
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

    // Final video duration を取得（フェードアウトに必要）
    const videoDuration = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        if (err) reject(err);
        else resolve(metadata.format.duration);
      });
    });

    const fadeStart = Math.max(videoDuration - 1, 0); // 最後の1秒でフェードアウト

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
          "-c:a aac"
        ])
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
