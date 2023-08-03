import { server as WebSocket } from 'websocket';
import { createServer } from 'http';
import { getAudioContext, getNewOfflineAudioContext } from './rendering-common.js';
import fetch from 'node-fetch';
import { getAudioBufferFromGenomeAndMeta } from 'kromosynth';
import { log } from 'console';

// Create a plain HTTP server (not serving any additional files)
const server = createServer();

const wsServer = new WebSocket({ httpServer: server });

wsServer.on('request', (request) => {
  const connection = request.accept(null, request.origin);

  connection.on('message', async (message) => {
    if (message.type === 'utf8') {
      const data = JSON.parse(message.utf8Data);

      if (data.type === 'get_audio_data') {
        // Process the request for audio data here
        const audioData = await generateAudioData(data);

        // Convert the audio data to PCM (assuming audioData is already in the proper format)
        const pcmData = convertToPCM(audioData);
        console.log('pcmData:', pcmData);
        // Send the audio data back to the client
        const buffer = Buffer.from(pcmData);
        connection.sendBytes(buffer);
      } else {
        console.log('Unknown message type:', data.type);
      }
    }
  });

  connection.on('close', () => {
    console.log('Connection closed');
  });
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`WebSocket server listening on port ${PORT}`);
});

// Function to generate or fetch audio data (you need to implement this based on your use case)
async function generateAudioData( audioRenderRequest ) {
  const {
    genomeStringUrl,
    duration,
    noteDelta,
    velocity,
    reverse,
    useOvertoneInharmonicityFactors
  } = audioRenderRequest;
  // ... Generate or fetch the audio data ...
  const genomeString = await downloadString(genomeStringUrl);
  console.log('genome string:', genomeString);
  const genome = JSON.parse(genomeString);
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
  return audioBuffer;
}

// Function to convert audio data to PCM
// function convertToPCM(audioBuffer) {
//   const numChannels = audioBuffer.numberOfChannels;
//   console.log('numChannels:', numChannels);
//   const numSamples = audioBuffer.length;
//   console.log('numSamples:', numSamples);
//   const sampleRate = audioBuffer.sampleRate;
//   const bitDepth = 16; // 16-bit PCM

//   const pcmData = new ArrayBuffer(numSamples * numChannels * (bitDepth / 8));
//   const dataView = new DataView(pcmData);

//   for (let channel = 0; channel < numChannels; channel++) {
//     const channelData = audioBuffer.getChannelData(channel);
//     const offset = channel * numSamples;

//     for (let sample = 0; sample < numSamples; sample++) {
//       const pcmValue = Math.max(-1, Math.min(1, channelData[sample])); // Clamp audio samples to the range [-1, 1]

//       if (bitDepth === 16) {
//         const intValue = pcmValue < 0 ? pcmValue * 0x8000 : pcmValue * 0x7FFF;
//         dataView.setInt16(offset + sample, intValue, true); // true for little-endian
//       } else if (bitDepth === 32) {
//         dataView.setFloat32(offset + sample, pcmValue, true); // true for little-endian
//       }
//     }
//   }

//   return pcmData;
// }

// function convertToPCM(audioBuffer) {
//   const numChannels = audioBuffer.numberOfChannels;
//   console.log('numChannels:', numChannels);
//   const numSamples = audioBuffer.length;
//   console.log('numSamples:', numSamples);
//   const pcmData = new Int16Array(numChannels * numSamples);

//   for (let channel = 0; channel < numChannels; channel++) {
//     const channelData = audioBuffer.getChannelData(channel);

//     for (let sample = 0; sample < numSamples; sample++) {
//       const pcmValue = Math.max(-1, Math.min(1, channelData[sample])); // Clamp audio samples to the range [-1, 1]
//       pcmData[sample * numChannels + channel] = pcmValue * 0x7FFF; // Convert to 16-bit PCM
//     }
//   }

//   return pcmData;
// }

function convertToPCM(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels;
  console.log('numChannels:', numChannels);
  const numSamples = audioBuffer.length;
  console.log('numSamples:', numSamples);
  const pcmData = new Int16Array(numChannels * numSamples * 2);
  console.log('pcmData.length:', pcmData.length);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = audioBuffer.getChannelData(channel);

    log('channelData:', channelData);

    for (let sample = 0; sample < numSamples; sample++) {
      const pcmSample = Math.max(-1, Math.min(1, channelData[sample])) * 0x7FFF; // Convert to 16-bit PCM

      const index = (sample * numChannels + channel) * 2; // Multiply by 2 for 16-bit PCM
      pcmData[index] = pcmSample;
      pcmData[index + 1] = pcmSample >> 8; // Shift the high byte to the second position
    }
  }

  return pcmData;
}




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