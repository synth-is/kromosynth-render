import { server as WebSocket } from 'websocket';
import { createServer } from 'http';
import { 
  generateAudioDataFromGenomeString
} from './rendering-common.js';
import fetch from 'node-fetch';
import { log } from 'console';
import zlib from 'zlib'; // Add zlib for decompression
import { Worker } from 'worker_threads';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

// Get the directory name of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Create a pool of worker threads based on CPU cores
const numCores = os.cpus().length;
console.log(`Creating worker pool with ${numCores} workers based on available CPU cores`);

// Create a plain HTTP server that can also handle health checks
const server = createServer((req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      workers: {
        total: workerPool.length,
        available: availableWorkers.length,
        busy: workerPool.length - availableWorkers.length
      }
    }));
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

// Create and initialize worker thread pool
const workerPool = [];
let availableWorkers = [];
const taskQueue = [];

// Initialize worker pool
for (let i = 0; i < numCores; i++) {
  const workerPath = path.join(__dirname, 'audio-worker.js');
  const worker = new Worker(workerPath);
  
  worker.on('error', (err) => {
    console.error(`Worker ${i} error:`, err);
    // Replace the crashed worker with a new one
    const index = workerPool.indexOf(worker);
    if (index !== -1) {
      const newWorker = createWorker(i);
      workerPool[index] = newWorker;
      if (availableWorkers.includes(worker)) {
        const availableIndex = availableWorkers.indexOf(worker);
        availableWorkers[availableIndex] = newWorker;
      }
    }
  });
  
  worker.on('exit', (code) => {
    if (code !== 0) {
      console.error(`Worker ${i} stopped with exit code ${code}`);
    }
  });
  
  workerPool.push(worker);
  availableWorkers.push(worker);
}

// Helper function to create a new worker
function createWorker(id) {
  const workerPath = path.join(__dirname, 'audio-worker.js');
  const worker = new Worker(workerPath);
  
  worker.on('error', (err) => {
    console.error(`Worker ${id} error:`, err);
    // Replace the crashed worker
    const index = workerPool.indexOf(worker);
    if (index !== -1) {
      const newWorker = createWorker(id);
      workerPool[index] = newWorker;
      if (availableWorkers.includes(worker)) {
        const availableIndex = availableWorkers.indexOf(worker);
        availableWorkers[availableIndex] = newWorker;
      }
    }
  });
  
  worker.on('exit', (code) => {
    if (code !== 0) {
      console.error(`Worker ${id} stopped with exit code ${code}`);
    }
  });
  
  return worker;
}

// Process the next task in queue if workers are available
function processNextTask() {
  if (taskQueue.length > 0 && availableWorkers.length > 0) {
    const task = taskQueue.shift();
    const worker = availableWorkers.shift();
    
    worker.once('message', (result) => {
      // Return worker to available pool
      availableWorkers.push(worker);
      
      // Process result
      if (result.success) {
        task.resolve(result.audioBuffer);
      } else {
        task.reject(new Error(result.error.message));
      }
      
      // Process next task if any
      processNextTask();
    });
    
    // Send task to worker
    worker.postMessage(task.data);
  }
}

// Function to queue a task for processing
function queueRenderTask(data) {
  return new Promise((resolve, reject) => {
    taskQueue.push({
      data,
      resolve,
      reject
    });
    
    // Try to process immediately if workers are available
    processNextTask();
  });
}

const wsServer = new WebSocket({ httpServer: server });

wsServer.on('request', (request) => {
  const connection = request.accept(null, request.origin);
  console.log(`New connection accepted from ${request.origin}`);

  connection.on('message', async (message) => {
    if (message.type === 'utf8') {
      const data = JSON.parse(message.utf8Data);

      if (data.type === 'get_audio_data') {
        // Process the request for audio data here
        console.log(`Received audio rendering request. Queue status: ${taskQueue.length} pending tasks, ${availableWorkers.length}/${workerPool.length} workers available`);
        let audioData;
        try {
          audioData = await generateAudioData(data);
        } catch(error) {
          console.error('Error generating audio data:', error);
        }
        
        if(audioData) {
          // Convert the audio data to PCM (assuming audioData is already in the proper format)
          console.log('Converting audio data to PCM...');
          const pcmData = convertToPCM(audioData);
          console.log('PCM conversion complete, sending back to client');
          
          // Send the audio data back to the client
          const buffer = Buffer.from(pcmData);
          connection.sendBytes(buffer);
        } else {
          console.log('No audio data generated, sending empty buffer');
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
async function generateAudioData(audioRenderRequest) {
  const {
    genomeStringUrl,
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
  
  console.log('Request parameters:', {
    genomeStringUrl,
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
  });
  
  // Download genome string
  console.log('Downloading genome data from:', genomeStringUrl);
  let genomeString = await downloadString(genomeStringUrl);
  
  // Track if we need to decompress
  const isCompressed = genomeStringUrl.endsWith('.gz');
  
  // If buffer and not going to be decompressed by worker, convert to string
  if (!isCompressed && Buffer.isBuffer(genomeString)) {
    genomeString = genomeString.toString('utf-8');
  }
  
  console.log(`Genome data received (${isCompressed ? 'compressed' : 'uncompressed'}). Queueing for worker processing...`);
  
  // Instead of processing directly, queue for worker thread processing
  const serializedAudioBuffer = await queueRenderTask({
    genomeString: isCompressed ? genomeString : genomeString,
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
  });
  
  console.log('Audio rendering complete by worker thread');
  
  // Reconstruct the audio buffer from serialized data
  const audioBuffer = createAudioBufferFromSerialized(serializedAudioBuffer);
  return audioBuffer;
}

function convertToPCM(audioBuffer) {
  const numChannels = audioBuffer.numberOfChannels;
  console.log('numChannels:', numChannels);
  const numSamples = audioBuffer.length;
  console.log('numSamples:', numSamples);
  const pcmData = new Int16Array(numChannels * numSamples * 2);
  console.log('pcmData.length:', pcmData.length);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = audioBuffer.getChannelData(channel);

    // log('channelData:', channelData);

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
  // Replace localhost:3004 with the Docker service name if running in container
  const evorunsServerUrl = process.env.EVORUNS_SERVER_URL || 'http://localhost:3004';
  const processedUrl = url.replace(/http:\/\/localhost:3004/g, evorunsServerUrl);
  
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

// Function to create an AudioBuffer from serialized data
function createAudioBufferFromSerialized(serializedBuffer) {
  // Mock AudioBuffer object with the same interface
  const audioBuffer = {
    length: serializedBuffer.length,
    duration: serializedBuffer.duration,
    sampleRate: serializedBuffer.sampleRate,
    numberOfChannels: serializedBuffer.numberOfChannels,
    
    // Method to get channel data
    getChannelData: function(channel) {
      if (channel < 0 || channel >= this.numberOfChannels) {
        throw new Error(`Channel index ${channel} out of bounds`);
      }
      return Float32Array.from(serializedBuffer.channels[channel]);
    }
  };
  
  return audioBuffer;
}

// Proper shutdown handling
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

async function shutdown() {
  console.log('Shutting down server and terminating worker threads...');
  
  // Terminate all workers
  const terminationPromises = workerPool.map(worker => {
    return new Promise((resolve) => {
      worker.once('exit', () => resolve());
      worker.terminate();
    });
  });
  
  await Promise.all(terminationPromises);
  console.log('All workers terminated');
  
  // Close the HTTP server
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
}
