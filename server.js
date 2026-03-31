import express from "express";
import axios from "axios";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import { v4 as uuidv4 } from "uuid";

const app = express();
app.use(express.json());

app.post("/merge", async (req, res) => {
  try {
    const { factUrl, opinionUrl } = req.body;

    if (!factUrl || !opinionUrl) {
      return res.status(400).json({ error: "Missing URLs" });
    }

    // 一時ファイル名
    const factPath = `/tmp/fact-${uuidv4()}.mp3`;
    const opinionPath = `/tmp/opinion-${uuidv4()}.mp3`;
    const outputPath = `/tmp/output-${uuidv4()}.mp3`;

    // ダウンロード
    const download = async (url, path) => {
      const response = await axios({ url, responseType: "arraybuffer" });
      fs.writeFileSync(path, response.data);
    };

    await download(factUrl, factPath);
    await download(opinionUrl, opinionPath);

    // ffmpeg 結合
    ffmpeg()
      .input(factPath)
      .input(opinionPath)
      .on("end", () => {
        const file = fs.readFileSync(outputPath);
        res.setHeader("Content-Type", "audio/mpeg");
        res.send(file);

        fs.unlinkSync(factPath);
        fs.unlinkSync(opinionPath);
        fs.unlinkSync(outputPath);
      })
      .on("error", (err) => {
        console.error(err);
        res.status(500).json({ error: "ffmpeg error" });
      })
      .mergeToFile(outputPath);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.listen(3000, () => console.log("API running on port 3000"));