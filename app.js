const express = require("express");
const axios = require("axios");
const puppeteer = require("puppeteer");
const ffmpeg = require("fluent-ffmpeg");
const path = require("path");
const fs = require("fs");

const app = express();
const port = 3000;

app.use(express.json());
app.use(express.static("public"));

let clients = [];

function sendSSE(data) {
  console.log("Sending SSE data:", data);
  clients.forEach((client) => {
    client.res.write(`data: ${JSON.stringify(data)}\n\n`);
  });
}

app.post("/generate-video", async (req, res) => {
  console.log("Received request to generate video");
  const { url, isQuickTest } = req.body;
  console.log(`URL received: ${url}, Quick test: ${isQuickTest}`);

  res.json({ message: "Video generation started" });

  try {
    console.log("1. Fetching timestamps from Wayback Machine...");
    sendSSE({
      status: "fetching",
      message: "Fetching timestamps from Wayback Machine...",
    });
    let timestamps = await fetchWaybackTimestamps(url);
    console.log(`Fetched ${timestamps.length} timestamps`);

    if (timestamps.length === 0) {
      throw new Error("No archived versions found for this URL");
    }

    if (isQuickTest) {
      timestamps = timestamps.slice(0, 10);
      console.log(
        `Quick test mode: limited to ${timestamps.length} timestamps`
      );
    }

    console.log("2. Starting to capture screenshots...");
    sendSSE({
      status: "processing",
      message: "Starting to capture screenshots...",
      total: timestamps.length,
    });
    await captureScreenshots(url, timestamps);

    console.log("3. Generating video from screenshots...");
    sendSSE({
      status: "generating",
      message: "Generating video from screenshots...",
    });
    const videoPath = await generateVideo(timestamps.length);

    console.log("Video generation complete");
    sendSSE({ status: "complete", videoPath });
  } catch (error) {
    console.error("Error in /generate-video:", error);
    sendSSE({ status: "error", message: error.message });
  }
});

app.get("/progress", (req, res) => {
  console.log("SSE connection established");
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("\n");

  const clientId = Date.now();
  const newClient = { id: clientId, res };
  clients.push(newClient);

  req.on("close", () => {
    console.log(`${clientId} Connection closed`);
    clients = clients.filter((client) => client.id !== clientId);
  });
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

async function fetchWaybackTimestamps(url) {
  console.log(`Fetching Wayback Machine timestamps for ${url}`);
  try {
    const apiUrl = `http://web.archive.org/cdx/search/cdx?url=${url}&output=json&fl=timestamp&filter=statuscode:200&collapse=timestamp:6`;
    console.log(`API URL: ${apiUrl}`);
    const response = await axios.get(apiUrl);
    console.log("Received response from Wayback Machine API");
    if (!response.data || response.data.length <= 1) {
      console.log("No archived versions found");
      throw new Error("No archived versions found for this URL");
    }
    console.log(`Found ${response.data.length - 1} timestamps`);
    return response.data.slice(1).map((item) => item[0]);
  } catch (error) {
    console.error("Error in fetchWaybackTimestamps:", error);
    throw error;
  }
}

async function captureScreenshots(url, timestamps) {
  console.log("Launching browser for screenshot capture");
  const browser = await puppeteer.launch({
    executablePath: "/usr/bin/google-chrome",
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  const tempDir = path.join(__dirname, "temp");
  if (!fs.existsSync(tempDir)) {
    console.log(`Creating temporary directory: ${tempDir}`);
    fs.mkdirSync(tempDir);
  }

  for (let i = 0; i < timestamps.length; i++) {
    try {
      const timestamp = timestamps[i];
      const waybackUrl = `http://web.archive.org/web/${timestamp}/${url}`;
      console.log(`Capturing screenshot for ${waybackUrl}`);
      await page.goto(waybackUrl, {
        waitUntil: "networkidle0",
        timeout: 60000,
      });
      const screenshot = await page.screenshot({ fullPage: true });

      const filePath = path.join(tempDir, `screenshot_${i}.png`);
      fs.writeFileSync(filePath, screenshot);
      console.log(`Screenshot saved: ${filePath}`);

      const date = new Date(
        timestamp.slice(0, 4),
        timestamp.slice(4, 6) - 1,
        timestamp.slice(6, 8)
      );
      sendSSE({
        status: "processing",
        current: i + 1,
        total: timestamps.length,
        date: date.toLocaleString("default", {
          month: "long",
          year: "numeric",
        }),
      });
    } catch (error) {
      console.error(`Error capturing screenshot for ${timestamp}:`, error);
      sendSSE({
        status: "warning",
        message: `Failed to capture screenshot for ${timestamp}: ${error.message}`,
        current: i + 1,
        total: timestamps.length,
      });
    }
  }

  console.log("Closing browser");
  await browser.close();
}

async function generateVideo(totalFrames) {
  console.log("Generating video from screenshots");
  const tempDir = path.join(__dirname, "temp");
  const outputPath = path.join(__dirname, "public", "output.mp4");

  return new Promise((resolve, reject) => {
    const ffmpegCommand = ffmpeg();

    // Check if running on DigitalOcean (you might need to adjust this check)
    const isDigitalOcean = process.env.DIGITAL_OCEAN === "true";

    if (isDigitalOcean) {
      ffmpegCommand.setFfmpegPath("/usr/bin/ffmpeg");
    }

    ffmpegCommand
      .input(path.join(tempDir, "screenshot_%d.png"))
      .inputFPS(1)
      .output(outputPath)
      .videoCodec("libx264")
      .outputOptions("-pix_fmt yuv420p") // Ensure compatibility
      .on("start", (commandLine) => {
        console.log("FFmpeg process started:", commandLine);
      })
      .on("progress", (progress) => {
        console.log(`FFmpeg progress: ${progress.percent}% done`);
      })
      .on("end", () => {
        console.log("FFmpeg process completed");
        // Clean up temp files
        fs.readdirSync(tempDir).forEach((file) => {
          console.log(`Removing temp file: ${file}`);
          fs.unlinkSync(path.join(tempDir, file));
        });
        fs.rmdirSync(tempDir);
        console.log("Temporary directory removed");
        resolve("/output.mp4");
      })
      .on("error", (err) => {
        console.error("FFmpeg error:", err);
        reject(err);
      })
      .run();
  });
}
