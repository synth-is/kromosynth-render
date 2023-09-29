import { WebSocketServer } from "ws";
import { generateAudioDataFromGenomeString } from "./rendering-common.js";

const wss = new WebSocketServer({ port: 8080 });

// TODO: error handling

wss.on("connection", async function connection(ws) {
  console.log("connection");
  ws.on('error', console.error);
  ws.on("message", async function incoming(message) {
    const messageParsed = JSON.parse(message);
    console.log("received: %s", messageParsed);
    const {
      genomeString,
      duration,
      noteDelta,
      velocity
    } = messageParsed;
    const audioBuffer = await generateAudioDataFromGenomeString(
      genomeString,
      duration,
      noteDelta,
      velocity,
      false, // reverse
      true, // useOvertoneInharmonicityFactors
      false // overrideGenomeDurationNoteDeltaAndVelocity
    );
    const audioData = new Float32Array(audioBuffer.getChannelData(0)); // new Float32Array as the result from .getChannelData() seems to become detatched
    
    const buffer = Buffer.from(audioData.buffer);
    ws.send( buffer );
  });
});