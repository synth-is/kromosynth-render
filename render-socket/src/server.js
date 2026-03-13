#!/usr/bin/env node
/**
 * WebSocket Streaming Render Server
 *
 * Provides audio rendering over WebSocket connections using a single unified
 * rendering path: worklet-offline (AudioBufferSourceNode CPPN signal feeding
 * into the same DSP graph used by BrowserLiveRenderer client-side).
 *
 * The ONLY difference between the browser live path and this server path:
 *   - Browser: live AudioContext, CPPNOutputProcessor AudioWorklet generates samples in real-time
 *   - Server:  OfflineAudioContext renders at full machine speed, CPPN samples
 *              pre-computed and delivered via AudioBufferSourceNode (postMessage
 *              timing is unreliable in OfflineAudioContext, so direct buffer feed
 *              is used instead — functionally equivalent).
 *
 * Rendering modes (selected per-request):
 *   default (batch=true OR batch=false)  → renderWorkletOffline
 *   legacyBatch=true                     → renderLegacyBatch (setValueCurveAtTime, rollback only)
 *
 * NOTE: The previous renderStreamingPreview / StreamingRenderer path has been
 * removed. It was causing an unbounded memory leak (OfflineAudioContext + audio
 * graph nodes per render, never cleaned up in node-web-audio-api). That path
 * predates BrowserLiveRenderer and is no longer needed:
 *   - Browser preview uses BrowserLiveRenderer (client-side, mode='client' default)
 *   - QD pipeline uses batch=true
 *   - All paths now use renderWorkletOffline
 */

import { WebSocketServer } from 'ws';
import Database from 'better-sqlite3';
import zlib from 'zlib';
import { promisify } from 'util';
import NodeWebAudioAPI from '../../../kromosynth/node_modules/node-web-audio-api/index.mjs';
const { OfflineAudioContext } = NodeWebAudioAPI;
import { ensureBufferStartsAndEndsAtZero } from '../../../kromosynth/util/audio-buffer.js';

const gunzip = promisify(zlib.gunzip);

// Configuration
const PORT = process.env.PORT || 3000;
const SAMPLE_RATE = 48000;
const DB_PATH = process.env.DB_PATH || '/Users/bjornpjo/QD/evoruns/01JF0WEW4BTQSWWKGFR72JQ7J6_evoConf_singleMap_refSingleEmb_mfcc-sans0-statistics_AE_retrainIncr50_zScoreNSynthTrain_noveltySel/genomes.sqlite';

const USE_COMPRESSOR = process.env.USE_COMPRESSOR === 'true' || process.env.USE_COMPRESSOR === '1';

const KROMOSYNTH_PATH = '../../../kromosynth';

console.log('🎵 Kromosynth Render Socket Server');
console.log('='.repeat(50));
console.log(`Port: ${PORT}`);
console.log(`Database: ${DB_PATH}`);
console.log(`Sample Rate: ${SAMPLE_RATE}`);
console.log(`Compressor: ${USE_COMPRESSOR ? 'ON (0dB peak limiter)' : 'OFF (peak normalize only)'}`);
console.log('='.repeat(50));
console.log();

// Determine the actual sample rate once from a throw-away offline context
// (avoids keeping a live AudioContext resident — no longer needed now that
// the StreamingRenderer GPU path has been removed).
const _srProbe = new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate: SAMPLE_RATE });
const ACTUAL_SAMPLE_RATE = _srProbe.sampleRate;
console.log(`✓ Sample rate confirmed: ${ACTUAL_SAMPLE_RATE}Hz`);
console.log();

// WebSocket server
const wss = new WebSocketServer({ port: PORT });
console.log(`✓ WebSocket server listening on port ${PORT}`);
console.log();

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

// ─── Send batch-result protocol (shared by all render paths) ─────────────────
function sendBatchResult(ws, samples, totalSamples, duration, requestId) {
  ws.send(JSON.stringify({
    type: 'batch-result', requestId, totalSamples, duration, sampleRate: ACTUAL_SAMPLE_RATE
  }));
  ws.send(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  ws.send(JSON.stringify({
    type: 'complete', requestId, totalChunks: 1, totalSamples, duration, sampleRate: ACTUAL_SAMPLE_RATE
  }));
}

// ─── Unified render path: worklet-offline ────────────────────────────────────
// All requests (batch, preview, WAV capture) use this path.
// Matches browser live path: same DSP graph in streaming mode, same AudioWorklet
// signal connections, same WavetableMixProcessor crossfade logic.
// Only difference from browser: OfflineAudioContext renders at full machine speed,
// CPPN data delivered via AudioBufferSourceNode (not CPPNOutputProcessor) because
// postMessage timing is unreliable in OfflineAudioContext.
async function renderWorkletOffline(ws, genomeData, duration, noteDelta, velocity, useGPU, requestId) {
  const { renderWithWorkletOffline } = await import('./worklet-offline-renderer.js');
  const result = await renderWithWorkletOffline(
    genomeData, duration, noteDelta, velocity,
    ACTUAL_SAMPLE_RATE, useGPU, { chunkDuration: 1.0, useCompressor: USE_COMPRESSOR }
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

// ─── Main render request handler ─────────────────────────────────────────────
async function handleRenderRequest(ws, message) {
  const {
    genomeId, genome, duration,
    noteDelta = 0, velocity = 1.0, useGPU = false, requestId,
    batchChannels = 8, legacyBatch = false
    // batch and controlledResume are accepted for backward compat but ignored —
    // all requests now use the unified worklet-offline path.
  } = message;

  console.log(`📥 Render request: ${genomeId || 'inline genome'} (${duration}s, note=${noteDelta}, vel=${velocity}, gpu=${useGPU}) [${requestId || 'no-id'}]`);

  try {
    const raw = genome || await loadGenome(genomeId);
    const genomeData = unwrapGenome(raw, genomeId);

    if (legacyBatch) {
      console.log(`⚡ Using legacy batch (setValueCurveAtTime, ${batchChannels}ch)`);
      await renderLegacyBatch(ws, genomeData, duration, noteDelta, velocity, useGPU, requestId, batchChannels);
    } else {
      // Unified path: worklet-offline for everything
      // (batch=true, batch=false, controlledResume=true/false — all the same server-side)
      await renderWorkletOffline(ws, genomeData, duration, noteDelta, velocity, useGPU, requestId);
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
        // Previously used by StreamingRenderer pacing; now a no-op.
        // Clients that still send this message are handled gracefully.
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

process.on('SIGINT', () => {
  console.log('\n\n👋 Shutting down...');
  wss.close(() => { console.log('✓ Server closed'); process.exit(0); });
});
