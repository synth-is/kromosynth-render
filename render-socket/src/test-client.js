#!/usr/bin/env node
/**
 * WebSocket Test Client
 * 
 * Connects to render server and requests audio rendering.
 * Receives progressive chunks and can save to WAV file.
 */

import WebSocket from 'ws';
import { writeFileSync } from 'fs';

const SERVER_URL = process.env.SERVER_URL || 'ws://localhost:8080';
const GENOME_ID = process.argv[2] || '01JF2N9RZ07V06EJ4DJ9ZGCM2D';
const DURATION = parseFloat(process.argv[3]) || 5.0;

console.log('🎵 Kromosynth Render Client');
console.log('='.repeat(50));
console.log(`Server: ${SERVER_URL}`);
console.log(`Genome: ${GENOME_ID}`);
console.log(`Duration: ${DURATION}s`);
console.log('='.repeat(50));
console.log();

const ws = new WebSocket(SERVER_URL);

const receivedChunks = [];
let sampleRate = 48000;
let startTime = null;

ws.on('open', () => {
  console.log('✓ Connected to server');
  console.log();

  // Send render request
  console.log(`📤 Sending render request...`);
  ws.send(JSON.stringify({
    type: 'render',
    genomeId: GENOME_ID,
    duration: DURATION,
    noteDelta: 10,
    velocity: 0.5,
    useGPU: true
  }));

  startTime = Date.now();
});

ws.on('message', (data) => {
  const message = JSON.parse(data);

  switch (message.type) {
    case 'welcome':
      console.log(`💬 ${message.message}`);
      sampleRate = message.sampleRate;
      break;

    case 'chunk':
      receivedChunks.push(new Float32Array(message.data));
      
      // Log progress (throttled)
      if (message.index % 10 === 0 || message.timestamp >= DURATION) {
        const elapsed = (Date.now() - startTime) / 1000;
        console.log(`  📥 Chunk ${message.index}: ${message.timestamp.toFixed(2)}s / ${DURATION}s (${elapsed.toFixed(2)}s elapsed)`);
      }
      break;

    case 'complete':
      const totalTime = (Date.now() - startTime) / 1000;
      console.log();
      console.log('✅ Render complete!');
      console.log(`   Total chunks: ${message.totalChunks}`);
      console.log(`   Total samples: ${message.totalSamples.toLocaleString()}`);
      console.log(`   Duration: ${message.duration}s`);
      console.log(`   Time: ${totalTime.toFixed(2)}s`);
      console.log();

      // Save to WAV file
      const filename = `./test-render-${GENOME_ID.slice(-8)}_${DURATION}s.wav`;
      console.log(`💾 Writing WAV file: ${filename}`);
      writeWavFile(receivedChunks, sampleRate, filename);
      console.log(`   ✓ WAV file written`);
      console.log();

      ws.close();
      break;

    case 'error':
      console.error(`❌ Error: ${message.message}`);
      ws.close();
      break;

    default:
      console.log(`Received message:`, message);
  }
});

ws.on('close', () => {
  console.log('👋 Disconnected from server');
  process.exit(0);
});

ws.on('error', (error) => {
  console.error('WebSocket error:', error);
  process.exit(1);
});

function writeWavFile(chunks, sampleRate, filename) {
  // Combine all chunks
  const totalSamples = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const combinedData = new Float32Array(totalSamples);
  let offset = 0;
  for (const chunk of chunks) {
    combinedData.set(chunk, offset);
    offset += chunk.length;
  }

  // Convert float32 to int16
  const int16Data = new Int16Array(totalSamples);
  for (let i = 0; i < totalSamples; i++) {
    const s = Math.max(-1, Math.min(1, combinedData[i]));
    int16Data[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }

  // Create WAV header
  const dataSize = int16Data.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  // RIFF chunk descriptor
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, 'WAVE');

  // fmt sub-chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);

  // data sub-chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  // Write PCM data
  const bytes = new Uint8Array(buffer);
  bytes.set(new Uint8Array(int16Data.buffer), 44);

  writeFileSync(filename, Buffer.from(buffer));
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}
