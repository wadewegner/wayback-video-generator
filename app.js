const express = require("express");
const axios = require("axios");
const puppeteer = require("puppeteer");
const ffmpeg = require("fluent-ffmpeg");
const path = require("path");
const fs = require("fs").promises;
const fsSync = require("fs");
const crypto = require("crypto");
const UserAgent = require("user-agents");

const app = express();
const port = 3000;

app.use(express.json());
app.use(express.static("public"));

let clients = [];

const cacheFilePath = path.join(__dirname, "imageCache.json");

async function loadImageCache() {
  try {
    const data = await fs.readFile(cacheFilePath, "utf8");
    return JSON.parse(data);
  } catch (error) {
    console.log("No existing cache found. Creating a new one.");
    return {};
  }
}

async function saveImageCache(cache) {
  await fs.writeFile(cacheFilePath, JSON.stringify(cache, null, 2));
}

async function updateImageCache(urlHash, timestamp) {
  const cache = await loadImageCache();
  if (!cache[urlHash]) {
    cache[urlHash] = [];
  }
  if (!cache[urlHash].includes(timestamp)) {
    cache[urlHash].push(timestamp);
    await saveImageCache(cache);
  }
}

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

    const urlHash = crypto.createHash("md5").update(url).digest("hex");
    const imageCache = await loadImageCache();
    const cachedTimestamps = new Set(imageCache[urlHash] || []);

    timestamps = timestamps.filter(
      (timestamp) => !cachedTimestamps.has(timestamp)
    );
    console.log(
      `${timestamps.length} new timestamps to process after filtering cached ones`
    );

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
    const screenshotResults = await captureScreenshots(url, timestamps);

    console.log("3. Generating video from screenshots...");
    sendSSE({
      status: "generating",
      message: "Generating video from screenshots...",
    });
    const videoPath = await generateVideo(url, screenshotResults);

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

  const urlHash = crypto.createHash("md5").update(url).digest("hex");
  const siteDir = path.join(__dirname, "screenshots", urlHash);
  if (!fsSync.existsSync(siteDir)) {
    console.log(`Creating directory for site: ${siteDir}`);
    fsSync.mkdirSync(siteDir, { recursive: true });
  }

  const screenshotResults = [];
  let requestCount = 0;
  let lastRequestTime = Date.now();

  for (let i = 0; i < timestamps.length; i++) {
    const timestamp = timestamps[i];
    const waybackUrl = `http://web.archive.org/web/${timestamp}/${url}`;
    const screenshotFilename = `screenshot_${timestamp}.png`;
    const screenshotPath = path.join(siteDir, screenshotFilename);

    // Check rate limit
    if (requestCount >= 15) {
      const elapsedTime = Date.now() - lastRequestTime;
      if (elapsedTime < 60000) {
        const delayTime = 60000 - elapsedTime;
        console.log(
          `Rate limit reached. Waiting for ${delayTime}ms before next request.`
        );
        await new Promise((resolve) => setTimeout(resolve, delayTime));
      }
      requestCount = 0;
      lastRequestTime = Date.now();
    }

    let retries = 3;
    while (retries > 0) {
      try {
        console.log(`Capturing screenshot for ${waybackUrl}`);

        // Set a random user agent
        const userAgent = new UserAgent();
        await page.setUserAgent(userAgent.toString());

        await page.goto(waybackUrl, {
          waitUntil: ["load", "domcontentloaded", "networkidle0"],
          timeout: 120000, // 2 minutes timeout
        });

        // Use setTimeout instead of waitForTimeout
        await new Promise((resolve) => setTimeout(resolve, 5000));

        await page.screenshot({ path: screenshotPath, fullPage: true });
        console.log(`Screenshot saved: ${screenshotPath}`);
        screenshotResults.push({ timestamp, path: screenshotPath });
        await updateImageCache(urlHash, timestamp);
        requestCount++;
        break;
      } catch (error) {
        console.error(`Error capturing screenshot for ${timestamp}:`, error);
        retries--;
        if (retries > 0) {
          const delay = Math.pow(2, 3 - retries) * 1000; // Exponential backoff
          console.log(`Retrying in ${delay / 1000} seconds...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          sendSSE({
            status: "warning",
            message: `Failed to capture screenshot for ${timestamp}: ${error.message}`,
            current: i + 1,
            total: timestamps.length,
          });
        }
      }
    }

    const date = new Date(
      timestamp.slice(0, 4),
      timestamp.slice(4, 6) - 1,
      timestamp.slice(6, 8)
    );
    sendSSE({
      status: "processing",
      current: i + 1,
      total: timestamps.length,
      date: date.toLocaleString("default", { month: "long", year: "numeric" }),
    });

    // Add a small delay between requests to respect rate limit
    await new Promise((resolve) => setTimeout(resolve, 1000)); // 1 second delay
  }

  console.log("Closing browser");
  await browser.close();

  return screenshotResults;
}

async function generateVideo(url, screenshotResults) {
  console.log("Generating video from screenshots");
  const urlHash = crypto.createHash("md5").update(url).digest("hex");
  const outputPath = path.join(__dirname, "public", `${urlHash}_output.mp4`);

  // Sort screenshots by timestamp
  screenshotResults.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return new Promise((resolve, reject) => {
    const ffmpegCommand = ffmpeg();

    // Check if running on DigitalOcean (you might need to adjust this check)
    const isDigitalOcean = process.env.DIGITAL_OCEAN === "true";

    if (isDigitalOcean) {
      ffmpegCommand.setFfmpegPath("/usr/bin/ffmpeg");
    }

    // Create a temporary file with the list of images
    const listFilePath = path.join(__dirname, `${urlHash}_images.txt`);
    const fileContent = screenshotResults
      .map((result) => `file '${result.path}'`)
      .join("\n");
    fsSync.writeFileSync(listFilePath, fileContent);

    ffmpegCommand
      .input(listFilePath)
      .inputOptions(["-f concat", "-safe 0"])
      .inputFPS(1)
      .output(outputPath)
      .videoCodec("libx264")
      .outputOptions("-pix_fmt yuv420p") // Ensure compatibility
      .on("start", (commandLine) => {
        console.log("FFmpeg process started:", commandLine);
      })
      .on("progress", (progress) => {
        console.log(`FFmpeg progress: ${progress.percent}% done`);
        sendSSE({
          status: "generating",
          message: `Generating video: ${Math.round(
            progress.percent
          )}% complete`,
        });
      })
      .on("end", () => {
        console.log("FFmpeg process completed");
        // Clean up the temporary file
        fsSync.unlinkSync(listFilePath);
        resolve(`/${urlHash}_output.mp4`);
      })
      .on("error", (err) => {
        console.error("FFmpeg error:", err);
        // Clean up the temporary file in case of error
        if (fsSync.existsSync(listFilePath)) {
          fsSync.unlinkSync(listFilePath);
        }
        reject(err);
      })
      .run();
  });
}

module.exports = app;
