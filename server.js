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
// /clip（1文クリップ生成API）完全同期版（音声長で背景を利用し、音声長で切る）
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

      // ---- 音声の duration を取得（絶対基準）----
      const audioDuration = await new Promise((resolve, reject) => {
        ffmpeg.ffprobe(audioPath, (err, metadata) => {
          if (err) reject(err);
          else resolve(metadata.format.duration);
        });
      });

      // ---- ① クリップ生成（音声長で背景を利用し、音声長で切る）----
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(bgPath)        // 0:v 背景動画
          .input(audioPath)     // 1:a 音声
          .input(subtitlePath)  // 2:v 字幕PNG
          .complexFilter([
            // 背景の PTS を完全リセット
            {
              filter: "setpts",
              options: "PTS-STARTPTS",
              inputs: "0:v",
              outputs: "bg_reset",
            },

            // 音声の PTS を完全リセット
            {
              filter: "asetpts",
              options: "PTS-STARTPTS",
              inputs: "1:a",
              outputs: "audio_reset",
            },

            // 字幕縮小
            {
              filter: "scale",
              options: { w: "iw*0.5", h: "ih*0.5" },
              inputs: "2:v",
              outputs: "sub_scaled",
            },

            // 背景 + 字幕（映像合成）
            {
              filter: "overlay",
              inputs: ["bg_reset", "sub_scaled"],
              options: {
                x: "(W-w)/2",
                y: "H-h-80",
              },
              outputs: "video_overlaid",
            },

            // 映像全体の PTS をリセット
            {
              filter: "setpts",
              options: "PTS-STARTPTS",
              inputs: "video_overlaid",
              outputs: "video_fixed",
            },

            // 音声側も最終的に PTS を揃える
            {
              filter: "asetpts",
              options: "PTS-STARTPTS",
              inputs: "audio_reset",
              outputs: "audio_fixed",
            },

            // apad（無音追加）
            {
              filter: "apad",
              options: "pad_dur=0.02",
              inputs: "audio_fixed",
              outputs: "audio_padded",
            }
          ])
          .outputOptions([
            "-map [video_fixed]",
            "-map [audio_padded]",
            "-c:v libx264",
            "-preset ultrafast",
            "-c:a aac",
            "-pix_fmt yuv420p",

            // ★ ここが重要：音声長で背景を切る
            `-t ${audioDuration}`
          ])
          .save(outputPath)
          .on("end", resolve)
          .on("error", reject);
      });

      // ---- ② 正規化ステップ（metadata 修復）----
      await new Promise((resolve, reject) => {
        ffmpeg()
          .input(outputPath)
          .outputOptions([
            "-c:v libx264",
            "-preset ultrafast",
            "-c:a aac",
            "-pix_fmt yuv420p",
            "-movflags +faststart"
          ])
          .save(normalizedPath)
          .on("end", resolve)
          .on("error", reject);
      });

      // ---- 正規化済みファイルを返す ----
      const file = fs.readFileSync(normalizedPath);

      // ---- 後片付け ----
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
// 最終レンダー処理（mp4 を /tmp に保存して concat）
// ------------------------------
async function processFinalRenderJob(jobId, clips) {
  console.log(`Processing job: ${jobId}`);

  const id = uuidv4();
  const concatListPath = `/tmp/list-${id}.txt`;
  const concatOutput = `/tmp/concat-${id}.mp4`;
  const finalOutput = `/tmp/final-${id}.mp4`;

  try {
    let concatList = "";

    // ---- mp4 を /tmp に保存して concat ----
    for (const clip of clips) {
      if (!clip.clipUrl) {
        throw new Error("clip.clipUrl is missing");
      }

      const localPath = `/tmp/clip-${uuidv4()}.mp4`;
      await downloadToTmp(clip.clipUrl, localPath);

      concatList += `file '${localPath}'\n`;
    }

    fs.writeFileSync(concatListPath, concatList);

    // ---- concat ----
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

    // ---- duration を取得 ----
    const duration = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(concatOutput, (err, metadata) => {
        if (err) reject(err);
        else resolve(metadata.format.duration);
      });
    });

    const fadeInSec = 0.8;
    const fadeOutSec = 0.8;

    // ★ fade-out の開始位置を安全化（負値防止）
    const fadeOutStart = Math.max(duration - fadeOutSec, 0);

    // ---- fade + PTS リセット ----
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatOutput)
        .videoFilters([
          "setpts=PTS-STARTPTS",  // ★ PTS リセット
          `fade=t=in:st=0:d=${fadeInSec}`,
          `fade=t=out:st=${fadeOutStart}:d=${fadeOutSec}`,
        ])
        .audioFilters([
          "asetpts=PTS-STARTPTS", // ★ PTS リセット
          `afade=t=in:st=0:d=${fadeInSec}`,
          `afade=t=out:st=${fadeOutStart}:d=${fadeOutSec}`,
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
// ESM 用 __dirname 再現
// ------------------------------
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";
import ffmpeg from "fluent-ffmpeg";
import fetch from "node-fetch";   // ★★★ 必須 ★★★

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ------------------------------
// downloadToTmp（Jamendo / Koyeb 完全対応版）
// ------------------------------
async function downloadToTmp(url, destPath) {
  console.log("Downloading:", url);

  const response = await fetch(url, {
    method: "GET",                 // ★ HEAD を禁止（Jamendo/Koyeb 対策）
    redirect: "follow",            // ★ 302/301 を追跡
    headers: {
      "User-Agent": "Mozilla/5.0", // ★ Jamendo 対策（UA 必須）
      "Accept": "*/*"
    }
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
// /bgm-mix（完全修正版 / ESM対応）
// ------------------------------
app.post('/bgm-mix', async (req, res) => {
  try {
    const { finalVideoUrl, bgmUrl } = req.body;

    if (!finalVideoUrl || !bgmUrl) {
      return res.status(400).json({ error: "finalVideoUrl and bgmUrl are required" });
    }

    const jobId = uuidv4();

    // 一時ファイル
    const localVideoPath = `/tmp/video-${jobId}.mp4`;
    const localBgmPath = `/tmp/bgm-${jobId}.mp3`;
    const trimmedBgmPath = `/tmp/bgm-trimmed-${jobId}.mp3`;
    const outputPath = `/tmp/output-${jobId}.mp4`;

    // ------------------------------
    // 0. 動画とBGMを /tmp に保存
    // ------------------------------
    await downloadToTmp(finalVideoUrl, localVideoPath);
    await downloadToTmp(bgmUrl, localBgmPath);

    // ------------------------------
    // 1. Final video duration
    // ------------------------------
    const videoDuration = await new Promise((resolve, reject) => {
      ffmpeg.ffprobe(localVideoPath, (err, metadata) => {
        if (err) reject(err);
        else resolve(metadata.format.duration);
      });
    });

    // ------------------------------
    // 2. Trim BGM
    // ------------------------------
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(localBgmPath)
        .audioFilters("volume=0.25")
        .setDuration(videoDuration)
        .output(trimmedBgmPath)
        .on("end", resolve)
        .on("error", reject)
        .run();
    });

    // ------------------------------
    // 3. Mix BGM + Final video
    // ------------------------------
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(localVideoPath)
        .input(trimmedBgmPath)
        .complexFilter([
          {
            filter: "amix",
            options: {
              inputs: 2,
              duration: "first",
              dropout_transition: 0
            }
          }
        ])
        .outputOptions([
          "-c:v copy",
          "-c:a aac",
          "-preset ultrafast"
        ])
        .save(outputPath)
        .on("end", resolve)
        .on("error", reject);
    });

    // ------------------------------
    // 4. Save result to public folder
    // ------------------------------
    const resultDir = path.join(__dirname, "public", "final-result");

    fs.mkdirSync(resultDir, { recursive: true });

    const publicPath = path.join(resultDir, `${jobId}.mp4`);
    fs.copyFileSync(outputPath, publicPath);

    // ------------------------------
    // 5. Cleanup
    // ------------------------------
    try { fs.unlinkSync(localVideoPath); } catch {}
    try { fs.unlinkSync(localBgmPath); } catch {}
    try { fs.unlinkSync(trimmedBgmPath); } catch {}
    try { fs.unlinkSync(outputPath); } catch {}

    // ------------------------------
    // 6. Response
    // ------------------------------
    res.json({
      jobId,
      status: "done",
      url: `/final-result/${jobId}`
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "BGM mix failed", details: err.message });
  }
});

// ------------------------------
// PORT
// ------------------------------
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});
