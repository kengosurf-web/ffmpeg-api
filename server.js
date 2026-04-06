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
