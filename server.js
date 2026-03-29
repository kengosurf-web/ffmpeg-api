import express from "express";
import multer from "multer";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import fs from "fs";

// uploads フォルダが無ければ作成
if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

const app = express();
const upload = multer({ dest: "uploads/" });

ffmpeg.setFfmpegPath(ffmpegPath);

app.post("/concat", upload.fields([
  { name: "factAudio", maxCount: 1 },
  { name: "opinionAudio", maxCount: 1 }
]), (req, res) => {

  const fact = req.files["factAudio"][0].path;
  const opinion = req.files["opinionAudio"][0].path;

  const output = `uploads/merged_${Date.now()}.mp3`;

  ffmpeg()
    .input(fact)
    .input(opinion)
    .on("error", (err) => {
      console.error("FFmpeg error:", err);
      res.status(500).send("Error processing audio");
    })
    .on("end", () => {
      const file = fs.readFileSync(output);
      res.setHeader("Content-Type", "audio/mpeg");
      res.send(file);

      fs.unlinkSync(fact);
      fs.unlinkSync(opinion);
      fs.unlinkSync(output);
    })
    .mergeToFile(output);
});

app.listen(3000, () => {
  console.log("FFmpeg API running on port 3000");
});