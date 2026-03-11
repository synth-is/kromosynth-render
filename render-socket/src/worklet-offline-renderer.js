/**
 * WorkletOfflineRenderer — Unified offline rendering via AudioWorklet signal feeding
 *
 * Brings the BrowserLiveRenderer's AudioWorklet-based signal feeding approach
 * to offline/batch rendering. Instead of using setValueCurveAtTime (which
 * schedules curves before rendering), CPPN outputs flow sample-by-sample
 * through an AudioWorklet into the DSP graph — exactly as in the browser
 * live path.
 *
 * WHY: The setValueCurveAtTime batch path fails for some genomes with delay
 * units because delay lines/feedback see the full pre-scheduled curve atomically.
 * The worklet approach feeds signals continuously, so delays fill naturally
 * just as they do during live playback.
 *
 * APPROACH:
 *   1. Pre-compute ALL CPPN chunks (sampleCountToActivate/sampleOffset)
 *   2. Create OfflineAudioContext with AudioWorklet (node-web-audio-api supports this)
 *   3. Register CPPNOutputProcessor worklet on the offline context
 *   4. Feed all chunks to the worklet before calling startRendering()
 *   5. Wire DSP graph in 'streaming' mode (uses wrapper GainNodes, no setValueCurveAtTime)
 *   6. offlineContext.startRendering() → deterministic output with correct delay behavior
 *   7. Sum channels, peak-normalise → Float32Array
 *
 * The result should be IDENTICAL to the browser live path, but rendered offline
 * at faster-than-realtime speed, supporting arbitrarily long durations.
 */

import NodeWebAudioAPI from '../../../kromosynth/node_modules/node-web-audio-api/index.mjs';
const { OfflineAudioContext, AudioWorkletNode } = NodeWebAudioAPI;
import { ensureBufferStartsAndEndsAtZero } from '../../../kromosynth/util/audio-buffer.js';

const KROMOSYNTH_PATH = '../../../kromosynth';

// ─── AudioWorklet processor source ────────────────────────────────────
// Same processor as BrowserLiveRenderer's CPPNOutputProcessor, adapted
// for offline use: no gating needed since all chunks are loaded before
// startRendering().
const CPPN_OUTPUT_PROCESSOR_CODE = `
class CPPNOutputProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const config = options.processorOptions || {};
    this.numberOfChannels = config.numberOfOutputs || 18;
    this.outputLayout = config.outputLayout || [this.numberOfChannels];
    this.samplesPerChunk = config.samplesPerChunk || 48000;
    this.totalDuration = config.duration || 4;
    this.sampleRate = config.sampleRate || 48000;
    this.totalSamples = Math.round(this.totalDuration * this.sampleRate);
    this.cppnChunks = new Map();
    this.currentChunkIndex = 0;
    this.currentSampleInChunk = 0;
    this.totalSamplesProcessed = 0;
    // No gating in offline mode — all chunks loaded before startRendering()
    this.isGated = false;
    this.port.onmessage = (event) => this.handleMessage(event.data);
    this.port.postMessage({ type: 'ready' });
  }

  handleMessage(message) {
    if (message.type === 'cppn-chunk') {
      this.cppnChunks.set(message.chunkIndex, message.outputs);
      this.port.postMessage({
        type: 'chunk-received', chunkIndex: message.chunkIndex,
        bufferedChunks: this.cppnChunks.size
      });
    } else if (message.type === 'start') {
      this.isGated = false;
    } else if (message.type === 'stop') {
      this.totalSamplesProcessed = this.totalSamples;
    }
  }

  process(inputs, outputs, parameters) {
    const blockSize = outputs[0]?.[0]?.length || 128;

    if (this.isGated) {
      for (let outIdx = 0; outIdx < outputs.length; outIdx++)
        for (let ch = 0; ch < outputs[outIdx].length; ch++)
          outputs[outIdx][ch].fill(0);
      return true;
    }

    for (let i = 0; i < blockSize; i++) {
      if (this.totalSamplesProcessed >= this.totalSamples) {
        for (let outIdx = 0; outIdx < outputs.length; outIdx++)
          for (let ch = 0; ch < outputs[outIdx].length; ch++)
            outputs[outIdx][ch].fill(0, i);
        return false;
      }

      const chunk = this.cppnChunks.get(this.currentChunkIndex);
      if (!chunk) {
        // Should not happen if all chunks pre-loaded, but handle gracefully
        for (let outIdx = 0; outIdx < outputs.length; outIdx++)
          for (let ch = 0; ch < outputs[outIdx].length; ch++)
            outputs[outIdx][ch][i] = 0;
      } else {
        let globalCh = 0;
        for (let outIdx = 0; outIdx < outputs.length; outIdx++) {
          for (let ch = 0; ch < outputs[outIdx].length; ch++) {
            const samples = chunk[globalCh];
            outputs[outIdx][ch][i] = samples ? samples[this.currentSampleInChunk] : 0;
            globalCh++;
          }
        }
      }

      this.totalSamplesProcessed++;
      this.currentSampleInChunk++;

      if (this.currentSampleInChunk >= this.samplesPerChunk) {
        const old = this.currentChunkIndex - 1;
        if (old >= 0) this.cppnChunks.delete(old);
        this.currentChunkIndex++;
        this.currentSampleInChunk = 0;
      }
    }
    return true;
  }
}
registerProcessor('cppn-output-processor', CPPNOutputProcessor);
`;

/**
 * Render a genome using the unified worklet-offline approach.
 *
 * @param {Object} genomeData — genome with .asNEATPatch and .waveNetwork
 * @param {number} duration — duration in seconds
 * @param {number} noteDelta — pitch offset
 * @param {number} velocity — velocity [0,1]
 * @param {number} sampleRate — sample rate (e.g. 48000)
 * @param {boolean} useGPU — whether to use GPU for CPPN computation
 * @param {Object} options — { chunkDuration, onProgress }
 * @returns {Promise<{ samples: Float32Array, totalSamples: number, renderTimeMs: number }>}
 */
export async function renderWithWorkletOffline(
  genomeData, duration, noteDelta, velocity, sampleRate,
  useGPU = false,
  options = {}
) {
  const { chunkDuration = 1.0, onProgress } = options;
  const startTime = performance.now();

  console.log(`[WORKLET-OFFLINE] Starting: duration=${duration}s, chunkDuration=${chunkDuration}s, sampleRate=${sampleRate}`);

  // ── Dynamic imports ──────────────────────────────────────────────
  const [
    { startMemberOutputsRendering },
    { patchFromAsNEATnetwork },
    { getMemberOutputsKey },
    { default: Renderer },
  ] = await Promise.all([
    import(`${KROMOSYNTH_PATH}/util/render.js`),
    import(`${KROMOSYNTH_PATH}/util/audio-graph-asNEAT-bridge.js`),
    import(`${KROMOSYNTH_PATH}/util/network-output.js`),
    import(`${KROMOSYNTH_PATH}/cppn-neat/network-rendering.js`),
  ]);

  // ── Parse patch ──────────────────────────────────────────────────
  const asNEATNetworkJSONString = typeof genomeData.asNEATPatch === 'string'
    ? genomeData.asNEATPatch
    : genomeData.asNEATPatch.toJSON
      ? genomeData.asNEATPatch.toJSON()
      : JSON.stringify(genomeData.asNEATPatch);
  const synthIsPatch = patchFromAsNEATnetwork(asNEATNetworkJSONString);
  synthIsPatch.duration = duration;

  const samplesPerChunk = Math.round(sampleRate * chunkDuration);
  const totalSamples = Math.round(sampleRate * duration);
  const numChunks = Math.ceil(totalSamples / samplesPerChunk);

  console.log(`[WORKLET-OFFLINE] ${numChunks} chunks × ${chunkDuration}s, ${synthIsPatch.networkOutputs?.length || 0} network outputs`);
  const cppnChunkStartTime = performance.now();

  const allChunks = []; // { memberOutputs, sampleCount, sampleOffset }

  let modifiedPatch = null;
  for (let i = 0; i < numChunks; i++) {
    const offset = i * samplesPerChunk;
    const count = Math.min(samplesPerChunk, totalSamples - offset);

    const tChunk = performance.now();
    const result = await startMemberOutputsRendering(
      genomeData.waveNetwork, synthIsPatch,
      duration, noteDelta, sampleRate, velocity,
      false,  // reverse
      false,  // useOvertoneInharmonicityFactors
      useGPU,
      false,  // antiAliasing
      false,  // frequencyUpdatesApplyToAllPathcNetworkOutputs
      count,  // sampleCountToActivate
      offset  // sampleOffset
    );
    const chunkMs = performance.now() - tChunk;

    allChunks.push({
      memberOutputs: result.memberOutputs,
      sampleCount: count,
      sampleOffset: offset,
    });

    if (!modifiedPatch) modifiedPatch = result.patch;

    if (onProgress) {
      onProgress({
        phase: 'cppn',
        chunk: i + 1,
        numChunks,
        chunkMs,
        totalMs: performance.now() - cppnChunkStartTime,
      });
    }

    if (i % 10 === 0 || i === numChunks - 1) {
      console.log(`   chunk ${i + 1}/${numChunks} (${chunkMs.toFixed(0)}ms)`);
    }
  }

  const cppnTotalMs = performance.now() - cppnChunkStartTime;
  console.log(`[WORKLET-OFFLINE] CPPN pre-computation: ${(cppnTotalMs / 1000).toFixed(2)}s`);

  const patchForRender = modifiedPatch || synthIsPatch;
  patchForRender.duration = duration;

  // ── Step 2: Build sequential output index mapping ────────────────
  const channelToMOKey = [];
  const channelNoiseType = [];
  const networkOutputToChannel = new Map();

  patchForRender.networkOutputs.forEach((output, seqIndex) => {
    const moKey = getMemberOutputsKey({
      index: output.networkOutput,
      frequency: output.frequency,
    });
    channelToMOKey.push(moKey);
    const isNoise = typeof output.networkOutput === 'string' &&
      output.networkOutput.startsWith('noise');
    channelNoiseType.push(isNoise ? output.networkOutput : null);
    networkOutputToChannel.set(output.networkOutput, seqIndex);
  });

  const numberOfChannels = channelToMOKey.length;

  // ── Step 3: Create OfflineAudioContext ────────────────────────────
  // Use 1 channel (mono) — the worklet + DSP graph mix internally.
  const offlineContext = new OfflineAudioContext({
    numberOfChannels: 1,
    length: totalSamples,
    sampleRate,
  });

  // ── Step 4: Load AudioWorklet on OfflineAudioContext ──────────────
  // node-web-audio-api supports Blob URLs
  const blob = new Blob([CPPN_OUTPUT_PROCESSOR_CODE], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  await offlineContext.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);

  // ── Step 5: Create CPPN output AudioWorkletNode ──────────────────
  const MAX_CH = 32;
  const numOutputs = Math.ceil(numberOfChannels / MAX_CH);
  const outputLayout = [];
  const outputChannelCount = [];
  for (let o = 0; o < numOutputs; o++) {
    const chans = Math.min(MAX_CH, numberOfChannels - o * MAX_CH);
    outputLayout.push(chans);
    outputChannelCount.push(chans);
  }

  console.log(`[WORKLET-OFFLINE] ${numberOfChannels} channels → ${numOutputs} worklet output(s)`);

  const cppnOutputNode = new AudioWorkletNode(offlineContext, 'cppn-output-processor', {
    numberOfInputs: 0,
    numberOfOutputs: numOutputs,
    outputChannelCount,
    processorOptions: {
      numberOfOutputs: numberOfChannels,
      outputLayout,
      samplesPerChunk,
      duration,
      sampleRate,
    },
  });

  // Expected at end of offline render — processor returns false to signal completion
  cppnOutputNode.onprocessorerror = () => {};

  // ── Step 6: Create per-channel wrapper GainNodes ─────────────────
  const sequentialWrapperNodes = new Map();
  let globalCh = 0;
  for (let o = 0; o < numOutputs; o++) {
    const chans = outputLayout[o];
    const splitter = offlineContext.createChannelSplitter(chans);
    cppnOutputNode.connect(splitter, o);
    for (let ch = 0; ch < chans; ch++) {
      const gain = offlineContext.createGain();
      gain.gain.value = 1.0;
      splitter.connect(gain, ch, 0);
      sequentialWrapperNodes.set(globalCh, gain);
      globalCh++;
    }
  }

  // Collapsed mapping for Renderer.connectWrapperNodesToGraph
  const collapsedWrapperNodes = new Map();
  for (const [networkOutputIndex, seqIndex] of networkOutputToChannel.entries()) {
    const wrapperNode = sequentialWrapperNodes.get(seqIndex);
    if (wrapperNode) collapsedWrapperNodes.set(networkOutputIndex, wrapperNode);
  }

  // ── Step 7: Wire DSP graph in 'streaming' mode ───────────────────
  const renderer = new Renderer(sampleRate);

  // Prevent the Renderer's own connectWrapperNodesToGraph from running —
  // it collapses duplicate networkOutput values. We connect ourselves below.
  renderer._wrapperNodesConnected = true;

  const chunk0Outputs = allChunks[0].memberOutputs;

  const virtualAudioGraph = await renderer.wireUpAudioGraphAndConnectToAudioContextDestination(
    chunk0Outputs,
    patchForRender,
    noteDelta,
    offlineContext,
    samplesPerChunk,  // chunk-sized, NOT full duration — matches BrowserLiveRenderer
    collapsedWrapperNodes,
    'streaming'       // mode — skips setValueCurveAtTime, uses wrapper node placeholders
  );

  // ── Step 7b: Connect live signals (1:1 sequential mapping) ───────
  // This replicates BrowserLiveRenderer._connectLiveSignals, adapted for
  // the server environment.
  await connectLiveSignals(
    patchForRender, sequentialWrapperNodes, virtualAudioGraph, offlineContext, Renderer
  );

  // ── Step 8: Feed ALL CPPN chunks to worklet ──────────────────────
  for (let chunkIdx = 0; chunkIdx < allChunks.length; chunkIdx++) {
    const { memberOutputs } = allChunks[chunkIdx];
    sendChunkToWorklet(cppnOutputNode, memberOutputs, channelToMOKey, channelNoiseType, chunkIdx, sampleRate, samplesPerChunk);
  }

  // Un-gate (already ungated by default, but be explicit)
  cppnOutputNode.port.postMessage({ type: 'start' });

  // Listen for worklet underruns (shouldn't happen with pre-loaded chunks)
  cppnOutputNode.port.onmessage = (event) => {
    if (event.data.type === 'underrun') console.warn(`[WORKLET-OFFLINE] underrun at chunk ${event.data.chunkIndex}`);
  };

  // ── Step 9: Render offline ───────────────────────────────────────
  const renderStart = performance.now();

  let rawBuffer;
  try {
    rawBuffer = await offlineContext.startRendering();
  } catch (error) {
    // Handle the known AudioWorklet cleanup error
    if (error.message && error.message.includes('expect Object, got: Undefined')) {
      console.log('  ℹ️  AudioWorklet cleanup error (expected, continuing)');
      // The render actually completed — rawBuffer should still be available
      // but startRendering() threw. We need a workaround.
      throw new Error(
        'startRendering() threw AudioWorklet cleanup error. ' +
        'The render may have completed but the buffer was lost. ' +
        'This is a known node-web-audio-api issue.'
      );
    }
    throw error;
  }

  const renderMs = performance.now() - renderStart;
  console.log(`[WORKLET-OFFLINE] Offline render: ${(renderMs / 1000).toFixed(2)}s for ${duration}s audio (${(duration / (renderMs / 1000)).toFixed(1)}x realtime)`);

  // ── Step 10: Extract and normalise audio ─────────────────────────
  const chCount = rawBuffer.numberOfChannels;
  const outputLength = rawBuffer.length;
  const summed = new Float32Array(outputLength);

  let totalNonZero = 0, totalNaN = 0;
  for (let ch = 0; ch < chCount; ch++) {
    const chData = rawBuffer.getChannelData(ch);
    for (let i = 0; i < outputLength; i++) {
      summed[i] += chData[i];
      if (isNaN(chData[i])) totalNaN++;
      else if (Math.abs(chData[i]) > 1e-8) totalNonZero++;
    }
  }
  if (totalNaN > 0) console.warn(`[WORKLET-OFFLINE] ${totalNaN} NaN samples detected in raw buffer`);
  if (totalNonZero === 0) console.warn(`[WORKLET-OFFLINE] Raw buffer is silent (0 non-zero samples)`);

  // Peak-normalise (handle NaN and silence gracefully)
  let peak = 0;
  for (let i = 0; i < summed.length; i++) {
    if (!isNaN(summed[i])) {
      const abs = Math.abs(summed[i]);
      if (abs > peak) peak = abs;
    }
  }
  if (peak > 0) {
    for (let i = 0; i < summed.length; i++) {
      summed[i] = isNaN(summed[i]) ? 0 : summed[i] / peak;
    }
  } else {
    // All zeros or NaN — just zero out NaN values
    for (let i = 0; i < summed.length; i++) {
      if (isNaN(summed[i])) summed[i] = 0;
    }
  }

  // Ensure audio starts and ends at zero to avoid clicks
  ensureBufferStartsAndEndsAtZero(summed);

  const totalRenderMs = performance.now() - startTime;
  console.log(`[WORKLET-OFFLINE] Complete: ${(totalRenderMs / 1000).toFixed(2)}s total (CPPN: ${(cppnTotalMs / 1000).toFixed(2)}s, render: ${(renderMs / 1000).toFixed(2)}s)`);

  return {
    samples: summed,
    totalSamples: outputLength,
    renderTimeMs: totalRenderMs,
    cppnTimeMs: cppnTotalMs,
    offlineRenderTimeMs: renderMs,
  };
}


// ─── Helper: Send a CPPN chunk to the AudioWorklet ─────────────────────
function sendChunkToWorklet(cppnOutputNode, memberOutputs, channelToMOKey, channelNoiseType, chunkIdx, sampleRate, samplesPerChunk) {
  // Build the outputs array indexed by sequential channel order.
  //
  // memberOutputs is a Map where each value is an object with a `.samples`
  // property (Float32Array), NOT a raw Float32Array. This matches the format
  // returned by startMemberOutputsRendering → network-activation.js.
  const outputs = {};

  // First: determine expected length from any valid output
  let expectedLength = samplesPerChunk;
  for (let ch = 0; ch < channelToMOKey.length; ch++) {
    if (channelNoiseType[ch]) continue;
    const output = memberOutputs.get(channelToMOKey[ch]);
    if (output?.samples?.length > 0) { expectedLength = output.samples.length; break; }
    // Also handle raw Float32Array (some code paths may return this directly)
    if (output instanceof Float32Array && output.length > 0) { expectedLength = output.length; break; }
  }

  for (let ch = 0; ch < channelToMOKey.length; ch++) {
    const noiseType = channelNoiseType[ch];
    if (noiseType) {
      // Generate noise directly (same approach as BrowserLiveRenderer)
      const noiseBuf = new Float32Array(expectedLength);
      for (let i = 0; i < expectedLength; i++) {
        noiseBuf[i] = Math.random() * 2 - 1; // white noise
      }
      outputs[ch] = noiseBuf;
    } else {
      const moKey = channelToMOKey[ch];
      const output = memberOutputs.get(moKey);
      let samples;
      if (output?.samples?.length > 0) {
        // Standard format: { samples: Float32Array, ... }
        samples = new Float32Array(output.samples);
      } else if (output instanceof Float32Array && output.length > 0) {
        // Raw Float32Array (some code paths)
        samples = new Float32Array(output);
      } else {
        // Missing output — fill with zeros
        samples = new Float32Array(expectedLength);
      }
      outputs[ch] = samples;
    }
  }

  cppnOutputNode.port.postMessage({
    type: 'cppn-chunk',
    chunkIndex: chunkIdx,
    outputs,
  });
}


// ─── Helper: Connect live signals (ported from BrowserLiveRenderer) ─────
/**
 * Connect wrapper GainNodes to the DSP graph's audio parameters.
 * This replaces the setValueCurveAtTime scheduling with live signal connections.
 *
 * FULL PORT of BrowserLiveRenderer._connectLiveSignals, handling:
 *   - Standard AudioParam connections (gain, frequency, Q, etc.) with range remapping
 *   - Buffer connections (wavetable audio waves + standard passthrough gains)
 *   - Partial buffer connections (additive synthesis)
 *   - Gain envelope connections (additive partials)
 *   - Mix connections (wavetable crossfade) — simplified without WavetableMixProcessor
 *   - Curve connections (skipped — static property)
 */
async function connectLiveSignals(patch, sequentialWrapperNodes, virtualAudioGraph, audioContext) {
  let connectionsCount = 0;
  const extraNodes = [];

  // Track buffer connection index per custom node key.
  const bufferIndexPerNode = new Map();

  // Track which standard nodes' last buffer connection (batch mode: only last wins).
  const lastStdBufferSeqIndex = new Map();
  patch.networkOutputs.forEach((oneOutput, seqIndex) => {
    for (const audioGraphNodeKey in oneOutput.audioGraphNodes) {
      const conns = oneOutput.audioGraphNodes[audioGraphNodeKey];
      conns.forEach((c) => {
        if (c.paramName === 'buffer') {
          const vn = virtualAudioGraph.virtualNodes[audioGraphNodeKey];
          if (vn && !vn.virtualNodes) {
            lastStdBufferSeqIndex.set(audioGraphNodeKey, seqIndex);
          }
        }
      });
    }
  });

  // Count audio waves per wavetable node upfront
  const wavetableAudioWaveCounts = new Map();
  patch.networkOutputs.forEach((oneOutput) => {
    for (const audioGraphNodeKey in oneOutput.audioGraphNodes) {
      const connections = oneOutput.audioGraphNodes[audioGraphNodeKey];
      connections.forEach((connection) => {
        if (connection.paramName === 'buffer') {
          const vnode = virtualAudioGraph.virtualNodes[audioGraphNodeKey];
          if (vnode?.virtualNodes) {
            wavetableAudioWaveCounts.set(
              audioGraphNodeKey,
              (wavetableAudioWaveCounts.get(audioGraphNodeKey) || 0) + 1
            );
          }
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

          // Helper: connect wrapper to target with optional range remapping
          const connectWithRange = (targetNode, label) => {
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
              // Range-remapped: scale(half)+offset(mid) → audioGraphNodeKey
            } else {
              wrapperNode.connect(targetNode);
              // Direct connection → audioGraphNodeKey
            }
            connectionsCount++;
          };

          // ── Buffer connections (wavetable audio waves + standard) ───
          if (paramName === 'buffer') {
            if (isCustomNode) {
              const idx = (bufferIndexPerNode.get(audioGraphNodeKey) || 0) + 1;
              bufferIndexPerNode.set(audioGraphNodeKey, idx);
              const childKey = `audioWave${idx}`;
              const child = virtualNode.virtualNodes[childKey];
              if (child?.audioNode) {
                connectWithRange(child.audioNode, `wt-buf.${childKey}`);
              }
            } else if (audioNode) {
              // Standard node — only connect the LAST buffer (batch parity)
              if (audioNode.constructor?.name === 'GainNode') {
                const lastIdx = lastStdBufferSeqIndex.get(audioGraphNodeKey);
                if (lastIdx === seqIndex) {
                  connectWithRange(audioNode, 'buf-signal');
                }
              }
            }
            return;
          }

          // ── Partial buffer connections (additive synthesis) ─────────
          if (paramName === 'partialBuffer') {
            if (isCustomNode) {
              const childKey = `audioWave${connection.partialNumber || 1}`;
              const child = virtualNode.virtualNodes[childKey];
              if (child?.audioNode) {
                connectWithRange(child.audioNode, `partial-buf.${childKey}`);
              }
            }
            return;
          }

          // ── Gain envelope connections (additive partials) ──────────
          if (paramName === 'partialGainEnvelope') {
            if (isCustomNode) {
              const childKey = `gainValueCurve${connection.partialNumber || 1}`;
              const child = virtualNode.virtualNodes[childKey];
              if (child?.audioNode?.gain) {
                const range = connection.range || [0, 1];
                const mid = (range[0] + range[1]) / 2;
                const half = (range[1] - range[0]) / 2;
                child.audioNode.gain.value = mid;
                const scaleNode = audioContext.createGain();
                scaleNode.gain.value = half;
                wrapperNode.connect(scaleNode);
                scaleNode.connect(child.audioNode.gain);
                extraNodes.push(scaleNode);
                connectionsCount++;
                // Gain envelope: scale(half) → audioGraphNodeKey.childKey.gain (base=mid)
              }
            }
            return;
          }

          // ── Mix wave (wavetable crossfade control) ─────────────────
          // In the browser, this uses a WavetableMixProcessor AudioWorklet.
          // For the offline prototype, we skip the crossfade worklet and
          // connect the mix signal directly to the first gain — this is a
          // simplification that will need refinement for wavetable genomes.
          if (paramName === 'mix') {
            // TODO: Port WavetableMixProcessor to offline context for full wavetable crossfade
            return;
          }

          // ── Curve (skip — static property set during graph construction)
          if (paramName === 'curve') return;

          // ── Standard AudioParam (gain, frequency, Q, etc.) ────────
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
              // Param: scale(half) → audioGraphNodeKey.paramName (base=mid)
            } else {
              audioNode[paramName].value = 0;
              wrapperNode.connect(audioNode[paramName]);
              connectionsCount++;
              // Param: raw → audioGraphNodeKey.paramName
            }
          }
        } catch (connErr) {
          console.warn(`[WORKLET-OFFLINE] connection error [${seqIndex}] ${connection.paramName} → ${audioGraphNodeKey}:`, connErr.message);
        }
      });
    }
  });

  console.log(`[WORKLET-OFFLINE] connected: ${connectionsCount} total`);
  return extraNodes;
}
