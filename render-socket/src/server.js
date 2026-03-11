#!/usr/bin/env node
/**
 * WebSocket Streaming Render Server
 *
 * Provides real-time audio rendering over WebSocket connections.
 *
 * Rendering modes (selected per-request):
 *   batch=true (default)       → worklet-offline: AudioWorklet signal feeding,
 *                                correct delay/feedback, matches browser live path.
 *                                Pass legacyBatch=true to fall back to setValueCurveAtTime.
 *   batch=false, controlledResume=false → worklet-offline (WAV capture)
 *   batch=false, controlledResume=true  → StreamingRenderer (browser preview)
 */

import { WebSocketServer } from 'ws';
import Database from 'better-sqlite3';
import zlib from 'zlib';
import { promisify } from 'util';
// Import from kromosynth's node_modules to ensure compatibility
import NodeWebAudioAPI from '../../../kromosynth/node_modules/node-web-audio-api/index.mjs';
const { OfflineAudioContext, AudioContext } = NodeWebAudioAPI;
import { ensureBufferStartsAndEndsAtZero } from '../../../kromosynth/util/audio-buffer.js';

const gunzip = promisify(zlib.gunzip);

// Configuration
const PORT = process.env.PORT || 3000;
const SAMPLE_RATE = 48000;
const DB_PATH = process.env.DB_PATH || '/Users/bjornpjo/QD/evoruns/01JF0WEW4BTQSWWKGFR72JQ7J6_evoConf_singleMap_refSingleEmb_mfcc-sans0-statistics_AE_retrainIncr50_zScoreNSynthTrain_noveltySel/genomes.sqlite';

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

// Set of resolver functions for pending streaming renders — triggered by the AudioWorklet
// cleanup uncaughtException to unblock awaits when startRendering() hangs after the error.
const activeWorkletDoneResolvers = new Set();

// ─── Load genome from database or return provided genome data ────────────────
async function loadGenome(genomeIdOrData) {
  if (typeof genomeIdOrData === 'object' && genomeIdOrData !== null) {
    return genomeIdOrData;
  }
  const db = new Database(DB_PATH, { readonly: true });
  const row = db.prepare('SELECT data FROM genomes WHERE id = ?').get(genomeIdOrData);
  if (!row) { db.close(); throw new Error(`Genome ${genomeIdOrData} not found`); }
  const jsonData = await gunzip(row.data);
  const genomeData = JSON.parse(jsonData);
  db.close();
  return genomeData.genome || genomeData;
}

// ─── Unwrap and validate genome data ────────────────────────────────────────
function unwrapGenome(raw, genomeId) {
  let genomeData = raw;
  // Unwrap nested structures until we find asNEATPatch at the top level
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

  // Parse double-encoded asNEATPatch strings
  while (genomeData.asNEATPatch && typeof genomeData.asNEATPatch === 'string') {
    try { genomeData.asNEATPatch = JSON.parse(genomeData.asNEATPatch); }
    catch (e) { console.warn(`Failed to parse asNEATPatch string for ${genomeId}:`, e); break; }
  }

  // Ensure toJSON method (required by some rendering paths)
  if (!genomeData.asNEATPatch.toJSON) {
    genomeData.asNEATPatch.toJSON = function () { return this; };
  }

  return genomeData;
}

// ─── Send batch-result protocol (shared by all offline render paths) ─────────
function sendBatchResult(ws, samples, totalSamples, duration, requestId) {
  ws.send(JSON.stringify({
    type: 'batch-result', requestId, totalSamples, duration, sampleRate: ACTUAL_SAMPLE_RATE
  }));
  ws.send(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  ws.send(JSON.stringify({
    type: 'complete', requestId, totalChunks: 1, totalSamples, duration, sampleRate: ACTUAL_SAMPLE_RATE
  }));
}

// ─── Worklet-offline render (default for batch + WAV capture) ───────────────
// Feeds CPPN outputs sample-by-sample through AudioWorklet into DSP graph
// on OfflineAudioContext — matching browser live playback behavior exactly.
async function renderWorkletOffline(ws, genomeData, duration, noteDelta, velocity, useGPU, requestId) {
  const { renderWithWorkletOffline } = await import('./worklet-offline-renderer.js');
  const result = await renderWithWorkletOffline(
    genomeData, duration, noteDelta, velocity,
    ACTUAL_SAMPLE_RATE, useGPU, { chunkDuration: 1.0 }
  );
  const { samples, totalSamples, renderTimeMs, cppnTimeMs, offlineRenderTimeMs } = result;
  const renderTime = renderTimeMs / 1000;
  console.log(
    `✅ Worklet-offline complete: ${renderTime.toFixed(2)}s total ` +
    `(CPPN: ${(cppnTimeMs / 1000).toFixed(2)}s, render: ${(offlineRenderTimeMs / 1000).toFixed(2)}s) ` +
    `for ${duration}s audio (${(duration / renderTime).toFixed(1)}× real-time)`
  );
  sendBatchResult(ws, samples, totalSamples, duration, requestId);
}

// ─── Legacy batch render (setValueCurveAtTime) — kept for rollback ───────────
// Activated by sending legacyBatch=true in the render request.
async function renderLegacyBatch(ws, genomeData, duration, noteDelta, velocity, useGPU, requestId, batchChannels) {
  const { startMemberOutputsRendering } = await import(`${KROMOSYNTH_PATH}/util/render.js`);
  const { patchFromAsNEATnetwork } = await import(`${KROMOSYNTH_PATH}/util/audio-graph-asNEAT-bridge.js`);
  const Renderer = (await import(`${KROMOSYNTH_PATH}/cppn-neat/network-rendering.js`)).default;

  const startTime = performance.now();

  const asNEATNetworkJSONString = typeof genomeData.asNEATPatch === 'string'
    ? genomeData.asNEATPatch
    : genomeData.asNEATPatch.toJSON ? genomeData.asNEATPatch.toJSON() : JSON.stringify(genomeData.asNEATPatch);
  const synthIsPatch = patchFromAsNEATnetwork(asNEATNetworkJSONString);

  const { memberOutputs, patch: modifiedPatch } = await startMemberOutputsRendering(
    genomeData.waveNetwork, synthIsPatch,
    duration, noteDelta, ACTUAL_SAMPLE_RATE, velocity,
    false, false, useGPU, false, false,
  );

  const offlineContext = new OfflineAudioContext({
    numberOfChannels: batchChannels,
    length: Math.round(ACTUAL_SAMPLE_RATE * duration),
    sampleRate: ACTUAL_SAMPLE_RATE
  });

  const renderer = new Renderer(ACTUAL_SAMPLE_RATE);
  const sampleCount = Math.round(ACTUAL_SAMPLE_RATE * duration);
  await renderer.wireUpAudioGraphAndConnectToAudioContextDestination(
    memberOutputs, modifiedPatch || synthIsPatch, noteDelta,
    offlineContext, sampleCount, null, 'batch', null
  );

  const rawBuffer = await offlineContext.startRendering();
  const chCount = rawBuffer.numberOfChannels;
  const totalSamples = rawBuffer.length;
  const summed = new Float32Array(totalSamples);
  for (let ch = 0; ch < chCount; ch++) {
    const chData = rawBuffer.getChannelData(ch);
    for (let i = 0; i < totalSamples; i++) summed[i] += chData[i];
  }

  let peak = 0;
  for (let i = 0; i < summed.length; i++) { const a = Math.abs(summed[i]); if (a > peak) peak = a; }
  if (peak > 0) for (let i = 0; i < summed.length; i++) summed[i] /= peak;
  ensureBufferStartsAndEndsAtZero(summed);

  const renderTime = (performance.now() - startTime) / 1000;
  console.log(`✅ Legacy batch complete: ${renderTime.toFixed(2)}s for ${duration}s audio (${(duration / renderTime).toFixed(1)}× real-time), ${chCount}ch summed`);

  sendBatchResult(ws, summed, totalSamples, duration, requestId);
}

// ─── Browser preview streaming (controlledResume=true) ───────────────────────
// Streams JSON audio chunks paced to client playback position via playback-position messages.
async function renderStreamingPreview(ws, genomeData, duration, noteDelta, velocity, useGPU, requestId) {
  const { StreamingRenderer } = await import(`${KROMOSYNTH_PATH}/util/streaming-renderer.js`);

  const offlineContext = new OfflineAudioContext({
    numberOfChannels: 1,
    length: Math.round(ACTUAL_SAMPLE_RATE * duration),
    sampleRate: ACTUAL_SAMPLE_RATE
  });

  const genomeAndMeta = { genome: genomeData, duration, noteDelta, velocity, reverse: false };
  const renderState = { clientPosition: 0, renderedDuration: 0, bufferAhead: 2.0 };

  const renderer = new StreamingRenderer(sharedAudioContext, ACTUAL_SAMPLE_RATE, {
    useGPU, measureRTF: false,
    defaultChunkDuration: 0.25, enableAdaptiveChunking: true,
    controlledResume: true, initialBufferDuration: 2.0, bufferAhead: 2.0
  });

  let chunkIndex = 0;
  let totalSamples = 0;

  const positionHandler = (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'playback-position') renderState.clientPosition = msg.position;
    } catch { /* ignore */ }
  };
  ws.on('message', positionHandler);

  let workletDoneResolve;
  const workletDonePromise = new Promise(resolve => { workletDoneResolve = resolve; });
  activeWorkletDoneResolvers.add(workletDoneResolve);

  const startTime = performance.now();
  const renderPromise = renderer.render(
    genomeAndMeta, duration, offlineContext,
    {
      onChunk: (chunkData) => {
        chunkIndex++;
        totalSamples += chunkData.length;
        const timestamp = totalSamples / ACTUAL_SAMPLE_RATE;
        renderState.renderedDuration = timestamp;
        ws.send(JSON.stringify({
          type: 'chunk', requestId, index: chunkIndex,
          data: Array.from(chunkData), timestamp, sampleRate: ACTUAL_SAMPLE_RATE
        }));
        if (chunkIndex % 10 === 0 || timestamp >= duration) {
          console.log(`  📤 Sent chunk ${chunkIndex} (${timestamp.toFixed(2)}s / ${duration}s)`);
        }
      },
      shouldResume: (renderedDuration) => {
        return (renderedDuration - renderState.clientPosition) < renderState.bufferAhead;
      },
      onBufferFull: (renderedDuration) => {
        console.log(`  ⏸️  Initial buffer complete (${renderedDuration.toFixed(2)}s), waiting for client...`);
      }
    }
  );

  await Promise.race([renderPromise, workletDonePromise]);
  activeWorkletDoneResolvers.delete(workletDoneResolve);
  ws.off('message', positionHandler);

  const renderTime = (performance.now() - startTime) / 1000;
  console.log(`✅ Streaming render complete: ${chunkIndex} chunks, ${duration}s (${(duration / renderTime).toFixed(1)}× real-time)`);
  console.log();

  ws.send(JSON.stringify({
    type: 'complete', requestId, totalChunks: chunkIndex, totalSamples, duration, sampleRate: ACTUAL_SAMPLE_RATE
  }));
}

// ─── Main render request handler ─────────────────────────────────────────────
async function handleRenderRequest(ws, message) {
  const {
    genomeId, genome, duration,
    noteDelta = 0, velocity = 1.0, useGPU = false, requestId,
    batch = false, batchChannels = 8, controlledResume = true, legacyBatch = false
  } = message;

  const modeStr = batch
    ? (legacyBatch ? 'legacy-batch' : 'worklet-batch')
    : (controlledResume ? 'stream-preview' : 'stream-wav');
  console.log(`📥 Render request: ${genomeId || 'inline genome'} (${duration}s, note=${noteDelta}, vel=${velocity}, ${modeStr}, gpu=${useGPU}) [${requestId || 'no-id'}]`);

  try {
    const raw = genome || await loadGenome(genomeId);
    const genomeData = unwrapGenome(raw, genomeId);

    if (batch) {
      // ── Offline batch render ──────────────────────────────────────────────
      if (legacyBatch) {
        console.log(`⚡ Using legacy batch (setValueCurveAtTime, ${batchChannels}ch)`);
        await renderLegacyBatch(ws, genomeData, duration, noteDelta, velocity, useGPU, requestId, batchChannels);
      } else {
        console.log(`⚡ Using worklet-offline (AudioWorklet signal feeding)`);
        await renderWorkletOffline(ws, genomeData, duration, noteDelta, velocity, useGPU, requestId);
      }
    } else if (!controlledResume) {
      // ── WAV capture: full-speed offline render ────────────────────────────
      console.log(`⚡ WAV capture mode → worklet-offline`);
      await renderWorkletOffline(ws, genomeData, duration, noteDelta, velocity, useGPU, requestId);
    } else {
      // ── Browser preview: streaming with playback pacing ───────────────────
      await renderStreamingPreview(ws, genomeData, duration, noteDelta, velocity, useGPU, requestId);
    }

  } catch (error) {
    console.error(`❌ Render error:`, error);
    ws.send(JSON.stringify({ type: 'error', requestId, message: error.message }));
  }
}

// ─── WebSocket connection handler ─────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`🔌 Client connected: ${clientIp}`);

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data);
      if (message.type === 'render') {
        await handleRenderRequest(ws, message);
      } else if (message.type === 'playback-position') {
        // Handled inside renderStreamingPreview via positionHandler — ignore here
      } else {
        ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${message.type}` }));
      }
    } catch (error) {
      console.error('Message handling error:', error);
      ws.send(JSON.stringify({ type: 'error', message: error.message }));
    }
  });

  ws.on('close', () => { console.log(`🔌 Client disconnected: ${clientIp}`); });
  ws.on('error', (error) => { console.error(`WebSocket error from ${clientIp}:`, error); });

  ws.send(JSON.stringify({
    type: 'welcome',
    message: 'Connected to Kromosynth Render Socket',
    sampleRate: ACTUAL_SAMPLE_RATE
  }));
});

// ─── Handle uncaught AudioWorklet cleanup errors ──────────────────────────────
// The "expect Object, got: Undefined" error escapes startRendering() as a truly
// uncaught exception. When it fires, rendering is complete — unblock all awaits.
process.on('uncaughtException', (error) => {
  if (error.message && error.message.includes('expect Object, got: Undefined')) {
    console.log('  ℹ️  AudioWorklet cleanup error caught (expected, continuing)');
    for (const resolve of activeWorkletDoneResolvers) resolve();
    activeWorkletDoneResolvers.clear();
  } else {
    console.error('❌ Uncaught exception:', error);
    process.exit(1);
  }
});

process.on('SIGINT', () => {
  console.log('\n\n👋 Shutting down...');
  wss.close(() => { console.log('✓ Server closed'); process.exit(0); });
});
