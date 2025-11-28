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
const PORT = process.env.PORT || 8080;
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
console.log('✓ Warm context ready');
console.log();

// WebSocket server
const wss = new WebSocketServer({ port: PORT });

console.log(`✓ WebSocket server listening on port ${PORT}`);
console.log();

async function loadGenome(genomeId, dbPath) {
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare('SELECT data FROM genomes WHERE id = ?').get(genomeId);
  if (!row) throw new Error(`Genome ${genomeId} not found`);

  const jsonData = await gunzip(row.data);
  const genomeData = JSON.parse(jsonData);
  db.close();

  return genomeData.genome || genomeData;
}

async function handleRenderRequest(ws, request) {
  const { genomeId, duration, noteDelta = 0, velocity = 0.5, useGPU = true } = request;

  console.log(`📥 Render request: ${genomeId} (${duration}s, note=${noteDelta}, vel=${velocity})`);

  try {
    // Load genome
    const genome = await loadGenome(genomeId, DB_PATH);

    // Import StreamingRenderer
    const { StreamingRenderer } = await import(`${KROMOSYNTH_PATH}/util/streaming-renderer.js`);

    // Create offline context (one per render)
    // Reuse shared AudioContext (warm, with AudioWorklet pre-loaded)
    const offlineContext = new OfflineAudioContext({
      numberOfChannels: 1,
      length: Math.round(SAMPLE_RATE * duration),
      sampleRate: SAMPLE_RATE
    });

    const genomeAndMeta = {
      genome,
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
    const renderer = new StreamingRenderer(sharedAudioContext, SAMPLE_RATE, {
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
          const timestamp = totalSamples / SAMPLE_RATE;
          renderState.renderedDuration = timestamp;

          // Send chunk to client
          ws.send(JSON.stringify({
            type: 'chunk',
            index: chunkIndex,
            data: Array.from(chunkData), // Convert Float32Array to regular array for JSON
            timestamp,
            sampleRate: SAMPLE_RATE
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
      sampleRate: SAMPLE_RATE
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
    sampleRate: SAMPLE_RATE
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
