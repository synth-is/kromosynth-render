import { parentPort, workerData } from 'worker_threads';
import { generateAudioDataFromGenomeString } from './rendering-common.js';
import zlib from 'zlib';
import { promisify } from 'util';

const gunzip = promisify(zlib.gunzip);

// Process audio rendering requests
parentPort.on('message', async (data) => {
  try {
    const {
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
      sampleRate,
      isCompressed
    } = data;
    
    let processedGenomeString = genomeString;
    
    // Decompress if necessary
    if (isCompressed) {
      const buffer = Buffer.from(genomeString);
      const decompressedBuffer = await gunzip(buffer);
      processedGenomeString = decompressedBuffer.toString();
    }
    
    // Generate audio data
    const audioBuffer = await generateAudioDataFromGenomeString(
      processedGenomeString,
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
    
    // Extract and serialize the audio data for transfer back to the main thread
    const serializedAudioBuffer = {
      length: audioBuffer.length,
      sampleRate: audioBuffer.sampleRate,
      duration: audioBuffer.duration,
      numberOfChannels: audioBuffer.numberOfChannels,
      channels: []
    };
    
    // Extract channel data
    for (let i = 0; i < audioBuffer.numberOfChannels; i++) {
      const channelData = audioBuffer.getChannelData(i);
      serializedAudioBuffer.channels.push(Array.from(channelData));
    }
    
    // Send the result back to the main thread
    parentPort.postMessage({ success: true, audioBuffer: serializedAudioBuffer });
  } catch (error) {
    parentPort.postMessage({ 
      success: false, 
      error: { 
        message: error.message, 
        stack: error.stack 
      } 
    });
  }
});
