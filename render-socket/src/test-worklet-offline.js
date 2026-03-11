#!/usr/bin/env node
/**
 * Test script: Compare batch rendering vs worklet-offline rendering
 *
 * Usage:
 *   node --experimental-vm-modules src/test-worklet-offline.js [genomeId] [duration]
 *
 * Renders the same genome with both the existing batch path and the new
 * worklet-offline path, then compares the outputs.
 *
 * Metrics reported:
 *   - RMSE (Root Mean Square Error) between outputs
 *   - Peak difference
 *   - Timing comparison
 *   - Whether delay-heavy genomes produce matching results
 */

import Database from 'better-sqlite3';
import zlib from 'zlib';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

import NodeWebAudioAPI from '../../../kromosynth/node_modules/node-web-audio-api/index.mjs';
const { OfflineAudioContext, AudioContext } = NodeWebAudioAPI;
import { ensureBufferStartsAndEndsAtZero } from '../../../kromosynth/util/audio-buffer.js';

const gunzip = promisify(zlib.gunzip);

// ─── Configuration ──────────────────────────────────────────────────
const DB_PATH = process.env.DB_PATH || '/Users/bjornpjo/QD/evoruns/01JF0WEW4BTQSWWKGFR72JQ7J6_evoConf_singleMap_refSingleEmb_mfcc-sans0-statistics_AE_retrainIncr50_zScoreNSynthTrain_noveltySel/genomes.sqlite';
const SAMPLE_RATE = 48000;
const DEFAULT_DURATION = 4;
const USE_GPU = true;

const KROMOSYNTH_PATH = '../../../kromosynth';

// ─── Load genome from database ──────────────────────────────────────
async function loadGenome(genomeId) {
  const db = new Database(DB_PATH, { readonly: true });

  let row;
  if (genomeId) {
    row = db.prepare('SELECT id, data FROM genomes WHERE id = ?').get(genomeId);
  } else {
    // Pick a random genome
    row = db.prepare('SELECT id, data FROM genomes ORDER BY RANDOM() LIMIT 1').get();
  }

  if (!row) {
    db.close();
    throw new Error(`Genome ${genomeId || 'random'} not found`);
  }

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

  if (!genomeData.asNEATPatch?.toJSON) {
    genomeData.asNEATPatch.toJSON = function() { return this; };
  }

  db.close();
  return { id: row.id, genome: genomeData };
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

  // CPPN activation (full duration, no chunking)
  const { memberOutputs, patch: modifiedPatch } = await startMemberOutputsRendering(
    genomeData.waveNetwork, synthIsPatch,
    duration, 0, SAMPLE_RATE, 1.0,
    false, false, USE_GPU, false, false
  );

  const cppnMs = performance.now() - startTime;

  // Wire audio graph
  const renderer = new Renderer(SAMPLE_RATE);
  await renderer.wireUpAudioGraphAndConnectToAudioContextDestination(
    memberOutputs, modifiedPatch || synthIsPatch, 0,
    offlineContext, sampleCount, null, 'batch', null
  );

  // Render
  const renderStart = performance.now();
  const rawBuffer = await offlineContext.startRendering();
  const renderMs = performance.now() - renderStart;

  // Sum channels
  const chCount = rawBuffer.numberOfChannels;
  const summed = new Float32Array(rawBuffer.length);
  for (let ch = 0; ch < chCount; ch++) {
    const chData = rawBuffer.getChannelData(ch);
    for (let i = 0; i < rawBuffer.length; i++) summed[i] += chData[i];
  }

  // Peak-normalise
  let peak = 0;
  for (let i = 0; i < summed.length; i++) {
    const abs = Math.abs(summed[i]);
    if (abs > peak) peak = abs;
  }
  if (peak > 0) {
    for (let i = 0; i < summed.length; i++) summed[i] /= peak;
  }

  ensureBufferStartsAndEndsAtZero(summed);

  const totalMs = performance.now() - startTime;

  return {
    samples: summed,
    totalMs,
    cppnMs,
    renderMs,
    label: 'BATCH (setValueCurveAtTime)',
  };
}


// ─── Worklet-offline render (new unified path) ──────────────────────
async function renderWorkletOffline(genomeData, duration) {
  const { renderWithWorkletOffline } = await import('./worklet-offline-renderer.js');

  const startTime = performance.now();
  const result = await renderWithWorkletOffline(
    genomeData, duration, 0, 1.0, SAMPLE_RATE, USE_GPU,
    { chunkDuration: 1.0 }
  );
  const totalMs = performance.now() - startTime;

  return {
    samples: result.samples,
    totalMs,
    cppnMs: result.cppnTimeMs,
    renderMs: result.offlineRenderTimeMs,
    label: 'WORKLET-OFFLINE (AudioWorklet signal feeding)',
  };
}


// ─── Compare two Float32Arrays ──────────────────────────────────────
function compareOutputs(a, b, labelA, labelB) {
  const minLen = Math.min(a.length, b.length);

  let sumSquaredDiff = 0;
  let maxDiff = 0;
  let maxDiffSample = 0;
  let nonZeroA = 0, nonZeroB = 0;

  for (let i = 0; i < minLen; i++) {
    const diff = a[i] - b[i];
    sumSquaredDiff += diff * diff;
    const absDiff = Math.abs(diff);
    if (absDiff > maxDiff) {
      maxDiff = absDiff;
      maxDiffSample = i;
    }
    if (Math.abs(a[i]) > 1e-6) nonZeroA++;
    if (Math.abs(b[i]) > 1e-6) nonZeroB++;
  }

  const rmse = Math.sqrt(sumSquaredDiff / minLen);

  // Check for silence
  const silentA = nonZeroA === 0;
  const silentB = nonZeroB === 0;

  console.log('\n' + '═'.repeat(60));
  console.log('COMPARISON RESULTS');
  console.log('═'.repeat(60));
  console.log(`  ${labelA}: ${a.length} samples (${silentA ? '⚠️ SILENT!' : `${nonZeroA} non-zero`})`);
  console.log(`  ${labelB}: ${b.length} samples (${silentB ? '⚠️ SILENT!' : `${nonZeroB} non-zero`})`);
  console.log(`  RMSE:           ${rmse.toFixed(8)}`);
  console.log(`  Peak difference: ${maxDiff.toFixed(8)} at sample ${maxDiffSample} (${(maxDiffSample / SAMPLE_RATE).toFixed(3)}s)`);
  console.log(`  Length match:    ${a.length === b.length ? '✅' : `❌ (${a.length} vs ${b.length})`}`);

  // Interpret
  if (silentA || silentB) {
    console.log(`  ⚠️  One or both outputs are SILENT — check rendering pipeline`);
  } else if (rmse < 1e-6) {
    console.log(`  ✅ IDENTICAL (RMSE < 1e-6)`);
  } else if (rmse < 0.01) {
    console.log(`  ✅ Very close (RMSE < 0.01) — minor floating-point differences`);
  } else if (rmse < 0.1) {
    console.log(`  ⚠️  Noticeable difference (RMSE ${rmse.toFixed(4)}) — may be audible`);
  } else {
    console.log(`  ❌ SIGNIFICANT difference (RMSE ${rmse.toFixed(4)}) — outputs are different`);
  }

  // First N samples comparison
  console.log('\n  First 10 samples:');
  for (let i = 0; i < Math.min(10, minLen); i++) {
    console.log(`    [${i}] ${labelA.slice(0, 7)}=${a[i].toFixed(6)} | ${labelB.slice(0, 7)}=${b[i].toFixed(6)} | diff=${(a[i] - b[i]).toFixed(8)}`);
  }

  return { rmse, maxDiff, maxDiffSample, silentA, silentB };
}


// ─── Write raw Float32 to WAV ───────────────────────────────────────
function writeWav(filePath, samples, sampleRate) {
  const buffer = Buffer.alloc(44 + samples.length * 2);

  // WAV header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples.length * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // chunk size
  buffer.writeUInt16LE(1, 20);  // PCM
  buffer.writeUInt16LE(1, 22);  // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32);  // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples.length * 2, 40);

  // Audio data (16-bit PCM)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }

  fs.writeFileSync(filePath, buffer);
  console.log(`  Written: ${filePath} (${(buffer.length / 1024).toFixed(0)} KB)`);
}


// ─── Main ───────────────────────────────────────────────────────────
async function main() {
  const genomeId = process.argv[2] || null;
  const duration = parseFloat(process.argv[3]) || DEFAULT_DURATION;

  console.log('╔' + '═'.repeat(58) + '╗');
  console.log('║  Worklet-Offline Renderer: Comparison Test                ║');
  console.log('╚' + '═'.repeat(58) + '╝');
  console.log();
  console.log(`  Genome:    ${genomeId || 'random from DB'}`);
  console.log(`  Duration:  ${duration}s`);
  console.log(`  DB:        ${DB_PATH}`);
  console.log(`  GPU:       ${USE_GPU}`);
  console.log();

  // Load genome
  const { id, genome } = await loadGenome(genomeId);
  console.log(`Loaded genome: ${id}`);
  console.log(`  Nodes: ${genome.asNEATPatch?.nodes?.length}`);
  console.log(`  Connections: ${genome.asNEATPatch?.connections?.length}`);
  console.log();

  // Check for delay nodes (the interesting case)
  const patchStr = JSON.stringify(genome.asNEATPatch);
  const hasDelay = patchStr.includes('delay') || patchStr.includes('Delay');
  const hasConvolver = patchStr.includes('convolver') || patchStr.includes('Convolver');
  const hasFeedback = patchStr.includes('feedback');
  console.log(`  Has delay nodes:    ${hasDelay ? '✅ YES (interesting!)' : 'no'}`);
  console.log(`  Has convolver:      ${hasConvolver ? '✅ YES' : 'no'}`);
  console.log(`  Has feedback paths: ${hasFeedback ? '✅ YES' : 'no'}`);
  console.log();

  // ── Render with both paths ────────────────────────────────────────
  console.log('━'.repeat(60));
  console.log('PATH 1: Batch (existing setValueCurveAtTime path)');
  console.log('━'.repeat(60));
  let batchResult;
  try {
    batchResult = await renderBatch(genome, duration);
    console.log(`\n✅ Batch: ${batchResult.totalMs.toFixed(0)}ms total (CPPN: ${batchResult.cppnMs.toFixed(0)}ms, Render: ${batchResult.renderMs.toFixed(0)}ms)`);
  } catch (e) {
    console.error(`❌ Batch render failed:`, e);
    batchResult = null;
  }

  console.log();
  console.log('━'.repeat(60));
  console.log('PATH 2: Worklet-Offline (new unified AudioWorklet path)');
  console.log('━'.repeat(60));
  let workletResult;
  try {
    workletResult = await renderWorkletOffline(genome, duration);
    console.log(`\n✅ Worklet-Offline: ${workletResult.totalMs.toFixed(0)}ms total (CPPN: ${workletResult.cppnMs.toFixed(0)}ms, Render: ${workletResult.renderMs.toFixed(0)}ms)`);
  } catch (e) {
    console.error(`❌ Worklet-Offline render failed:`, e);
    workletResult = null;
  }

  // ── Compare ───────────────────────────────────────────────────────
  if (batchResult && workletResult) {
    compareOutputs(
      batchResult.samples, workletResult.samples,
      'BATCH', 'WORKLET'
    );

    // Timing comparison
    console.log('\n' + '─'.repeat(60));
    console.log('TIMING COMPARISON');
    console.log('─'.repeat(60));
    console.log(`  Batch:          ${batchResult.totalMs.toFixed(0)}ms (${(duration / (batchResult.totalMs / 1000)).toFixed(1)}× real-time)`);
    console.log(`  Worklet-Offline: ${workletResult.totalMs.toFixed(0)}ms (${(duration / (workletResult.totalMs / 1000)).toFixed(1)}× real-time)`);
    const speedup = batchResult.totalMs / workletResult.totalMs;
    console.log(`  Ratio:          ${speedup > 1 ? `Batch ${speedup.toFixed(1)}× slower` : `Worklet ${(1 / speedup).toFixed(1)}× slower`}`);

    // Write WAV files for manual listening comparison
    const outDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
    writeWav(path.join(outDir, `test-batch-${id.slice(0, 8)}_${duration}s.wav`), batchResult.samples, SAMPLE_RATE);
    writeWav(path.join(outDir, `test-worklet-${id.slice(0, 8)}_${duration}s.wav`), workletResult.samples, SAMPLE_RATE);
  } else if (workletResult) {
    console.log('\n⚠️ Only worklet result available — cannot compare');
    const outDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..');
    writeWav(path.join(outDir, `test-worklet-${id.slice(0, 8)}_${duration}s.wav`), workletResult.samples, SAMPLE_RATE);
  }

  console.log('\n' + '═'.repeat(60));
  console.log('Done.');
  process.exit(0);
}

// Handle AudioWorklet cleanup error (expected)
process.on('uncaughtException', (error) => {
  if (error.message && error.message.includes('expect Object, got: Undefined')) {
    console.log('  ℹ️  AudioWorklet cleanup error caught (expected, continuing)');
  } else {
    console.error('❌ Uncaught exception:', error);
    process.exit(1);
  }
});

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
