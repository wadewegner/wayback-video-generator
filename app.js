const express = require("express");
const axios = require("axios");
const puppeteer = require("puppeteer-core");
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
const eventId = new Date().toISOString();

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
    client.res.write(`id: ${eventId}\n`);
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
    const cachedTimestamps = imageCache[urlHash] || [];

    console.log(`${cachedTimestamps.length} timestamps already in cache`);

    if (isQuickTest) {
      timestamps = timestamps.slice(-10);
      console.log(
        `Quick test mode: limited to ${timestamps.length} timestamps`
      );
    }

    console.log("2. Processing screenshots...");
    sendSSE({
      status: "processing",
      message: "Processing screenshots...",
      current: 0,
      total: timestamps.length,
    });
    const screenshotResults = await captureScreenshots(
      url,
      timestamps,
      0,
      timestamps.length
    );

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
  res.write(`id: ${eventId}\n`);
  res.write("event: connected\n");
  res.write(`data: ${JSON.stringify({ message: "Connected to SSE" })}\n\n`);

  const clientId = Date.now();
  const newClient = { id: clientId, res };
  clients.push(newClient);

  req.on("close", () => {
    console.log(`${clientId} Connection closed`);
    clients = clients.filter((client) => client.id !== clientId);
  });

  // Send a ping every 30 seconds to keep the connection alive
  const intervalId = setInterval(() => {
    res.write(`event: ping\n`);
    res.write(`data: ${new Date().toISOString()}\n\n`);
  }, 30000);

  req.on("close", () => {
    clearInterval(intervalId);
  });
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});

async function fetchWaybackTimestamps(url) {
  console.log(`Fetching Wayback Machine timestamps for ${url}`);
  try {
    const encodedUrl = encodeURIComponent(url);
    const apiUrl = `http://web.archive.org/cdx/search/cdx?url=${encodedUrl}&output=json&fl=timestamp&filter=statuscode:200&collapse=timestamp:8`;
    console.log(`API URL: ${apiUrl}`);
    
    const response = await axios.get(apiUrl, {
      timeout: 60000, // Increase timeout to 60 seconds
      headers: {
        'User-Agent': 'Wayback Machine Movie Maker/1.0'
      }
    });
    
    console.log("Received response from Wayback Machine API");
    if (!response.data || response.data.length <= 1) {
      console.log("No archived versions found");
      throw new Error("No archived versions found for this URL");
    }
    console.log(`Found ${response.data.length - 1} timestamps`);
    return response.data.slice(1).map((item) => item[0]);
  } catch (error) {
    console.error("Error in fetchWaybackTimestamps:", error.message);
    throw error;
  }
}

async function captureScreenshots(url, timestamps, startCount, totalCount) {
  console.log("Preparing screenshots");
  const urlHash = crypto.createHash("md5").update(url).digest("hex");
  const siteDir = path.join(__dirname, "screenshots", urlHash);
  if (!fsSync.existsSync(siteDir)) {
    console.log(`Creating directory for site: ${siteDir}`);
    fsSync.mkdirSync(siteDir, { recursive: true });
  }

  const screenshotResults = [];
  const imageCache = await loadImageCache();
  const cachedTimestamps = imageCache[urlHash] || [];

  // Only launch the browser if we need to capture new screenshots
  if (!global.browser) {
    console.log("Launching browser for screenshot capture");
    const launchOptions = {
      executablePath: '/usr/bin/google-chrome-stable',
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      defaultViewport: { width: 1920, height: 1080 },
    };

    try {
      global.browser = await puppeteer.launch(launchOptions);
      console.log("Browser launched successfully");
    } catch (error) {
      console.error('Failed to launch browser:', error);
      throw error;
    }
  }

  for (let i = 0; i < timestamps.length; i++) {
    const timestamp = timestamps[i];
    const screenshotFilename = `screenshot_${timestamp}.png`;
    const screenshotPath = path.join(siteDir, screenshotFilename);

    if (
      cachedTimestamps.includes(timestamp) &&
      fsSync.existsSync(screenshotPath)
    ) {
      console.log(`Using cached screenshot for ${timestamp}`);
      screenshotResults.push({ timestamp, path: screenshotPath });
    } else {
      // Only launch the browser if we need to capture new screenshots
      if (!global.browser) {
        console.log("Launching browser for screenshot capture");
        const launchOptions = {
          args: ["--no-sandbox", "--disable-setuid-sandbox"],
          defaultViewport: { width: 1920, height: 1080 },
        };

        // Check if running on DigitalOcean
        if (process.env.DIGITAL_OCEAN === "true") {
          launchOptions.executablePath = "/usr/bin/google-chrome";
        }

        global.browser = await puppeteer.launch(launchOptions);
      }

      const waybackUrl = `http://web.archive.org/web/${timestamp}/${url}`;

      try {
        console.log(`Capturing screenshot for ${waybackUrl}`);
        const page = await global.browser.newPage();
        const userAgent = new UserAgent();
        await page.setUserAgent(userAgent.toString());

        await page.goto(waybackUrl, {
          waitUntil: ["load", "domcontentloaded", "networkidle0"],
          timeout: 60000, // 60 seconds timeout
        });

        await new Promise(resolve => setTimeout(resolve, 5000));

        await page.screenshot({ path: screenshotPath, fullPage: true });
        await page.close();

        console.log(`Screenshot saved: ${screenshotPath}`);
        screenshotResults.push({ timestamp, path: screenshotPath });
        await updateImageCache(urlHash, timestamp);
      } catch (error) {
        console.error(`Error capturing screenshot for ${timestamp}:`, error);
        if (error instanceof TimeoutError) {
          console.log(`Timeout occurred for ${waybackUrl}. Skipping this screenshot.`);
          sendSSE({
            status: 'warning',
            message: `Timeout occurred for ${new Date(timestamp.slice(0, 4), timestamp.slice(4, 6) - 1, timestamp.slice(6, 8)).toLocaleString("default", { month: "long", year: "numeric" })}. Skipping this screenshot.`
          });
        } else {
          sendSSE({
            status: 'warning',
            message: `Error capturing screenshot for ${new Date(timestamp.slice(0, 4), timestamp.slice(4, 6) - 1, timestamp.slice(6, 8)).toLocaleString("default", { month: "long", year: "numeric" })}. Skipping this screenshot.`
          });
        }
      }
    }

    sendSSE({
      status: "processing",
      current: startCount + i + 1,
      total: totalCount,
      date: new Date(
        timestamp.slice(0, 4),
        timestamp.slice(4, 6) - 1,
        timestamp.slice(6, 8)
      ).toLocaleString("default", { month: "long", year: "numeric" }),
    });

    // Add a small delay between requests to respect rate limit
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  if (global.browser) {
    console.log("Closing browser");
    await global.browser.close();
    global.browser = null;
  }

  return screenshotResults;
}

async function generateVideo(url, screenshotResults) {
  console.log("Generating video from screenshots");
  const urlHash = crypto.createHash("md5").update(url).digest("hex");
  const outputPath = path.join(__dirname, "public", `${urlHash}_output.mp4`);

  // Sort screenshots by timestamp
  screenshotResults.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  console.log(`Number of screenshots: ${screenshotResults.length}`);

  if (screenshotResults.length === 0) {
    throw new Error("No screenshots captured. Cannot generate video.");
  }

  // Create a temporary file with the list of images
  const listFilePath = path.join(__dirname, `${urlHash}_images.txt`);
  const fileContent = screenshotResults
    .map((result) => `file '${result.path}'`)
    .join("\n");

  try {
    // Write the file content and log it
    await fs.writeFile(listFilePath, fileContent);
    console.log("Content of images.txt:");
    console.log(fileContent);

    // Check if the file exists and is readable
    await fs.access(listFilePath, fs.constants.R_OK);
    console.log(`File ${listFilePath} exists and is readable`);

    //for paddy

    return new Promise((resolve, reject) => {
      const ffmpegCommand = ffmpeg();

      // Check if running on DigitalOcean
      const isDigitalOcean = process.env.DIGITAL_OCEAN === "true";

      if (isDigitalOcean) {
        ffmpegCommand.setFfmpegPath("/usr/bin/ffmpeg");
      }

      let framesProcessed = 0;
      const totalFrames = screenshotResults.length;

      ffmpegCommand
        .input(listFilePath)
        .inputOptions(["-f concat", "-safe 0"])
        .inputFPS(1)
        .videoFilters([
          // Crop to 16:9 aspect ratio, focusing on the top of the image
          "crop=iw:iw*9/16:0:0",
          // Scale to 1920x1080 while maintaining aspect ratio
          "scale=1920:1080:force_original_aspect_ratio=decrease",
          // Pad to 1920x1080 if necessary
          "pad=1920:1080:(ow-iw)/2:(oh-ih)/2",
        ])
        .output(outputPath)
        .videoCodec("libx264")
        .outputOptions("-pix_fmt yuv420p") // Ensure compatibility
        .on("start", (commandLine) => {
          console.log("FFmpeg process started:", commandLine);
        })
        .on("progress", (progress) => {
          framesProcessed++;
          const percent = Math.min(
            100,
            Math.round((framesProcessed / totalFrames) * 100)
          );
          console.log(`FFmpeg progress: ${percent}% done`);
          sendSSE({
            status: "generating",
            message: `Generating video: ${percent}% complete`,
          });
        })
        .on("end", () => {
          console.log("FFmpeg process completed");
          // Clean up the temporary file
          fs.unlink(listFilePath);
          resolve(`/${urlHash}_output.mp4`);
        })
        .on("error", (err) => {
          console.error("FFmpeg error:", err);
          // Clean up the temporary file in case of error
          fs.unlink(listFilePath);
          reject(err);
        })
        .run();
    });
  } catch (error) {
    console.error("Error in generateVideo:", error);
    throw error;
  }
}

module.exports = app;
