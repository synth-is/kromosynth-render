#!/usr/bin/env node
/**
 * Batch comparison: Render genomes via batch, worklet-offline, and streaming-unchunked paths.
 *
 * Usage (random genomes):
 *   node --experimental-vm-modules src/test-worklet-batch.js [count] [duration]
 *
 * Usage (specific genome IDs or URLs):
 *   node --experimental-vm-modules src/test-worklet-batch.js --ids BRED_foo 01KBNTRZ...
 *   node --experimental-vm-modules src/test-worklet-batch.js --ids --duration 8 BRED_foo 01KBNTRZ...
 *   node --experimental-vm-modules src/test-worklet-batch.js --ids http://host:3004/api/exploration/genome/ID?format=raw
 *
 * Environment:
 *   DB_PATH — path to genome database (auto-detects schema: recommend vs evorun)
 *
 * Three render paths compared:
 *   batch    — setValueCurveAtTime (old approach, 8-ch OfflineAudioContext, full-duration CPPN)
 *   streaming — AudioBufferSourceNode + connectLiveSignals (current offline WAV path)
 *              Single full-duration CPPN call + 'streaming' DSP mode + AudioBufferSourceNode gain curves
 *              for wavetable mix crossfade (same math as WavetableMixProcessor, no AudioWorklet latency)
 *   stream1   — Same AudioBufferSourceNode approach but local connectLiveSignals (skips mix connections)
 *              Used to isolate streaming ≈ stream1 sanity check
 *
 * Outputs WAV triples into render-socket/comparison-wavs/
 */

import Database from 'better-sqlite3';
import zlib from 'zlib';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

import NodeWebAudioAPI from '../../../kromosynth/node_modules/node-web-audio-api/index.mjs';
const { OfflineAudioContext } = NodeWebAudioAPI;
import { ensureBufferStartsAndEndsAtZero } from '../../../kromosynth/util/audio-buffer.js';

const gunzip = promisify(zlib.gunzip);

// ─── Suppress node-web-audio-api AudioWorklet cleanup noise ──────────────────
// When WavetableMixProcessor is loaded on an OfflineAudioContext, node-web-audio-api
// fires an uncaught "expect Object, got: Undefined" error from its internal cleanup
// after startRendering() completes. This is a library-internal issue (not our code)
// and does not affect the rendered audio — suppress it so the test can continue.
process.on('uncaughtException', (err) => {
  if (err.message?.includes('expect Object') || err.message?.includes('got: Undefined')) {
    // node-web-audio-api AudioWorklet cleanup noise — safe to ignore
    return;
  }
  console.error('[uncaughtException]', err);
  process.exit(1);
});

// ─── Configuration ──────────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || '/Users/bjornpjo/Developer/apps/synth.is/kromosynth-recommend/data/genomes.db';
const SAMPLE_RATE = 48000;
const DEFAULT_COUNT = 10;
const DEFAULT_DURATION = 4;
const USE_GPU = true;

const KROMOSYNTH_PATH = '../../../kromosynth';
const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const OUT_DIR = path.join(SCRIPT_DIR, '..', 'comparison-wavs');

// ─── CLI argument parsing ─────────────────────────────────────────────
function parseCli() {
  const args = process.argv.slice(2);

  // --ids mode: specific genome IDs
  if (args.includes('--ids')) {
    const durationIdx = args.indexOf('--duration');
    let duration = DEFAULT_DURATION;
    const filtered = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--ids') continue;
      if (args[i] === '--duration') { duration = parseFloat(args[++i]) || DEFAULT_DURATION; continue; }
      filtered.push(args[i]);
    }
    return { mode: 'ids', ids: filtered, duration, count: filtered.length };
  }

  // Legacy mode: [count] [duration]
  const count = parseInt(args[0]) || DEFAULT_COUNT;
  const duration = parseFloat(args[1]) || DEFAULT_DURATION;
  return { mode: 'random', count, duration };
}

// ─── Auto-detect DB schema ──────────────────────────────────────────
function detectSchema(db) {
  const cols = db.prepare('PRAGMA table_info(genomes)').all().map(c => c.name);
  if (cols.includes('sound_id') && cols.includes('genome_data')) {
    return { idCol: 'sound_id', dataCol: 'genome_data' }; // recommend DB
  }
  if (cols.includes('id') && cols.includes('data')) {
    return { idCol: 'id', dataCol: 'data' }; // evorun DB
  }
  throw new Error(`Unknown DB schema. Columns: ${cols.join(', ')}`);
}

// ─── Parse a single genome row ─────────────────────────────────────────
async function parseGenomeRow(row) {
  const jsonData = await gunzip(row.data);
  let genomeData = JSON.parse(jsonData);

  // Unwrap nested genome structures
  for (let depth = 0; depth < 3 && genomeData && !genomeData.asNEATPatch; depth++) {
    if (genomeData.genome && typeof genomeData.genome === 'object') {
      genomeData = genomeData.genome;
    } else if (genomeData.data && typeof genomeData.data === 'object') {
      genomeData = genomeData.data;
    } else break;
  }

  // Parse asNEATPatch if string
  while (genomeData.asNEATPatch && typeof genomeData.asNEATPatch === 'string') {
    try { genomeData.asNEATPatch = JSON.parse(genomeData.asNEATPatch); } catch { break; }
  }

  if (!genomeData.asNEATPatch) return null;

  if (!genomeData.asNEATPatch.toJSON) {
    genomeData.asNEATPatch.toJSON = function () { return this; };
  }

  return genomeData;
}

// ─── Load N random genomes ─────────────────────────────────────────────
async function loadRandomGenomes(count) {
  const db = new Database(DB_PATH, { readonly: true });
  const schema = detectSchema(db);
  console.log(`DB schema: ${schema.idCol}/${schema.dataCol}`);

  const rows = db.prepare(
    `SELECT ${schema.idCol} AS id, ${schema.dataCol} AS data FROM genomes ORDER BY RANDOM() LIMIT ?`
  ).all(count);
  db.close();

  const genomes = [];
  for (const row of rows) {
    try {
      const genomeData = await parseGenomeRow(row);
      if (!genomeData) { console.warn(`  Skipping ${row.id}: no asNEATPatch`); continue; }
      genomes.push({ id: row.id, genome: genomeData });
    } catch (e) {
      console.warn(`  Skipping ${row.id}: ${e.message}`);
    }
  }
  return genomes;
}

// ─── Load a genome from a URL ─────────────────────────────────────────
async function loadGenomeFromUrl(url) {
  console.log(`  🌐 Fetching: ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  let genomeData = await response.json();

  // Unwrap nested genome structures (same logic as parseGenomeRow)
  for (let depth = 0; depth < 3 && genomeData && !genomeData.asNEATPatch; depth++) {
    if (genomeData.genome && typeof genomeData.genome === 'object') {
      genomeData = genomeData.genome;
    } else if (genomeData.data && typeof genomeData.data === 'object') {
      genomeData = genomeData.data;
    } else break;
  }

  // Parse asNEATPatch if string
  while (genomeData.asNEATPatch && typeof genomeData.asNEATPatch === 'string') {
    try { genomeData.asNEATPatch = JSON.parse(genomeData.asNEATPatch); } catch { break; }
  }

  if (!genomeData?.asNEATPatch) throw new Error('No asNEATPatch found in response');

  if (!genomeData.asNEATPatch.toJSON) {
    genomeData.asNEATPatch.toJSON = function () { return this; };
  }

  // Extract a short ID from the URL (last path segment before query params)
  const urlPath = new URL(url).pathname;
  const shortId = urlPath.split('/').filter(Boolean).pop() || 'url-genome';

  return { id: shortId, genome: genomeData };
}

// ─── Load specific genomes by ID or URL ─────────────────────────────────
async function loadGenomesById(ids) {
  const genomes = [];

  // Separate URLs from DB IDs
  const urls = ids.filter(id => id.startsWith('http://') || id.startsWith('https://'));
  const dbIds = ids.filter(id => !id.startsWith('http://') && !id.startsWith('https://'));

  // Fetch URL genomes
  for (const url of urls) {
    try {
      const result = await loadGenomeFromUrl(url);
      genomes.push(result);
      console.log(`  ✓ Loaded from URL: ${result.id}`);
    } catch (e) {
      console.warn(`  ⚠️  URL fetch failed: ${url} — ${e.message}`);
    }
  }

  // Load DB genomes (only if there are DB IDs)
  if (dbIds.length > 0) {
    let db;
    try {
      db = new Database(DB_PATH, { readonly: true });
      const schema = detectSchema(db);
      console.log(`DB schema: ${schema.idCol}/${schema.dataCol}`);

      for (const id of dbIds) {
        try {
          const row = db.prepare(
            `SELECT ${schema.idCol} AS id, ${schema.dataCol} AS data FROM genomes WHERE ${schema.idCol} = ?`
          ).get(id);

          if (!row) {
            console.warn(`  ⚠️  Genome not found in DB: ${id}`);
            continue;
          }

          const genomeData = await parseGenomeRow(row);
          if (!genomeData) { console.warn(`  Skipping ${id}: no asNEATPatch`); continue; }
          genomes.push({ id: row.id, genome: genomeData });
          console.log(`  ✓ Loaded: ${id}`);
        } catch (e) {
          console.warn(`  Skipping ${id}: ${e.message}`);
        }
      }
    } catch (e) {
      console.warn(`  ⚠️  DB access failed (${DB_PATH}): ${e.message}`);
      console.warn(`     DB IDs skipped: ${dbIds.join(', ')}`);
    } finally {
      if (db) db.close();
    }
  }

  return genomes;
}

// ─── Batch render (old setValueCurveAtTime path) ─────────────────────
async function renderBatch(genomeData, duration) {
  const { startMemberOutputsRendering } = await import(`${KROMOSYNTH_PATH}/util/render.js`);
  const { patchFromAsNEATnetwork } = await import(`${KROMOSYNTH_PATH}/util/audio-graph-asNEAT-bridge.js`);
  const { default: Renderer } = await import(`${KROMOSYNTH_PATH}/cppn-neat/network-rendering.js`);

  const asNEATNetworkJSONString = typeof genomeData.asNEATPatch === 'string'
    ? genomeData.asNEATPatch
    : genomeData.asNEATPatch.toJSON ? genomeData.asNEATPatch.toJSON() : JSON.stringify(genomeData.asNEATPatch);
  const synthIsPatch = patchFromAsNEATnetwork(asNEATNetworkJSONString);

  const sampleCount = Math.round(SAMPLE_RATE * duration);

  const offlineContext = new OfflineAudioContext({
    numberOfChannels: 8,
    length: sampleCount,
    sampleRate: SAMPLE_RATE,
  });

  const startTime = performance.now();
  const { memberOutputs, patch: modifiedPatch } = await startMemberOutputsRendering(
    genomeData.waveNetwork, synthIsPatch,
    duration, 0, SAMPLE_RATE, 1.0,
    false, false, USE_GPU, false, false
  );
  const cppnMs = performance.now() - startTime;

  const renderer = new Renderer(SAMPLE_RATE);
  await renderer.wireUpAudioGraphAndConnectToAudioContextDestination(
    memberOutputs, modifiedPatch || synthIsPatch, 0,
    offlineContext, sampleCount, null, 'batch', null
  );

  const renderStart = performance.now();
  const rawBuffer = await offlineContext.startRendering();
  const renderMs = performance.now() - renderStart;

  const chCount = rawBuffer.numberOfChannels;
  const summed = new Float32Array(rawBuffer.length);
  for (let ch = 0; ch < chCount; ch++) {
    const chData = rawBuffer.getChannelData(ch);
    for (let i = 0; i < rawBuffer.length; i++) summed[i] += chData[i];
  }

  let peak = 0;
  for (let i = 0; i < summed.length; i++) {
    const abs = Math.abs(summed[i]);
    if (abs > peak) peak = abs;
  }
  if (peak > 0) {
    for (let i = 0; i < summed.length; i++) summed[i] /= peak;
  }
  ensureBufferStartsAndEndsAtZero(summed);

  return { samples: summed, totalMs: performance.now() - startTime, cppnMs, renderMs };
}

// ─── Worklet-offline render (current WAV path — AudioBufferSourceNode, chunked CPPN) ──
async function renderWorkletOffline(genomeData, duration) {
  const { renderWithWorkletOffline } = await import('./worklet-offline-renderer.js');
  const result = await renderWithWorkletOffline(
    genomeData, duration, 0, 1.0, SAMPLE_RATE, USE_GPU,
    { chunkDuration: 1.0 }
  );
  return {
    samples: result.samples,
    totalMs: result.renderTimeMs,
    cppnMs: result.cppnTimeMs,
    renderMs: result.offlineRenderTimeMs,
  };
}

// ─── Stream-single render (AudioBufferSourceNode streaming DSP, but ONE full-duration CPPN call) ──
// This isolates whether CPPN chunking causes parity differences vs the browser.
// The browser recomputes CPPN per chunk; this does it once. If stream1 ≠ streaming, chunking is the issue.
async function renderStreamSingle(genomeData, duration) {
  const { startMemberOutputsRendering } = await import(`${KROMOSYNTH_PATH}/util/render.js`);
  const { patchFromAsNEATnetwork } = await import(`${KROMOSYNTH_PATH}/util/audio-graph-asNEAT-bridge.js`);
  const { getMemberOutputsKey } = await import(`${KROMOSYNTH_PATH}/util/network-output.js`);
  const { default: Renderer } = await import(`${KROMOSYNTH_PATH}/cppn-neat/network-rendering.js`);

  const asNEATNetworkJSONString = typeof genomeData.asNEATPatch === 'string'
    ? genomeData.asNEATPatch
    : genomeData.asNEATPatch.toJSON ? genomeData.asNEATPatch.toJSON() : JSON.stringify(genomeData.asNEATPatch);
  const synthIsPatch = patchFromAsNEATnetwork(asNEATNetworkJSONString);
  synthIsPatch.duration = duration;

  const totalSamples = Math.round(SAMPLE_RATE * duration);
  const startTime = performance.now();

  // Single full-duration CPPN call (no chunking)
  const tCppn = performance.now();
  const result = await startMemberOutputsRendering(
    genomeData.waveNetwork, synthIsPatch,
    duration, 0, SAMPLE_RATE, 1.0,
    false, false, USE_GPU, false, false,
    totalSamples, 0  // sampleCountToActivate = full duration, offset = 0
  );
  const cppnMs = performance.now() - tCppn;
  const { memberOutputs, patch: modifiedPatch } = result;

  const patchForRender = modifiedPatch || synthIsPatch;
  patchForRender.duration = duration;

  // Build channel mapping
  const channelToMOKey = [];
  const channelNoiseType = [];
  const networkOutputToChannel = new Map();

  patchForRender.networkOutputs.forEach((output, seqIndex) => {
    const moKey = getMemberOutputsKey({ index: output.networkOutput, frequency: output.frequency });
    channelToMOKey.push(moKey);
    const isNoise = typeof output.networkOutput === 'string' && output.networkOutput.startsWith('noise');
    channelNoiseType.push(isNoise ? output.networkOutput : null);
    networkOutputToChannel.set(output.networkOutput, seqIndex);
  });

  const numberOfChannels = channelToMOKey.length;

  const offlineContext = new OfflineAudioContext({
    numberOfChannels: 1,
    length: totalSamples,
    sampleRate: SAMPLE_RATE,
  });

  // Build AudioBufferSourceNodes from the single full-duration CPPN output
  const sequentialWrapperNodes = new Map();
  const sources = [];

  for (let ch = 0; ch < numberOfChannels; ch++) {
    const noiseType = channelNoiseType[ch];
    const moKey = channelToMOKey[ch];

    const allSamples = new Float32Array(totalSamples);

    if (noiseType) {
      for (let i = 0; i < totalSamples; i++) allSamples[i] = Math.random() * 2 - 1;
    } else {
      const output = memberOutputs.get(moKey);
      let samples;
      if (output?.samples?.length > 0) samples = output.samples;
      else if (output instanceof Float32Array && output.length > 0) samples = output;
      if (samples) {
        const copyLen = Math.min(totalSamples, samples.length);
        allSamples.set(samples.subarray(0, copyLen), 0);
      }
    }

    const audioBuffer = offlineContext.createBuffer(1, totalSamples, SAMPLE_RATE);
    audioBuffer.copyToChannel(allSamples, 0);

    const source = offlineContext.createBufferSource();
    source.buffer = audioBuffer;
    const wrapperGain = offlineContext.createGain();
    wrapperGain.gain.value = 1.0;
    source.connect(wrapperGain);
    sources.push(source);
    sequentialWrapperNodes.set(ch, wrapperGain);
  }

  const collapsedWrapperNodes = new Map();
  for (const [networkOutputIndex, seqIndex] of networkOutputToChannel.entries()) {
    const wrapperNode = sequentialWrapperNodes.get(seqIndex);
    if (wrapperNode) collapsedWrapperNodes.set(networkOutputIndex, wrapperNode);
  }

  const renderer = new Renderer(SAMPLE_RATE);
  renderer._wrapperNodesConnected = true;

  const virtualAudioGraph = await renderer.wireUpAudioGraphAndConnectToAudioContextDestination(
    memberOutputs, patchForRender, 0,
    offlineContext,
    totalSamples,  // single chunk = full duration
    collapsedWrapperNodes,
    'streaming'
  );

  // Connect live signals
  const { renderWithWorkletOffline: _unused, ...rest } = {};  // just to trigger the import side-effect
  await connectLiveSignalsLocal(patchForRender, sequentialWrapperNodes, virtualAudioGraph, offlineContext);

  for (const source of sources) source.start(0);

  const renderStart = performance.now();
  const rawBuffer = await offlineContext.startRendering();
  const renderMs = performance.now() - renderStart;

  const outputLength = rawBuffer.length;
  const summed = new Float32Array(outputLength);
  for (let ch = 0; ch < rawBuffer.numberOfChannels; ch++) {
    const chData = rawBuffer.getChannelData(ch);
    for (let i = 0; i < outputLength; i++) summed[i] += chData[i];
  }
  let peak = 0;
  for (let i = 0; i < summed.length; i++) {
    if (!isNaN(summed[i]) && Math.abs(summed[i]) > peak) peak = Math.abs(summed[i]);
  }
  if (peak > 0) for (let i = 0; i < summed.length; i++) summed[i] = isNaN(summed[i]) ? 0 : summed[i] / peak;
  ensureBufferStartsAndEndsAtZero(summed);

  return { samples: summed, totalMs: performance.now() - startTime, cppnMs, renderMs };
}

// ─── connectLiveSignals (local copy — same as worklet-offline-renderer.js) ──
// Duplicated here so renderStreamSingle can use it without importing from worklet-offline-renderer.
async function connectLiveSignalsLocal(patch, sequentialWrapperNodes, virtualAudioGraph, audioContext) {
  let connectionsCount = 0;
  const extraNodes = [];
  const bufferIndexPerNode = new Map();
  const lastStdBufferSeqIndex = new Map();

  patch.networkOutputs.forEach((oneOutput, seqIndex) => {
    for (const audioGraphNodeKey in oneOutput.audioGraphNodes) {
      const conns = oneOutput.audioGraphNodes[audioGraphNodeKey];
      conns.forEach((c) => {
        if (c.paramName === 'buffer') {
          const vn = virtualAudioGraph.virtualNodes[audioGraphNodeKey];
          if (vn && !vn.virtualNodes) lastStdBufferSeqIndex.set(audioGraphNodeKey, seqIndex);
        }
      });
    }
  });

  patch.networkOutputs.forEach((oneOutput, seqIndex) => {
    const wrapperNode = sequentialWrapperNodes.get(seqIndex);
    if (!wrapperNode) return;

    for (const audioGraphNodeKey in oneOutput.audioGraphNodes) {
      const connections = oneOutput.audioGraphNodes[audioGraphNodeKey];
      const virtualNode = virtualAudioGraph.virtualNodes[audioGraphNodeKey];
      if (!virtualNode) continue;
      const audioNode = virtualNode.audioNode;

      connections.forEach((connection) => {
        try {
          const paramName = connection.paramName;
          const isCustomNode = !!virtualNode.virtualNodes;

          const connectWithRange = (targetNode) => {
            if (connection.range) {
              const [min, max] = connection.range;
              const mid = (min + max) / 2, half = (max - min) / 2;
              const scaleNode = audioContext.createGain();
              scaleNode.gain.value = half;
              wrapperNode.connect(scaleNode);
              scaleNode.connect(targetNode);
              const offsetNode = audioContext.createConstantSource();
              offsetNode.offset.value = mid;
              offsetNode.connect(targetNode);
              offsetNode.start();
              extraNodes.push(scaleNode, offsetNode);
            } else {
              wrapperNode.connect(targetNode);
            }
            connectionsCount++;
          };

          if (paramName === 'buffer') {
            if (isCustomNode) {
              const idx = (bufferIndexPerNode.get(audioGraphNodeKey) || 0) + 1;
              bufferIndexPerNode.set(audioGraphNodeKey, idx);
              const child = virtualNode.virtualNodes[`audioWave${idx}`];
              if (child?.audioNode) connectWithRange(child.audioNode);
            } else if (audioNode?.constructor?.name === 'GainNode') {
              if (lastStdBufferSeqIndex.get(audioGraphNodeKey) === seqIndex) connectWithRange(audioNode);
            }
            return;
          }
          if (paramName === 'partialBuffer') {
            if (isCustomNode) {
              const child = virtualNode.virtualNodes[`audioWave${connection.partialNumber || 1}`];
              if (child?.audioNode) connectWithRange(child.audioNode);
            }
            return;
          }
          if (paramName === 'partialGainEnvelope') {
            if (isCustomNode) {
              const child = virtualNode.virtualNodes[`gainValueCurve${connection.partialNumber || 1}`];
              if (child?.audioNode?.gain) {
                const range = connection.range || [0, 1];
                const mid = (range[0] + range[1]) / 2, half = (range[1] - range[0]) / 2;
                child.audioNode.gain.value = mid;
                const scaleNode = audioContext.createGain();
                scaleNode.gain.value = half;
                wrapperNode.connect(scaleNode);
                scaleNode.connect(child.audioNode.gain);
                extraNodes.push(scaleNode);
                connectionsCount++;
              }
            }
            return;
          }
          if (paramName === 'mix' || paramName === 'curve') return;

          if (audioNode && audioNode[paramName]?.constructor?.name === 'AudioParam') {
            if (connection.range) {
              const [min, max] = connection.range;
              const mid = (min + max) / 2, half = (max - min) / 2;
              audioNode[paramName].value = mid;
              const scaleNode = audioContext.createGain();
              scaleNode.gain.value = half;
              wrapperNode.connect(scaleNode);
              scaleNode.connect(audioNode[paramName]);
              extraNodes.push(scaleNode);
              connectionsCount++;
            } else {
              audioNode[paramName].value = 0;
              wrapperNode.connect(audioNode[paramName]);
              connectionsCount++;
            }
          }
        } catch (connErr) {
          // ignore
        }
      });
    }
  });
  return extraNodes;
}

// ─── Compare ────────────────────────────────────────────────────────
function compareOutputs(a, b) {
  const minLen = Math.min(a.length, b.length);
  let sumSqDiff = 0, maxDiff = 0, nonZeroA = 0, nonZeroB = 0;
  // Also check first 2048 samples for leading silence (fade-in indicator)
  let leadingSilenceSamplesA = 0, leadingSilenceSamplesB = 0;
  const CHECK = Math.min(2048, minLen);
  for (let i = 0; i < CHECK; i++) {
    if (Math.abs(a[i]) < 1e-4) leadingSilenceSamplesA++;
    if (Math.abs(b[i]) < 1e-4) leadingSilenceSamplesB++;
  }

  for (let i = 0; i < minLen; i++) {
    const diff = a[i] - b[i];
    sumSqDiff += diff * diff;
    const ad = Math.abs(diff);
    if (ad > maxDiff) maxDiff = ad;
    if (Math.abs(a[i]) > 1e-6) nonZeroA++;
    if (Math.abs(b[i]) > 1e-6) nonZeroB++;
  }
  return {
    rmse: Math.sqrt(sumSqDiff / minLen),
    maxDiff,
    silentA: nonZeroA === 0,
    silentB: nonZeroB === 0,
    nonZeroA,
    nonZeroB,
    leadingSilenceA: leadingSilenceSamplesA,
    leadingSilenceB: leadingSilenceSamplesB,
  };
}

// ─── Write WAV ──────────────────────────────────────────────────────
function writeWav(filePath, samples, sampleRate) {
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples.length * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  fs.writeFileSync(filePath, buffer);
}

// ─── Genome traits (detailed) ─────────────────────────────────────────
function getTraits(genomeData) {
  const patchStr = JSON.stringify(genomeData.asNEATPatch);

  // Detect 'mix' paramName connections (wavetable crossfade — skipped in connectLiveSignals!)
  let mixConnections = 0;
  const outputs = genomeData.asNEATPatch?.networkOutputs || [];
  for (const output of outputs) {
    for (const nodeKey in (output.audioGraphNodes || {})) {
      for (const conn of (output.audioGraphNodes[nodeKey] || [])) {
        if (conn.paramName === 'mix') mixConnections++;
      }
    }
  }

  // Count wavetable nodes (those with virtualNodes children like audioWave1, audioWave2...)
  const nodeTypes = {};
  for (const nodeKey in (genomeData.asNEATPatch?.audioGraphNodeTypes || {})) {
    const t = genomeData.asNEATPatch.audioGraphNodeTypes[nodeKey];
    nodeTypes[t] = (nodeTypes[t] || 0) + 1;
  }

  return {
    hasDelay: patchStr.includes('delay') || patchStr.includes('Delay'),
    hasConvolver: patchStr.includes('convolver') || patchStr.includes('Convolver'),
    hasFeedback: patchStr.includes('feedback'),
    hasWavetable: patchStr.includes('wavetable') || patchStr.includes('Wavetable'),
    mixConnections, // > 0 means mix param is present — these are SKIPPED in connectLiveSignals!
    nodeCount: genomeData.asNEATPatch?.nodes?.length || 0,
    connCount: genomeData.asNEATPatch?.connections?.length || 0,
    networkOutputCount: outputs.length,
    nodeTypes,
  };
}

// ─── Main ───────────────────────────────────────────────────────────
async function main() {
  const cli = parseCli();
  const { duration } = cli;

  console.log(`\n${'═'.repeat(100)}`);
  if (cli.mode === 'ids') {
    const urlCount = cli.ids.filter(id => id.startsWith('http://') || id.startsWith('https://')).length;
    const dbCount = cli.ids.length - urlCount;
    console.log(`Specific genome comparison: ${cli.ids.length} genome(s) × ${duration}s`);
    if (urlCount > 0) console.log(`  URLs: ${urlCount}`);
    if (dbCount > 0) console.log(`  DB IDs: ${dbCount}`);
    console.log(`IDs/URLs: ${cli.ids.join(', ')}`);
  } else {
    console.log(`Batch comparison: ${cli.count} random genomes × ${duration}s`);
  }
  console.log(`DB: ${DB_PATH} (used for DB IDs only)`);
  console.log(`Output: ${OUT_DIR}`);
  console.log(`Render paths: batch (setValueCurveAtTime) | streaming (AudioBufSrc, full-duration CPPN + mix gain curves) | stream1 (AudioBufSrc, no mix)`);
  console.log('═'.repeat(100) + '\n');

  // Ensure output directory
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Load genomes
  const genomes = cli.mode === 'ids'
    ? await loadGenomesById(cli.ids)
    : await loadRandomGenomes(cli.count);

  if (genomes.length === 0) {
    console.error('No genomes loaded. Check DB path and genome IDs.');
    process.exit(1);
  }
  console.log(`\nLoaded ${genomes.length} genome(s)\n`);

  const results = [];

  for (let i = 0; i < genomes.length; i++) {
    const { id, genome } = genomes[i];
    const traits = getTraits(genome);

    const traitStr = [
      traits.hasDelay ? 'delay' : '',
      traits.hasConvolver ? 'conv' : '',
      traits.hasFeedback ? 'fb' : '',
      traits.hasWavetable ? 'wt' : '',
      traits.mixConnections > 0 ? `mix(${traits.mixConnections})⚠️` : '',
    ].filter(Boolean).join('+') || 'basic';

    console.log(`\n── [${i + 1}/${genomes.length}] ${id} ──`);
    console.log(`   Nodes: ${traits.nodeCount}, Conns: ${traits.connCount}, NetworkOutputs: ${traits.networkOutputCount}, Traits: ${traitStr}`);
    if (traits.mixConnections > 0) {
      console.log(`   ℹ️  ${traits.mixConnections} 'mix' param connection(s) — wavetable crossfade handled via AudioBufferSourceNode gain curves.`);
    }
    if (Object.keys(traits.nodeTypes).length > 0) {
      console.log(`   Node types: ${JSON.stringify(traits.nodeTypes)}`);
    }

    let batchResult = null, streamingResult = null, stream1Result = null;
    let batchError = null, streamingError = null, stream1Error = null;

    // 1. Batch render (setValueCurveAtTime)
    console.log(`   [batch]     rendering...`);
    try {
      batchResult = await renderBatch(genome, duration);
      console.log(`   [batch]     ${batchResult.totalMs.toFixed(0)}ms total (CPPN: ${batchResult.cppnMs.toFixed(0)}ms, render: ${batchResult.renderMs.toFixed(0)}ms)`);
    } catch (e) {
      batchError = e.message;
      console.log(`   [batch]     FAILED — ${e.message.slice(0, 100)}`);
    }

    // 2. Streaming render (AudioBufferSourceNode, 1s chunks)
    console.log(`   [streaming] rendering...`);
    try {
      streamingResult = await renderWorkletOffline(genome, duration);
      console.log(`   [streaming] ${streamingResult.totalMs.toFixed(0)}ms total (CPPN: ${streamingResult.cppnMs.toFixed(0)}ms, render: ${streamingResult.renderMs.toFixed(0)}ms)`);
    } catch (e) {
      streamingError = e.message;
      console.log(`   [streaming] FAILED — ${e.message.slice(0, 100)}`);
    }

    // 3. Stream-single (AudioBufferSourceNode, full-duration CPPN)
    console.log(`   [stream1]   rendering...`);
    try {
      stream1Result = await renderStreamSingle(genome, duration);
      console.log(`   [stream1]   ${stream1Result.totalMs.toFixed(0)}ms total (CPPN: ${stream1Result.cppnMs.toFixed(0)}ms, render: ${stream1Result.renderMs.toFixed(0)}ms)`);
    } catch (e) {
      stream1Error = e.message;
      console.log(`   [stream1]   FAILED — ${e.message.slice(0, 100)}`);
    }

    // Compare & write WAVs
    let cmp_b_s = null, cmp_b_s1 = null, cmp_s_s1 = null;

    if (batchResult && streamingResult) {
      cmp_b_s = compareOutputs(batchResult.samples, streamingResult.samples);
      const status = cmp_b_s.silentA || cmp_b_s.silentB ? 'SILENT'
        : cmp_b_s.rmse < 0.01 ? 'MATCH' : cmp_b_s.rmse < 0.1 ? 'CLOSE' : 'DIFF';
      console.log(`   batch vs streaming : RMSE ${cmp_b_s.rmse.toFixed(4)}, maxDiff ${cmp_b_s.maxDiff.toFixed(4)} [${status}]`
        + (cmp_b_s.leadingSilenceB > 100 ? `  ⚠️ streaming has ${cmp_b_s.leadingSilenceB} leading silent samples (fade-in!)` : ''));
    }

    if (batchResult && stream1Result) {
      cmp_b_s1 = compareOutputs(batchResult.samples, stream1Result.samples);
      const status = cmp_b_s1.silentA || cmp_b_s1.silentB ? 'SILENT'
        : cmp_b_s1.rmse < 0.01 ? 'MATCH' : cmp_b_s1.rmse < 0.1 ? 'CLOSE' : 'DIFF';
      console.log(`   batch vs stream1   : RMSE ${cmp_b_s1.rmse.toFixed(4)}, maxDiff ${cmp_b_s1.maxDiff.toFixed(4)} [${status}]`
        + (cmp_b_s1.leadingSilenceB > 100 ? `  ⚠️ stream1 has ${cmp_b_s1.leadingSilenceB} leading silent samples` : ''));
    }

    if (streamingResult && stream1Result) {
      cmp_s_s1 = compareOutputs(streamingResult.samples, stream1Result.samples);
      const status = cmp_s_s1.silentA || cmp_s_s1.silentB ? 'SILENT'
        : cmp_s_s1.rmse < 0.01 ? 'MATCH' : cmp_s_s1.rmse < 0.1 ? 'CLOSE' : 'DIFF';
      console.log(`   streaming vs stream1: RMSE ${cmp_s_s1.rmse.toFixed(4)}, maxDiff ${cmp_s_s1.maxDiff.toFixed(4)} [${status}]`
        + (cmp_s_s1.rmse > 0.01 ? '  ← CHUNKING EFFECT' : ''));
    }

    // Write WAV files
    const safeid = id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    if (batchResult)     writeWav(path.join(OUT_DIR, `${safeid}_batch.wav`),     batchResult.samples,     SAMPLE_RATE);
    if (streamingResult) writeWav(path.join(OUT_DIR, `${safeid}_streaming.wav`), streamingResult.samples, SAMPLE_RATE);
    if (stream1Result)   writeWav(path.join(OUT_DIR, `${safeid}_stream1.wav`),   stream1Result.samples,   SAMPLE_RATE);

    results.push({
      id, traits, traitStr,
      batchMs: batchResult?.totalMs,
      streamingMs: streamingResult?.totalMs,
      stream1Ms: stream1Result?.totalMs,
      rmse_b_s: cmp_b_s?.rmse,
      rmse_b_s1: cmp_b_s1?.rmse,
      rmse_s_s1: cmp_s_s1?.rmse,
      leadingSilenceStreaming: cmp_b_s?.leadingSilenceB,
      batchError, streamingError, stream1Error,
    });
  }

  // ── Summary ─────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(110));
  console.log('SUMMARY');
  console.log('═'.repeat(110));
  console.log(`${'ID'.padEnd(32)} ${'Traits'.padEnd(18)} ${'b↔s RMSE'.padEnd(10)} ${'b↔s1 RMSE'.padEnd(11)} ${'s↔s1 RMSE'.padEnd(10)} ${'Lead sil'.padEnd(10)} Status`);
  console.log('─'.repeat(110));

  let matchCount = 0, closeCount = 0, diffCount = 0, failCount = 0, fadeInCount = 0;

  for (const r of results) {
    const hasFail = r.batchError || r.streamingError || r.stream1Error;
    let status;
    if (hasFail) { status = 'FAIL'; failCount++; }
    else if ((r.leadingSilenceStreaming || 0) > 100) { status = 'FADE-IN'; fadeInCount++; }
    else if (!r.rmse_b_s) { status = '?'; }
    else if (r.rmse_b_s < 0.01) { status = 'MATCH'; matchCount++; }
    else if (r.rmse_b_s < 0.1) { status = 'CLOSE'; closeCount++; }
    else { status = 'DIFF'; diffCount++; }

    const mixWarn = r.traits.mixConnections > 0 ? ` mix(${r.traits.mixConnections})` : '';

    console.log(
      `${r.id.padEnd(32)} ${(r.traitStr + mixWarn).padEnd(18)} ` +
      `${(r.rmse_b_s?.toFixed(4) || 'N/A').padEnd(10)} ` +
      `${(r.rmse_b_s1?.toFixed(4) || 'N/A').padEnd(11)} ` +
      `${(r.rmse_s_s1?.toFixed(4) || 'N/A').padEnd(10)} ` +
      `${String(r.leadingSilenceStreaming ?? 'N/A').padEnd(10)} ${status}`
    );
    if (hasFail) {
      if (r.batchError)     console.log(`  batch error:     ${r.batchError.slice(0, 80)}`);
      if (r.streamingError) console.log(`  streaming error: ${r.streamingError.slice(0, 80)}`);
      if (r.stream1Error)   console.log(`  stream1 error:   ${r.stream1Error.slice(0, 80)}`);
    }
  }

  console.log('─'.repeat(110));
  console.log(`MATCH: ${matchCount}  CLOSE: ${closeCount}  DIFF: ${diffCount}  FADE-IN: ${fadeInCount}  FAIL: ${failCount}`);
  console.log(`\nWAV files: ${OUT_DIR}`);
  console.log(`  *_batch.wav     — setValueCurveAtTime, 8-channel, looped waveform (old path)`);
  console.log(`  *_streaming.wav — AudioBufferSourceNode, single full-duration CPPN, mix gain curves (current WAV path)`);
  console.log(`  *_stream1.wav   — AudioBufferSourceNode, single full-duration CPPN, no mix (diagnostic)`);
  console.log('\nDiagnosis guide:');
  console.log('  streaming ≈ batch    → both offline paths agree (expected for most genomes)');
  console.log('  streaming ≈ stream1  → wavetable mix crossfade not changing output (check gain curve delivery)');
  console.log('  FADE-IN              → CPPN warm-up (expected for wavetable/pure-CPPN genomes, matches browser)');
  console.log('  DIFF (fb genomes)    → feedback loops diverge between batch/streaming (different init state, expected)');
  console.log('Done.\n');

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
