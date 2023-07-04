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
    const audioBuffer = await getAudioBufferFromGenomeAndMeta(
			genome,
			duration, noteDelta, velocity, reverse,
			false, // asDataArray
			getNewOfflineAudioContext( duration ),
			getAudioContext(),
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
    call.write({ audio: audioData });
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
  server.bindAsync('0.0.0.0:50051', grpc.ServerCredentials.createInsecure(), () => {
    server.start();
    console.log('Rendering gRPC server running on port 50051');
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