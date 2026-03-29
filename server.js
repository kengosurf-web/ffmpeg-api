import express from "express";
import multer from "multer";
import ffmpeg from "fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import { PassThrough } from "stream";

const app = express();
const upload = multer();

ffmpeg.setFfmpegPath(ffmpegPath);

app.post("/concat", upload.fields([{ name: "fact" }, { name: "opinion" }]), (req, res) => {
  const fact = req.files["fact"][0];
  const opinion = req.files["opinion"][0];

  const outputStream = new PassThrough();
  res.set("Content-Type", "audio/mpeg");

  ffmpeg()
    .input(fact.buffer)
    .input(opinion.buffer)
    .on("error", err => {
      console.error(err);
      res.status(500).send(err.message);
    })
    .on("end", () => {
      console.log("concat done");
    })
    .format("mp3")
    .pipe(outputStream);

  outputStream.pipe(res);
});

app.listen(3000, () => console.log("FFmpeg API running on port 3000"));