import express from "express";
import multer from "multer";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";

const app = express();

// JSON も受けられるようにしておく（他の用途のため）
app.use(express.json());

// multer（メモリ上にバイナリを保持）
const upload = multer({ storage: multer.memoryStorage() });

/**
 * /merge
 * factAudio と opinionAudio をバイナリで受け取り、ffmpeg で結合して返す
 */
app.post(
  "/merge",
  upload.fields([
    { name: "factAudio", maxCount: 1 },
    { name: "opinionAudio", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      // バイナリが無い場合
      if (
        !req.files ||
        !req.files.factAudio ||
        !req.files.opinionAudio
      ) {
        return res.status(400).json({
          error: "Missing audio files (factAudio / opinionAudio)",
        });
      }

      // バイナリ取得
      const factBuffer = req.files.factAudio[0].buffer;
      const opinionBuffer = req.files.opinionAudio[0].buffer;

      // 一時ファイルパス
      const factPath = `/tmp/fact-${uuidv4()}.mp3`;
      const opinionPath = `/tmp/opinion-${uuidv4()}.mp3`;
      const outputPath = `/tmp/output-${uuidv4()}.mp3`;

      // 一時ファイルとして保存
      fs.writeFileSync(factPath, factBuffer);
      fs.writeFileSync(opinionPath, opinionBuffer);

      // ffmpeg 結合
      ffmpeg()
        .input(factPath)
        .input(opinionPath)
        .on("end", () => {
          try {
            const file = fs.readFileSync(outputPath);
            res.setHeader("Content-Type", "audio/mpeg");
            res.send(file);
          } finally {
            // 後片付け
            fs.unlinkSync(factPath);
            fs.unlinkSync(opinionPath);
            fs.unlinkSync(outputPath);
          }
        })
        .on("error", (err) => {
          console.error("FFMPEG ERROR:", err);
          res.status(500).json({
            error: "ffmpeg error",
            detail: err.message,
          });
        })
        .mergeToFile(outputPath);
    } catch (err) {
      console.error("SERVER ERROR:", err);
      res.status(500).json({
        error: err.message || "Server error",
      });
    }
  }
);

// Koyeb のポート対応
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});