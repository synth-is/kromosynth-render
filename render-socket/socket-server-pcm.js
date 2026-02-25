import { server as WebSocket } from 'websocket';
import { createServer } from 'http';
import { 
  generateAudioDataFromGenomeString
} from './rendering-common.js';
import fetch from 'node-fetch';
import { log } from 'console';
import zlib from 'zlib'; // Add zlib for decompression

// Create a plain HTTP server that can also handle health checks
const server = createServer((req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

const wsServer = new WebSocket({ httpServer: server });

wsServer.on('request', (request) => {
  const connection = request.accept(null, request.origin);

  connection.on('message', async (message) => {
    if (message.type === 'utf8') {
      const data = JSON.parse(message.utf8Data);

      if (data.type === 'get_audio_data') {
        // Process the request for audio data here
        let audioData;
        try {
          audioData = await generateAudioData(data);
        } catch( error ) {
          console.error(error);
        }
        if( audioData ) {
          // Convert the audio data to PCM (assuming audioData is already in the proper format)
          const pcmData = convertToPCM(audioData);
          // console.log('pcmData:', pcmData);
          // Send the audio data back to the client
          const buffer = Buffer.from(pcmData);
          connection.sendBytes(buffer);
        } else {
          connection.sendBytes(Buffer.from([]));
        }
      } else {
        console.log('Unknown message type:', data.type);
      }
    }
  });

  connection.on('close', () => {
    console.log('Connection closed');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`WebSocket server listening on port ${PORT}`);
});

// Function to generate or fetch audio data
async function generateAudioData( audioRenderRequest ) {
  const {
    genomeStringUrl,
    genomeString: inlineGenomeString, // Accept genome data directly (from AudioRenderingService)
    duration,
    noteDelta,
    velocity,
    reverse,
    useOvertoneInharmonicityFactors,
    overrideGenomeDurationNoteDeltaAndVelocity,
    useGPU,
    antiAliasing,
    frequencyUpdatesApplyToAllPathcNetworkOutputs,
    sampleRate
  } = audioRenderRequest;

  let genomeString;

  if (inlineGenomeString) {
    // Genome data provided directly (string or object)
    genomeString = typeof inlineGenomeString === 'string'
      ? inlineGenomeString
      : JSON.stringify(inlineGenomeString);
    console.log('Using inline genome string, length:', genomeString.length);
  } else if (genomeStringUrl) {
    // Fetch genome from URL
    genomeString = await downloadString(genomeStringUrl);
    console.log('genomeStringUrl:', genomeStringUrl);
    // Check if the genomeStringUrl points to a .gz file and decompress if necessary
    if (genomeStringUrl.endsWith('.gz')) {
      genomeString = await decompressString(genomeString);
    } else if (Buffer.isBuffer(genomeString)) {
      genomeString = genomeString.toString('utf-8');
    }
  } else {
    throw new Error('Either genomeStringUrl or genomeString must be provided');
  }

  console.log('Request parameters:', {
    duration, noteDelta, velocity, reverse,
    useOvertoneInharmonicityFactors, useGPU, antiAliasing,
    frequencyUpdatesApplyToAllPathcNetworkOutputs, sampleRate,
    genomeSource: inlineGenomeString ? 'inline' : genomeStringUrl
  });

  return generateAudioDataFromGenomeString(
    genomeString,
    duration,
    noteDelta,
    velocity,
    reverse,
    useOvertoneInharmonicityFactors,
    overrideGenomeDurationNoteDeltaAndVelocity,
    useGPU,
    antiAliasing,
    frequencyUpdatesApplyToAllPathcNetworkOutputs,
    sampleRate
  );
}

function convertToPCM(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels;
  console.log('numChannels:', numChannels);
  const numSamples = audioBuffer.length;
  console.log('numSamples:', numSamples);
  // Int16Array: one element per sample per channel (each element IS a 16-bit value)
  const pcmData = new Int16Array(numChannels * numSamples);
  console.log('pcmData.length:', pcmData.length);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = audioBuffer.getChannelData(channel);

    for (let sample = 0; sample < numSamples; sample++) {
      const pcmSample = Math.round(Math.max(-1, Math.min(1, channelData[sample])) * 0x7FFF);
      // Interleaved layout: [ch0_s0, ch1_s0, ch0_s1, ch1_s1, ...]
      pcmData[sample * numChannels + channel] = pcmSample;
    }
  }

  return pcmData;
}

async function downloadString(url) {
  // Replace localhost/127.0.0.1:3004 with the appropriate server URL
  // In Docker: use service name (e.g., 'http://evorun-browser-server:3004')
  // On bare metal: use 127.0.0.1 to avoid IPv6 issues
  const evorunsServerUrl = process.env.EVORUNS_SERVER_URL || 'http://127.0.0.1:3004';
  
  // Replace both localhost and 127.0.0.1 patterns to ensure consistency
  const processedUrl = url.replace(/http:\/\/(localhost|127\.0\.0\.1):3004/g, evorunsServerUrl);
  
  console.log('Downloading string from:', processedUrl);
  try {
    const response = await fetch(processedUrl);
    if (!response.ok) {
      throw new Error(`Request failed with status code ${response.status}`);
    }

    // If the URL ends with .json.gz, treat as compressed file (buffer)
    if (url.endsWith('.json.gz')) {
      const arrayBuffer = await response.arrayBuffer();
      return Buffer.from(arrayBuffer);
    } else {
      // For .json files or REST service endpoints, return as string
      const text = await response.text();
      return text;
    }
  } catch (error) {
    throw new Error(`Error downloading string: ${error.message}`);
  }
}

// Function to decompress a gzipped string
async function decompressString(buffer) {
  return new Promise((resolve, reject) => {
    zlib.gunzip(buffer, (err, decompressedBuffer) => {
      if (err) {
        return reject(new Error(`Error decompressing string: ${err.message}`));
      }
      resolve(decompressedBuffer.toString());
    });
  });
}