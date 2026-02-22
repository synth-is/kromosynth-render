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

// Set of resolver functions for pending streaming renders — triggered by the AudioWorklet
// cleanup uncaughtException to unblock awaits when startRendering() hangs after the error.
const activeWorkletDoneResolvers = new Set();

// Handle render request
async function handleRenderRequest(ws, message) {
  const { genomeId, genome, duration, noteDelta = 0, velocity = 1.0, useGPU = false, requestId, batch = false, batchChannels = 8, controlledResume = true } = message;

  console.log(`📥 Render request: ${genomeId || 'inline genome'} (${duration}s, note=${noteDelta}, vel=${velocity}) [${requestId || 'no-id'}]`);

  try {
    // Use provided genome data if available, otherwise load from database
    let genomeData = genome || await loadGenome(genomeId);

    // Unwrap nested genome structures — genomes may arrive wrapped as:
    //   { genome: { asNEATPatch: ... } }  or even  { data: { genome: { ... } } }
    // Keep unwrapping until we find asNEATPatch at the top level
    for (let depth = 0; depth < 3 && genomeData && !genomeData.asNEATPatch; depth++) {
      if (genomeData.genome && typeof genomeData.genome === 'object') {
        genomeData = genomeData.genome;
      } else if (genomeData.data && typeof genomeData.data === 'object') {
        genomeData = genomeData.data;
      } else if (typeof genomeData.genome === 'string') {
        try { genomeData = JSON.parse(genomeData.genome); } catch { break; }
      } else {
        break;
      }
    }

    if (!genomeData || !genomeData.asNEATPatch) {
      const keys = genomeData ? Object.keys(genomeData).slice(0, 10) : [];
      throw new Error(`Genome data missing asNEATPatch. Top-level keys: [${keys.join(', ')}]`);
    }

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

    // Create offline context (one per render).
    // Batch uses N channels so channelMerger routes each wave to its own channel
    // without down-mix loss; we sum manually after startRendering().
    // Streaming uses 1 channel (AudioWorklet captures correctly there).
    const numChannels = batch ? batchChannels : 1;
    const offlineContext = new OfflineAudioContext({
      numberOfChannels: numChannels,
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

    // Genome fingerprint for render parity diagnosis
    const crypto = await import('crypto');
    const patchStr = JSON.stringify(genomeData.asNEATPatch) || 'undefined';
    const waveStr = JSON.stringify(genomeData.waveNetwork) || 'undefined';
    const patchHash = crypto.createHash('md5').update(patchStr).digest('hex').slice(0, 12);
    const waveHash = crypto.createHash('md5').update(waveStr).digest('hex').slice(0, 12);
    console.log('🔬 RENDER FINGERPRINT (streaming-server):', {
      patchHash, waveHash,
      patchLen: patchStr.length, waveLen: waveStr.length,
      nodeCount: genomeData.asNEATPatch?.nodes?.length,
      connCount: genomeData.asNEATPatch?.connections?.length,
      firstNodeType: typeof genomeData.asNEATPatch?.nodes?.[0],
      duration, noteDelta, velocity,
      sampleRate: ACTUAL_SAMPLE_RATE, useGPU
    });

    if (batch) {
      // ═══════════════════════════════════════════════════════════════
      // BATCH MODE: N-channel OfflineAudioContext, direct startRendering().
      // We bypass renderAudioAndSpectrogram/normalizeAudioBuffer because those
      // only read channel 0 of the rendered buffer. Instead we:
      //   1. Run CPPN activation (startMemberOutputsRendering)
      //   2. Wire the audio graph directly (wireUpAudioGraph / renderNetworksOutputSamplesAsAudioBuffer)
      //   3. Call offlineContext.startRendering() ourselves
      //   4. Sum ALL N channels manually → proper mix of all audio waves
      //   5. Peak-normalise the summed mono signal
      // ═══════════════════════════════════════════════════════════════
      console.log(`⚡ Batch mode: ${numChannels}ch OfflineAudioContext, direct startRendering()`);

      const { startMemberOutputsRendering, startAudioBuffersRendering } = await import(`${KROMOSYNTH_PATH}/util/render.js`);
      const { patchFromAsNEATnetwork } = await import(`${KROMOSYNTH_PATH}/util/audio-graph-asNEAT-bridge.js`);

      const startTime = performance.now();

      // 1. Build patch from NEAT network
      const asNEATNetworkJSONString = typeof genomeData.asNEATPatch === 'string'
        ? genomeData.asNEATPatch
        : genomeData.asNEATPatch.toJSON ? genomeData.asNEATPatch.toJSON() : JSON.stringify(genomeData.asNEATPatch);
      const synthIsPatch = patchFromAsNEATnetwork(asNEATNetworkJSONString);

      // 2. Run CPPN activation to get memberOutputs
      const { memberOutputs, patch: modifiedPatch } = await startMemberOutputsRendering(
        genomeData.waveNetwork, synthIsPatch,
        duration, noteDelta, ACTUAL_SAMPLE_RATE, velocity,
        false, // reverse
        false, // useOvertoneInharmonicityFactors
        useGPU,
        false, // antiAliasing
        false, // frequencyUpdatesApplyToAllPathcNetworkOutputs
      );

      // 3. Wire audio graph into the N-channel offline context, then startRendering()
      //    We call renderNetworksOutputSamplesAsAudioBuffer which internally calls
      //    wireUpAudioGraphAndConnectToAudioContextDestination + startRendering()
      //    and returns the rendered AudioBuffer (normalizeAudioBuffer will only read ch0,
      //    but we need the RAW buffer, so we intercept startRendering directly).
      //
      //    Instead: wire the graph, then call offlineContext.startRendering() ourselves.
      const Renderer = (await import(`${KROMOSYNTH_PATH}/cppn-neat/network-rendering.js`)).default;
      const renderer = new Renderer(ACTUAL_SAMPLE_RATE);

      const sampleCount = Math.round(ACTUAL_SAMPLE_RATE * duration);
      await renderer.wireUpAudioGraphAndConnectToAudioContextDestination(
        memberOutputs, modifiedPatch || synthIsPatch, noteDelta,
        offlineContext,
        sampleCount,
        null, // wrapperNodes
        'batch', // mode
        null // captureNode
      );

      // 4. Render and sum ALL channels
      const rawBuffer = await offlineContext.startRendering();
      const chCount = rawBuffer.numberOfChannels;
      const totalSamples = rawBuffer.length;
      const summed = new Float32Array(totalSamples);
      for (let ch = 0; ch < chCount; ch++) {
        const chData = rawBuffer.getChannelData(ch);
        for (let i = 0; i < totalSamples; i++) summed[i] += chData[i];
      }

      // 5. Peak-normalise the summed mono signal
      let peak = 0;
      for (let i = 0; i < summed.length; i++) {
        const abs = Math.abs(summed[i]);
        if (abs > peak) peak = abs;
      }
      if (peak > 0) {
        for (let i = 0; i < summed.length; i++) summed[i] /= peak;
      }

      const renderTime = (performance.now() - startTime) / 1000;

      console.log(`✅ Batch render complete: ${renderTime.toFixed(2)}s for ${duration}s audio (${(duration / renderTime).toFixed(1)}× real-time), ${chCount}ch summed to mono`);

      // Send audio as binary Float32Array (avoids slow JSON serialization of millions of floats)
      // Protocol: JSON header first, then binary payload
      ws.send(JSON.stringify({
        type: 'batch-result',
        requestId,
        totalSamples,
        duration,
        sampleRate: ACTUAL_SAMPLE_RATE
      }));
      // Send raw bytes
      ws.send(Buffer.from(summed.buffer, summed.byteOffset, summed.byteLength));

      // Also send standard 'complete' for protocol compatibility
      ws.send(JSON.stringify({
        type: 'complete',
        requestId,
        totalChunks: 1,
        totalSamples,
        duration,
        sampleRate: ACTUAL_SAMPLE_RATE
      }));

    } else {
      // ═══════════════════════════════════════════════════════════════
      // STREAMING MODE: AudioWorklet capture
      // controlledResume=true: paced to client playback position (browser preview)
      // controlledResume=false: full-speed straight through (WAV capture / VI render)
      // ═══════════════════════════════════════════════════════════════

      const renderState = {
        clientPosition: 0,
        renderedDuration: 0,
        totalDuration: duration,
        bufferAhead: 2.0
      };

      const renderer = new StreamingRenderer(sharedAudioContext, ACTUAL_SAMPLE_RATE, {
        useGPU,
        measureRTF: false,
        defaultChunkDuration: 0.25,
        enableAdaptiveChunking: true,
        controlledResume,
        initialBufferDuration: 2.0,
        bufferAhead: 2.0
      });

      let chunkIndex = 0;
      let totalSamples = 0;

      // Listen for playback position updates from client (only needed in controlledResume mode)
      const positionHandler = (data) => {
        try {
          const message = JSON.parse(data);
          if (message.type === 'playback-position') {
            renderState.clientPosition = message.position;
          }
        } catch (e) {
          // Ignore parse errors
        }
      };
      if (controlledResume) ws.on('message', positionHandler);

      // In WAV-capture mode (controlledResume=false) accumulate chunks server-side and send
      // a single binary payload at the end — avoids flooding the WebSocket with hundreds of
      // large JSON messages (700+ chunks × ~30KB JSON each = ~20MB for a 60s render).
      const capturedChunks = controlledResume ? null : [];

      console.log(`🎬 Starting streaming render for ${genomeId}...`);

      // The AudioWorklet cleanup error ("expect Object, got: Undefined") escapes the promise
      // chain as a truly uncaught exception caught by process.on('uncaughtException').
      // When it fires, startRendering() is done and all chunks are captured — we just need
      // to unblock the await. Expose a resolver so the uncaughtException handler can do that.
      let workletDoneResolve;
      const workletDonePromise = new Promise(resolve => { workletDoneResolve = resolve; });
      activeWorkletDoneResolvers.add(workletDoneResolve);

      const startTime = performance.now();
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

            if (controlledResume) {
              // Browser preview: stream each chunk as JSON for immediate playback
              ws.send(JSON.stringify({
                type: 'chunk',
                requestId,
                index: chunkIndex,
                data: Array.from(chunkData),
                timestamp,
                sampleRate: ACTUAL_SAMPLE_RATE
              }));
            } else {
              // WAV capture: accumulate locally — send one binary blob at the end
              capturedChunks.push(new Float32Array(chunkData));
            }

            if (chunkIndex % 10 === 0 || timestamp >= duration) {
              console.log(`  📤 ${controlledResume ? 'Sent' : 'Captured'} chunk ${chunkIndex} (${timestamp.toFixed(2)}s / ${duration}s)`);
            }
          },

          shouldResume: (renderedDuration) => {
            const bufferRemaining = renderedDuration - renderState.clientPosition;
            return bufferRemaining < renderState.bufferAhead;
          },

          onBufferFull: (renderedDuration) => {
            console.log(`  ⏸️  Initial buffer complete (${renderedDuration.toFixed(2)}s), waiting for client playback...`);
          }
        }
      );

      // Race: renderPromise resolves normally, OR workletDonePromise resolves when the
      // AudioWorklet cleanup uncaughtException fires (meaning rendering is complete).
      await Promise.race([renderPromise, workletDonePromise]);
      activeWorkletDoneResolvers.delete(workletDoneResolve);
      if (controlledResume) ws.off('message', positionHandler);

      const renderTime = (performance.now() - startTime) / 1000;
      console.log(`✅ Render complete: ${chunkIndex} chunks, ${duration}s (${(duration / renderTime).toFixed(1)}× real-time)`);
      console.log();

      if (controlledResume) {
        // Browser preview: all chunks already sent, just signal completion
        ws.send(JSON.stringify({
          type: 'complete',
          requestId,
          totalChunks: chunkIndex,
          totalSamples,
          duration,
          sampleRate: ACTUAL_SAMPLE_RATE
        }));
      } else {
        // WAV capture: concatenate, peak-normalise, send as single binary blob
        const combined = new Float32Array(totalSamples);
        let offset = 0;
        for (const chunk of capturedChunks) { combined.set(chunk, offset); offset += chunk.length; }

        let peak = 0;
        for (let i = 0; i < combined.length; i++) { const a = Math.abs(combined[i]); if (a > peak) peak = a; }
        if (peak > 0) for (let i = 0; i < combined.length; i++) combined[i] /= peak;

        ws.send(JSON.stringify({ type: 'batch-result', requestId, totalSamples, duration, sampleRate: ACTUAL_SAMPLE_RATE }));
        ws.send(Buffer.from(combined.buffer, combined.byteOffset, combined.byteLength));
        ws.send(JSON.stringify({ type: 'complete', requestId, totalChunks: chunkIndex, totalSamples, duration, sampleRate: ACTUAL_SAMPLE_RATE }));
      }
    }

    // Note: sharedAudioContext is reused, only offlineContext needs cleanup
    // The offlineContext is automatically cleaned up by garbage collection

  } catch (error) {
    console.error(`❌ Render error:`, error);
    ws.send(JSON.stringify({
      type: 'error',
      requestId,
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

// Handle uncaught AudioWorklet errors (these are expected at end of render).
// When this fires, startRendering() is complete and all chunks are captured —
// resolve all pending streaming renders so their awaits unblock.
process.on('uncaughtException', (error) => {
  if (error.message && error.message.includes('expect Object, got: Undefined')) {
    console.log('  ℹ️  AudioWorklet cleanup error caught (expected, continuing)');
    // Unblock any pending streaming render awaits
    for (const resolve of activeWorkletDoneResolvers) resolve();
    activeWorkletDoneResolvers.clear();
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
