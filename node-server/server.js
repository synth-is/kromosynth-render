import grpc from '@grpc/grpc-js';
import protoLoader from '@grpc/proto-loader';
import fetch from 'node-fetch';
// import { Readable } from 'stream'
import { getAudioBufferFromGenomeAndMeta } from 'kromosynth';
import { getAudioContext, getNewOfflineAudioContext } from './rendering-common.js';

const PROTO_PATH = './genome-rendering.proto';
const packageDefinition = protoLoader.loadSync(
  PROTO_PATH,
  {keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true}
);
const gene_proto = grpc.loadPackageDefinition(packageDefinition).kromosynthrendering;




function renderGenome( call ) {
  const { 
    genomeStringUrl,
    duration,
    noteDelta,
    velocity,
    reverse,
    useOvertoneInharmonicityFactors
  } = call.request;
  console.log('genome string url:', genomeStringUrl);
  console.log('duration:', duration);
  console.log('note delta:', noteDelta);
  console.log('velocity:', velocity);
  downloadString(genomeStringUrl)
  .then( async (data) => {
    console.log('genome string:', data);

    const genome = JSON.parse(data);
    const audioContext = await getAudioContext();
    const audioBuffer = await getAudioBufferFromGenomeAndMeta(
			genome,
			duration, noteDelta, velocity, reverse,
			false, // asDataArray
			getNewOfflineAudioContext( duration ),
			audioContext,
			useOvertoneInharmonicityFactors
		);

    console.log('audio buffer:', audioBuffer);

    // const audioStream = Readable.from(audioBuffer.getChannelData(0));
    // console.log('audioStream:', audioStream);
    // audioStream.on('data', (chunk) => {
    //   console.log('chunk:', chunk);
    //   call.write({ audio: chunk });
    // });
    // audioStream.on('end', () => {
    //   console.log('audioStream ended');
    //   call.end();
    // });

    const audioData = audioBuffer.getChannelData(0);
    console.log('audioData:', audioData);

    // // assume that the PCM data ranges from -1.0 to 1.0, and we convert it to a byte array in the range of 0 to 255 using (value + 1) * 127.5.
    // const pcmData = Uint8Array.from(audioData.map((value) => Math.round((value + 1) * 127.5)));

    // Convert PCM data to an array of integers in the range of [-32767, 32767]
    const intPcmData = new Uint8Array(audioData.map((value) => Math.round(value * 32767)));

    console.log('intPcmData:', intPcmData);
    call.write({ 
      audio: Buffer.from(intPcmData.buffer),
    });
    call.end();
  })
  .catch((error) => {
    console.error(error);
    call.end();
  });
}

function main() {
  const server = new grpc.Server();
  server.addService( gene_proto.KromosynthRendering.service, {
    renderGenome: renderGenome
  });
  server.bindAsync('0.0.0.0:9090', grpc.ServerCredentials.createInsecure(), () => {
    server.start();
    console.log('Rendering gRPC server running on port 9090');
  });
}

main();

async function downloadString(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Request failed with status code ${response.status}`);
    }
    return await response.text();
  } catch (error) {
    throw new Error(`Error downloading string: ${error.message}`);
  }
}