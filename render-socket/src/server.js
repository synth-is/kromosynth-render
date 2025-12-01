#!/usr/bin/env node
/**
 * WebSocket Streaming Render Server
 * 
 * Provides real-time audio rendering over WebSocket connections.
 * Clients send render requests and receive progressive audio chunks.
 */

import { WebSocketServer } from 'ws';
import Database from 'better-sqlite3';
import zlib from 'zlib';
import { promisify } from 'util';
// Import from kromosynth's node_modules to ensure compatibility
import NodeWebAudioAPI from '../../../kromosynth/node_modules/node-web-audio-api/index.mjs';
const { OfflineAudioContext, AudioContext } = NodeWebAudioAPI;

const gunzip = promisify(zlib.gunzip);

// Configuration
const PORT = process.env.PORT || 3000;
const SAMPLE_RATE = 48000;
const DB_PATH = process.env.DB_PATH || '/Users/bjornpjo/QD/evoruns/01JF0WEW4BTQSWWKGFR72JQ7J6_evoConf_singleMap_refSingleEmb_mfcc-sans0-statistics_AE_retrainIncr50_zScoreNSynthTrain_noveltySel/genomes.sqlite';

// Import StreamingRenderer from kromosynth
// Path from render-socket/src/ to kromosynth/
const KROMOSYNTH_PATH = '../../../kromosynth';

console.log('🎵 Kromosynth Render Socket Server');
console.log('='.repeat(50));
console.log(`Port: ${PORT}`);
console.log(`Database: ${DB_PATH}`);
console.log(`Sample Rate: ${SAMPLE_RATE}`);
console.log('='.repeat(50));
console.log();

// Server optimization: Warm audio context for CPPN GPU computation (reused across requests)
console.log('⚡ Initializing warm audio context (for CPPN GPU reuse)...');
const sharedAudioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
const ACTUAL_SAMPLE_RATE = sharedAudioContext.sampleRate;
console.log(`✓ Warm context ready (Sample Rate: ${ACTUAL_SAMPLE_RATE}Hz)`);
console.log();

// WebSocket server
const wss = new WebSocketServer({ port: PORT });

console.log(`✓ WebSocket server listening on port ${PORT}`);
console.log();

// Load genome from database or use provided genome data
async function loadGenome(genomeIdOrData) {
  // If it's an object, it's already genome data - just return it
  if (typeof genomeIdOrData === 'object' && genomeIdOrData !== null) {
    console.log('Using provided genome data');
    return genomeIdOrData;
  }

  // Otherwise, load from database by ID
  const genomeId = genomeIdOrData;
  const db = new Database(DB_PATH, { readonly: true });
  const row = db.prepare('SELECT data FROM genomes WHERE id = ?').get(genomeId);
  if (!row) {
    db.close();
    throw new Error(`Genome ${genomeId} not found`);
  }

  const jsonData = await gunzip(row.data);
  const genomeData = JSON.parse(jsonData);
  db.close();

  return genomeData.genome || genomeData;
}

// Handle render request
async function handleRenderRequest(ws, message) {
  const { genomeId, genome, duration, noteDelta = 0, velocity = 1.0, useGPU = false } = message;

  console.log(`📥 Render request: ${genomeId || 'inline genome'} (${duration}s, note=${noteDelta}, vel=${velocity})`);

  try {
    // Use provided genome data if available, otherwise load from database
    const genomeData = genome || await loadGenome(genomeId);

    // Ensure asNEATPatch is an object (parse recursively if string)
    // Handle cases where it might be double-encoded
    while (genomeData.asNEATPatch && typeof genomeData.asNEATPatch === 'string') {
      try {
        const parsed = JSON.parse(genomeData.asNEATPatch);
        genomeData.asNEATPatch = parsed;
      } catch (e) {
        console.warn(`Failed to parse asNEATPatch string for ${genomeId}:`, e);
        break;
      }
    }

    // Ensure asNEATPatch has toJSON method (required by StreamingRenderer)
    if (genomeData.asNEATPatch && !genomeData.asNEATPatch.toJSON) {
      genomeData.asNEATPatch.toJSON = function () { return this; };
    }

    // Import StreamingRenderer
    const { StreamingRenderer } = await import(`${KROMOSYNTH_PATH}/util/streaming-renderer.js`);

    // Create offline context (one per render)
    // Reuse shared AudioContext (warm, with AudioWorklet pre-loaded)
    const offlineContext = new OfflineAudioContext({
      numberOfChannels: 1,
      length: Math.round(ACTUAL_SAMPLE_RATE * duration),
      sampleRate: ACTUAL_SAMPLE_RATE
    });

    const genomeAndMeta = {
      genome: genomeData,
      duration,
      noteDelta,
      velocity,
      reverse: false
    };

    // State for client-controlled rendering
    const renderState = {
      clientPosition: 0,        // Last reported playback position from client
      renderedDuration: 0,      // How much we've rendered so far
      totalDuration: duration,
      bufferAhead: 2.0          // How far ahead to stay (matches renderer default)
    };

    // Create renderer with controlled resume enabled
    const renderer = new StreamingRenderer(sharedAudioContext, ACTUAL_SAMPLE_RATE, {
      useGPU,
      measureRTF: false,
      defaultChunkDuration: 0.25,
      enableAdaptiveChunking: true,
      controlledResume: true,
      initialBufferDuration: 2.0,
      bufferAhead: 2.0
    });

    let chunkIndex = 0;
    let totalSamples = 0;

    // Listen for playback position updates from client
    const positionHandler = (data) => {
      try {
        const message = JSON.parse(data);
        if (message.type === 'playback-position') {
          renderState.clientPosition = message.position;
          // console.log(`  📍 Client position: ${message.position.toFixed(2)}s`);
        }
      } catch (e) {
        // Ignore parse errors
      }
    };
    ws.on('message', positionHandler);

    // Start rendering with chunk callback
    console.log(`🎬 Starting adaptive render for ${genomeId}...`);

    const renderPromise = renderer.render(
      genomeAndMeta,
      duration,
      offlineContext,
      {
        onChunk: (chunkData) => {
          chunkIndex++;
          totalSamples += chunkData.length;
          const timestamp = totalSamples / ACTUAL_SAMPLE_RATE;
          renderState.renderedDuration = timestamp;

          // Send chunk to client
          ws.send(JSON.stringify({
            type: 'chunk',
            index: chunkIndex,
            data: Array.from(chunkData), // Convert Float32Array to regular array for JSON
            timestamp,
            sampleRate: ACTUAL_SAMPLE_RATE
          }));

          // Log progress (throttled)
          if (chunkIndex % 10 === 0 || timestamp >= duration) {
            console.log(`  📤 Sent chunk ${chunkIndex} (${timestamp.toFixed(2)}s / ${duration}s, client @ ${renderState.clientPosition.toFixed(2)}s)`);
          }
        },

        // Controlled resume: only resume if we need to stay ahead of client
        shouldResume: (renderedDuration) => {
          const bufferRemaining = renderedDuration - renderState.clientPosition;
          const needMore = bufferRemaining < renderState.bufferAhead;
          return needMore;
        },

        // Notify when initial buffer is complete
        onBufferFull: (renderedDuration) => {
          console.log(`  ⏸️  Initial buffer complete (${renderedDuration.toFixed(2)}s), waiting for client playback...`);
        }
      }
    );

    // Wait for render to complete
    await renderPromise;

    // Clean up position handler
    ws.off('message', positionHandler);

    console.log(`✅ Render complete: ${chunkIndex} chunks, ${duration}s`);
    console.log();

    // Send completion message BEFORE cleanup
    ws.send(JSON.stringify({
      type: 'complete',
      totalChunks: chunkIndex,
      totalSamples,
      duration,
      sampleRate: ACTUAL_SAMPLE_RATE
    }));

    // Note: sharedAudioContext is reused, only offlineContext needs cleanup
    // The offlineContext is automatically cleaned up by garbage collection

  } catch (error) {
    console.error(`❌ Render error:`, error);
    ws.send(JSON.stringify({
      type: 'error',
      message: error.message
    }));
  }
}

wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`🔌 Client connected: ${clientIp}`);

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data);

      if (message.type === 'render') {
        await handleRenderRequest(ws, message);
      } else if (message.type === 'playback-position') {
        // Handled by position handler in handleRenderRequest - ignore here
      } else {
        ws.send(JSON.stringify({
          type: 'error',
          message: `Unknown message type: ${message.type}`
        }));
      }
    } catch (error) {
      console.error('Message handling error:', error);
      ws.send(JSON.stringify({
        type: 'error',
        message: error.message
      }));
    }
  });

  ws.on('close', () => {
    console.log(`🔌 Client disconnected: ${clientIp}`);
  });

  ws.on('error', (error) => {
    console.error(`WebSocket error from ${clientIp}:`, error);
  });

  // Send welcome message
  ws.send(JSON.stringify({
    type: 'welcome',
    message: 'Connected to Kromosynth Render Socket',
    sampleRate: typeof ACTUAL_SAMPLE_RATE !== 'undefined' ? ACTUAL_SAMPLE_RATE : SAMPLE_RATE
  }));
});

// Handle uncaught AudioWorklet errors (these are expected at end of render)
process.on('uncaughtException', (error) => {
  if (error.message && error.message.includes('expect Object, got: Undefined')) {
    console.log('  ℹ️  AudioWorklet cleanup error caught (expected, continuing)');
    // Don't exit - this is normal
  } else {
    console.error('❌ Uncaught exception:', error);
    process.exit(1);
  }
});

process.on('SIGINT', () => {
  console.log('\n\n👋 Shutting down...');
  wss.close(() => {
    console.log('✓ Server closed');
    process.exit(0);
  });
});
