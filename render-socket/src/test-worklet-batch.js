#!/usr/bin/env node
/**
 * Batch comparison: Render N random genomes via both batch and worklet-offline paths.
 *
 * Usage:
 *   node --experimental-vm-modules src/test-worklet-batch.js [count] [duration]
 *
 * Environment:
 *   DB_PATH — path to genome database (auto-detects schema: recommend vs evorun)
 *
 * Outputs WAV pairs into render-socket/comparison-wavs/
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

// ─── Configuration ──────────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || '/Users/bjornpjo/Developer/apps/synth.is/kromosynth-recommend/data/genomes.db';
const SAMPLE_RATE = 48000;
const DEFAULT_COUNT = 10;
const DEFAULT_DURATION = 4;
const USE_GPU = true;

const KROMOSYNTH_PATH = '../../../kromosynth';
const SCRIPT_DIR = path.dirname(new URL(import.meta.url).pathname);
const OUT_DIR = path.join(SCRIPT_DIR, '..', 'comparison-wavs');

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

// ─── Load N random genomes ──────────────────────────────────────────
async function loadRandomGenomes(count) {
  const db = new Database(DB_PATH, { readonly: true });
  const schema = detectSchema(db);
  console.log(`DB schema: ${schema.idCol}/${schema.dataCol}`);

  const rows = db.prepare(
    `SELECT ${schema.idCol} AS id, ${schema.dataCol} AS data FROM genomes ORDER BY RANDOM() LIMIT ?`
  ).all(count);

  const genomes = [];
  for (const row of rows) {
    try {
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

      if (!genomeData.asNEATPatch) {
        console.warn(`  Skipping ${row.id}: no asNEATPatch`);
        continue;
      }

      if (!genomeData.asNEATPatch.toJSON) {
        genomeData.asNEATPatch.toJSON = function () { return this; };
      }

      genomes.push({ id: row.id, genome: genomeData });
    } catch (e) {
      console.warn(`  Skipping ${row.id}: ${e.message}`);
    }
  }

  db.close();
  return genomes;
}

// ─── Batch render (existing path) ───────────────────────────────────
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

// ─── Worklet-offline render (new unified path) ──────────────────────
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

// ─── Compare ────────────────────────────────────────────────────────
function compareOutputs(a, b) {
  const minLen = Math.min(a.length, b.length);
  let sumSqDiff = 0, maxDiff = 0, nonZeroA = 0, nonZeroB = 0;
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

// ─── Genome traits ──────────────────────────────────────────────────
function getTraits(genomeData) {
  const patchStr = JSON.stringify(genomeData.asNEATPatch);
  return {
    hasDelay: patchStr.includes('delay') || patchStr.includes('Delay'),
    hasConvolver: patchStr.includes('convolver') || patchStr.includes('Convolver'),
    hasFeedback: patchStr.includes('feedback'),
    nodeCount: genomeData.asNEATPatch?.nodes?.length || 0,
    connCount: genomeData.asNEATPatch?.connections?.length || 0,
  };
}

// ─── Main ───────────────────────────────────────────────────────────
async function main() {
  const count = parseInt(process.argv[2]) || DEFAULT_COUNT;
  const duration = parseFloat(process.argv[3]) || DEFAULT_DURATION;

  console.log(`\nBatch Comparison: ${count} genomes × ${duration}s`);
  console.log(`DB: ${DB_PATH}`);
  console.log(`Output: ${OUT_DIR}\n`);

  // Ensure output directory
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Load genomes
  const genomes = await loadRandomGenomes(count);
  console.log(`Loaded ${genomes.length} genomes\n`);

  const results = [];

  for (let i = 0; i < genomes.length; i++) {
    const { id, genome } = genomes[i];
    const traits = getTraits(genome);
    const traitStr = [
      traits.hasDelay ? 'delay' : '',
      traits.hasConvolver ? 'conv' : '',
      traits.hasFeedback ? 'fb' : '',
    ].filter(Boolean).join('+') || 'basic';

    console.log(`── [${i + 1}/${genomes.length}] ${id} (${traits.nodeCount}n/${traits.connCount}c, ${traitStr}) ──`);

    let batchResult = null, workletResult = null, comparison = null;
    let batchError = null, workletError = null;

    // Batch render
    try {
      batchResult = await renderBatch(genome, duration);
    } catch (e) {
      batchError = e.message;
      console.log(`  BATCH: FAILED — ${e.message.slice(0, 80)}`);
    }

    // Worklet-offline render
    try {
      workletResult = await renderWorkletOffline(genome, duration);
    } catch (e) {
      workletError = e.message;
      console.log(`  WORKLET: FAILED — ${e.message.slice(0, 80)}`);
    }

    // Compare & write WAVs
    if (batchResult && workletResult) {
      comparison = compareOutputs(batchResult.samples, workletResult.samples);

      const status = comparison.silentA || comparison.silentB ? 'SILENT'
        : comparison.rmse < 0.01 ? 'MATCH'
        : comparison.rmse < 0.1 ? 'CLOSE'
        : 'DIFF';

      console.log(`  BATCH:   ${batchResult.totalMs.toFixed(0)}ms | WORKLET: ${workletResult.totalMs.toFixed(0)}ms | RMSE: ${comparison.rmse.toFixed(4)} [${status}]`);

      writeWav(path.join(OUT_DIR, `${id}_batch.wav`), batchResult.samples, SAMPLE_RATE);
      writeWav(path.join(OUT_DIR, `${id}_worklet.wav`), workletResult.samples, SAMPLE_RATE);
    } else if (workletResult) {
      writeWav(path.join(OUT_DIR, `${id}_worklet.wav`), workletResult.samples, SAMPLE_RATE);
      console.log(`  (only worklet succeeded)`);
    } else if (batchResult) {
      writeWav(path.join(OUT_DIR, `${id}_batch.wav`), batchResult.samples, SAMPLE_RATE);
      console.log(`  (only batch succeeded)`);
    }

    results.push({
      id, traits, traitStr,
      batchMs: batchResult?.totalMs,
      workletMs: workletResult?.totalMs,
      rmse: comparison?.rmse,
      maxDiff: comparison?.maxDiff,
      silentBatch: comparison?.silentA,
      silentWorklet: comparison?.silentB,
      batchError,
      workletError,
    });
  }

  // ── Summary ─────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(100));
  console.log('SUMMARY');
  console.log('═'.repeat(100));
  console.log(`${'ID'.padEnd(28)} ${'Traits'.padEnd(16)} ${'RMSE'.padEnd(10)} ${'Batch ms'.padEnd(10)} ${'Wklt ms'.padEnd(10)} Status`);
  console.log('─'.repeat(100));

  let matchCount = 0, closeCount = 0, diffCount = 0, failCount = 0, silentCount = 0;

  for (const r of results) {
    let status;
    if (r.batchError || r.workletError) { status = 'FAIL'; failCount++; }
    else if (r.silentBatch || r.silentWorklet) { status = 'SILENT'; silentCount++; }
    else if (r.rmse < 0.01) { status = 'MATCH'; matchCount++; }
    else if (r.rmse < 0.1) { status = 'CLOSE'; closeCount++; }
    else { status = 'DIFF'; diffCount++; }

    console.log(
      `${r.id.padEnd(28)} ${r.traitStr.padEnd(16)} ${(r.rmse?.toFixed(4) || 'N/A').padEnd(10)} ` +
      `${(r.batchMs?.toFixed(0) || 'FAIL').padEnd(10)} ${(r.workletMs?.toFixed(0) || 'FAIL').padEnd(10)} ${status}`
    );
  }

  console.log('─'.repeat(100));
  console.log(`MATCH: ${matchCount}  CLOSE: ${closeCount}  DIFF: ${diffCount}  SILENT: ${silentCount}  FAIL: ${failCount}`);
  console.log(`\nWAV files: ${OUT_DIR}`);
  console.log('Done.\n');

  process.exit(0);
}

// Handle AudioWorklet cleanup error (expected)
process.on('uncaughtException', (error) => {
  if (error.message && error.message.includes('expect Object, got: Undefined')) {
    // expected at end of offline render
  } else {
    console.error('Uncaught exception:', error);
    process.exit(1);
  }
});

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
