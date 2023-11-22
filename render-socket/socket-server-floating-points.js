import { WebSocketServer } from "ws";
import { generateAudioDataFromGenomeString } from "./rendering-common.js";
import parseArgs from 'minimist';
const argv = parseArgs(process.argv.slice(2));
let port;
let host;
if( argv.hostInfoFilePath ) {
  // automatically assign port and write the info to the specified file path
  console.log("--- argv.hostInfoFilePath:", argv.hostInfoFilePath);
  port = 30051;
  argv.hostInfoFilePath.substring(argv.hostInfoFilePath.lastIndexOf("host-")+5).split("-").reverse().forEach( (i, idx) => port += parseInt(i) * (idx+1*10) );
  host = os.hostname();
  console.log("--- hostname:", host);
  fs.writeFile(argv.hostInfoFilePath, host, () => console.log(`Wrote hostname to ${argv.hostInfoFilePath}`));
} else {
  port = argv.port || process.env.PORT || '30051';
  host = "0.0.0.0";
}
const processTitle = argv.processTitle || 'kromosynth-render-socket-server';
process.title = processTitle;
process.on('SIGINT', () => process.exit(1)); // so it can be stopped with Ctrl-C

const wss = new WebSocketServer({ host, port });

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
    ).catch( error => {
      console.error(error);
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