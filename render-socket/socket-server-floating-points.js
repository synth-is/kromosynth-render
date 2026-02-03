import { WebSocketServer } from "ws";
import { generateAudioDataFromGenomeString } from "./rendering-common.js";
import parseArgs from 'minimist';
import os from "os";
import fs from "fs";
import crypto from 'crypto';
import net from 'net';
const argv = parseArgs(process.argv.slice(2));
let port;
let host;
if (argv.hostInfoFilePath) {
  // automatically assign port and write the info to the specified file path
  console.log("--- argv.hostInfoFilePath:", argv.hostInfoFilePath);
  let hostInfoFilePath;
  if (process.env.pm_id) { // being managed by PM2
    hostInfoFilePath = `${argv.hostInfoFilePath}${parseInt(process.env.pm_id) + 1}`;
  } else {
    hostInfoFilePath = argv.hostInfoFilePath;
  }
  port = await filepathToPort(hostInfoFilePath);
  host = argv.host || os.hostname();
  const hostname = `${host}:${port}`;
  console.log("--- hostname:", hostname);
  console.log("process.env.PM2_HOME", process.env.PM2_HOME);
  fs.writeFile(hostInfoFilePath, hostname, () => console.log(`Wrote hostname to ${hostInfoFilePath}`));
} else {
  port = argv.port || process.env.PORT || '30051';
  host = "0.0.0.0";
}
const processTitle = argv.processTitle || 'kromosynth-render-socket-server';
process.title = processTitle;
process.on('SIGINT', () => process.exit(1)); // so it can be stopped with Ctrl-C

// Server-side timeout (slightly longer than client timeout of 180s)
const RENDERING_TIMEOUT_MS = 200 * 1000; // 200 seconds
const MAX_CONCURRENT_JOBS = 2; // Limit concurrent rendering jobs per instance

let activeJobs = 0;
const pendingJobs = [];

const wss = new WebSocketServer({
  host, port,
  maxPayload: 100 * 1024 * 1024 // 100 MB
});

wss.on("connection", async function connection(ws) {
  let jobCancelled = false;
  let timeoutHandle = null;
  
  // Track when client disconnects to cancel ongoing job
  ws.on('close', () => {
    console.log('Client disconnected - marking job as cancelled');
    jobCancelled = true;
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  });
  
  ws.on('error', function (err) {
    console.error("WebSocket error:", err);
    jobCancelled = true;
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    try {
      ws.send(JSON.stringify({ error: err.message }));
    } catch (e) {
      // Socket may already be closed
    }
    ws.close();
  });
  
  ws.on("message", async function incoming(message) {
    // Check if we've exceeded max concurrent jobs
    if (activeJobs >= MAX_CONCURRENT_JOBS) {
      console.log(`Max concurrent jobs (${MAX_CONCURRENT_JOBS}) reached, queueing job...`);
      pendingJobs.push({ ws, message });
      return;
    }
    
    activeJobs++;
    console.log(`Starting job (${activeJobs}/${MAX_CONCURRENT_JOBS} active)`);
    const messageParsed = JSON.parse(message);
    console.log(`rendering sound from genome ${messageParsed.genomeId || 'inline'} at duration ${messageParsed.duration} with noteDelta ${messageParsed.noteDelta}, velocity ${messageParsed.velocity} and sample rate ${messageParsed.sampleRate}...`);

    const {
      genomeId,
      genomeString,
      duration,
      noteDelta,
      velocity,
      useGPU,
      antiAliasing,
      frequencyUpdatesApplyToAllPathcNetworkOutputs,
      sampleRate,
      sampleCountToActivate,
      sampleOffset,
    } = messageParsed;

    // Get genome either from genomeId (fetch from REST API) or genomeString (inline)
    let genomeData;
    if (genomeId) {
      // Fetch from REST API
      try {
        // REST API URL format: http://127.0.0.1:4004/evoruns/{evoRunId}/genome/{genomeId}?format=raw
        const EVORUNS_SERVER_URL = process.env.EVORUNS_SERVER_URL || 'http://127.0.0.1:4004';

        // We need the evoRunId to construct the URL
        // For now, we'll need to get it from the message or use a default
        // The streaming server gets this from the client request
        const evoRunId = messageParsed.evoRunId;

        if (!evoRunId) {
          ws.send(JSON.stringify({ error: 'evoRunId is required when using genomeId' }));
          return;
        }

        const genomeUrl = `${EVORUNS_SERVER_URL}/evoruns/${evoRunId}/genome/${genomeId}?format=raw`;
        console.log(`Fetching genome from: ${genomeUrl}`);

        const fetch = (await import('node-fetch')).default;
        const response = await fetch(genomeUrl);

        if (!response.ok) {
          throw new Error(`Failed to fetch genome: ${response.status} ${response.statusText}`);
        }

        const genomeJson = await response.text();
        genomeData = genomeJson;

        console.log(`✓ Loaded genome ${genomeId} from REST API`);
      } catch (error) {
        console.error(`Error loading genome ${genomeId}:`, error);
        ws.send(JSON.stringify({ error: error.message }));
        return;
      }
    } else if (genomeString) {
      // Use provided genome string
      genomeData = genomeString;
    } else {
      ws.send(JSON.stringify({ error: 'Must provide either genomeId or genomeString' }));
      return;
    }

    // Set server-side timeout
    timeoutHandle = setTimeout(() => {
      if (!jobCancelled) {
        console.error(`Rendering timeout (${RENDERING_TIMEOUT_MS}ms) exceeded - cancelling job`);
        jobCancelled = true;
        try {
          ws.send(JSON.stringify({ error: 'Server timeout: rendering took too long' }));
          ws.close();
        } catch (e) {
          // Socket may already be closed
        }
        activeJobs--;
        processNextJob();
      }
    }, RENDERING_TIMEOUT_MS);
    
    // Check if job was cancelled before starting
    if (jobCancelled) {
      console.log('Job cancelled before rendering started');
      clearTimeout(timeoutHandle);
      activeJobs--;
      processNextJob();
      return;
    }
    
    const audioBuffer = await generateAudioDataFromGenomeString(
      genomeData,
      duration,
      noteDelta,
      velocity,
      false, // reverse
      true, // useOvertoneInharmonicityFactors
      false, // overrideGenomeDurationNoteDeltaAndVelocity
      useGPU,
      antiAliasing,
      frequencyUpdatesApplyToAllPathcNetworkOutputs,
      sampleRate,
      true, // asDataArray
      sampleCountToActivate,
      sampleOffset,
    ).catch(error => {
      console.error(error);
      try {
        ws.send(JSON.stringify({ error: error.message }));
      } catch (e) {
        // Socket may already be closed
      }
      return null;
    });
    
    // Clear timeout if job completed
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    
    // Check if job was cancelled during rendering
    if (jobCancelled) {
      console.log('Job was cancelled during rendering - discarding result');
      activeJobs--;
      processNextJob();
      return;
    }

    let buffer;
    if (audioBuffer) {
      const audioData = audioBuffer;
      buffer = Buffer.from(audioData.buffer);
    } else {
      buffer = null;
    }
    
    // Only send if job wasn't cancelled
    if (!jobCancelled) {
      try {
        ws.send(buffer);
        ws.close();
      } catch (e) {
        console.error('Error sending response:', e.message);
      }
    }
    
    // Mark job as complete and process next in queue
    activeJobs--;
    console.log(`Job completed (${activeJobs}/${MAX_CONCURRENT_JOBS} active)`);
    
    // Force garbage collection if available (requires --expose-gc flag)
    if (global.gc) {
      global.gc();
    }
    
    // Process next job in queue if any
    processNextJob();
  });
});

// Process next pending job if available
function processNextJob() {
  if (pendingJobs.length > 0 && activeJobs < MAX_CONCURRENT_JOBS) {
    const { ws, message } = pendingJobs.shift();
    console.log(`Processing queued job (${pendingJobs.length} remaining in queue)`);
    // Trigger the message handler
    ws.emit('message', message);
  }
}

console.log(`Rendering WebSocket server listening on port ${port}`);


function isPortTaken(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
      .once('error', () => resolve(true))
      .once('listening', () => server.once('close', () => resolve(false)).close())
      .listen(port);
  });
}

async function filepathToPort(filepath, variation = 0) {
  let filepathVariation = filepath + variation.toString();
  let hash = crypto.createHash('md5').update(filepathVariation).digest("hex");
  let shortHash = parseInt(hash.substring(0, 8), 16);
  let port = 1024 + shortHash % (65535 - 1024);
  let isTaken = await isPortTaken(port);

  if (isTaken) {
    console.log(`--- filepathToPort(${filepath}): port ${port} taken`)
    return await filepathToPort(filepath, variation + 1);
  } else {
    console.log(`--- filepathToPort(${filepath}): port ${port} available`);
    return port;
  }
}
