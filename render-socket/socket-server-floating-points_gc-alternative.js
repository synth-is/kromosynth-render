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
  console.log("--- argv.hostInfoFilePath:", argv.hostInfoFilePath);
  port = await filepathToPort(argv.hostInfoFilePath);
  host = os.hostname();
  const hostname = `${host}:${port}`;
  console.log("--- hostname:", hostname);
  fs.writeFile(argv.hostInfoFilePath, hostname, (err) => {
    if (err) {
      console.error(`Error writing to ${argv.hostInfoFilePath}:`, err);
    } else {
      console.log(`Wrote hostname to ${argv.hostInfoFilePath}`);
    }
  });
} else {
  port = argv.port || process.env.PORT || '30051';
  host = "0.0.0.0";
}

const processTitle = argv.processTitle || 'kromosynth-render-socket-server';
process.title = processTitle;
process.on('SIGINT', () => process.exit(1));

const MAX_CONNECTIONS = 100;  // Adjust based on your server's capacity
const IDLE_TIMEOUT = 300000;  // 5 minutes in milliseconds

const wss = new WebSocketServer({ 
  host, 
  port,
  maxPayload: 50 * 1024 * 1024 // Reduced to 50 MB, adjust as needed
});

let requestCount = 0;

wss.on("connection", async function connection(ws) {
  if (wss.clients.size > MAX_CONNECTIONS) {
    ws.close(1013, "Maximum number of connections reached");
    return;
  }

  let isAlive = true;
  ws.on('pong', () => { isAlive = true; });

  const pingInterval = setInterval(() => {
    if (!isAlive) {
      clearInterval(pingInterval);
      return ws.terminate();
    }
    isAlive = false;
    ws.ping();
  }, IDLE_TIMEOUT);

  ws.on('error', function(err) {
    console.error("WebSocket error:", err);
    ws.send(JSON.stringify({error: err.message}));
    ws.close();
  });

  ws.on("message", async function incoming(message) {
    requestCount++;
    const messageParsed = JSON.parse(message);
    console.log(`rendering sound from genome at duration ${messageParsed.duration} with noteDelta ${messageParsed.noteDelta}, velocity ${messageParsed.velocity} and sample rate ${messageParsed.sampleRate}...`);
    
    const {
      genomeString,
      duration,
      noteDelta,
      velocity,
      useGPU,
      antiAliasing,
      frequencyUpdatesApplyToAllPathcNetworkOutputs,
      sampleRate
    } = messageParsed;
    
    try {
      const audioBuffer = await generateAudioDataFromGenomeString(
        genomeString,
        duration,
        noteDelta,
        velocity,
        false, // reverse
        true, // useOvertoneInharmonicityFactors
        false, // overrideGenomeDurationNoteDeltaAndVelocity
        useGPU,
        antiAliasing,
        frequencyUpdatesApplyToAllPathcNetworkOutputs,
        sampleRate
      );

      if (audioBuffer) {
        const audioData = new Float32Array(audioBuffer.getChannelData(0));
        const buffer = Buffer.from(audioData.buffer);
        
        ws.send(buffer, async () => {
          // Clear references to large objects after sending
          if (typeof audioBuffer.clear === 'function') {
            audioBuffer.clear();
          }
          audioData.fill(0);
          buffer.fill(0);
          
          // Suggest garbage collection
          if (global.gc && requestCount % 100 === 0) {
            global.gc();
            // sleep for 1 second to allow GC to complete
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        });
      } else {
        ws.send(null);
      }
    } catch (error) {
      console.error(error);
      ws.send(JSON.stringify({error: error.message}));
    }
  });

  ws.on('close', function() {
    clearInterval(pingInterval);
  });
});

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

  if(isTaken) {
    console.log(`--- filepathToPort(${filepath}): port ${port} taken`)
    return await filepathToPort(filepath, variation + 1);
  } else {
    console.log(`--- filepathToPort(${filepath}): port ${port} available`);
    return port;
  }
}

// Run with node --expose-gc to enable manual garbage collection