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
if( argv.hostInfoFilePath ) {
  // automatically assign port and write the info to the specified file path
  console.log("--- argv.hostInfoFilePath:", argv.hostInfoFilePath);
  let hostInfoFilePath;
  if( process.env.pm_id ) { // being managed by PM2
    hostInfoFilePath = `${argv.hostInfoFilePath}${parseInt(process.env.pm_id) + 1}`;
  } else {
    hostInfoFilePath = argv.hostInfoFilePath;
  }
  port = await filepathToPort( hostInfoFilePath );
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

const wss = new WebSocketServer({ 
  host, port,
  maxPayload: 100 * 1024 * 1024 // 100 MB
});

wss.on("connection", async function connection(ws) {
  // console.log("connection");
  ws.on('error', function(err) {
    console.error("WebSocket error:", err);
    ws.send( JSON.stringify({error: err}) );
    ws.close();
  });
  ws.on("message", async function incoming(message) {
    const messageParsed = JSON.parse(message);
    // console.log("received: %s", messageParsed);
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
    ).catch( error => {
      console.error(error);
      ws.send( null );
    });
    let buffer;
    if( audioBuffer ) {
      const audioData = new Float32Array(audioBuffer.getChannelData(0)); // new Float32Array as the result from .getChannelData() seems to become detatched
      buffer = Buffer.from(audioData.buffer);
    } else {
      buffer = null;
    }
    ws.send( buffer );
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
