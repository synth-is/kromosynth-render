/**
 * WorkletOfflineRenderer — Unified offline rendering matching BrowserLiveRenderer
 *
 * Both browser and server use the same AudioWorklet-based rendering path:
 *
 *   BROWSER (BrowserLiveRenderer, live AudioContext):
 *     CPPNOutputProcessor AudioWorklet generates CPPN samples in real-time
 *     → same DSP graph (streaming mode)
 *     → WavetableMixProcessor AudioWorklet for crossfade
 *     → DynamicsCompressor (threshold=-1dB, ratio=20:1) as safety limiter
 *     → masterGain(0.25) for safe playback volume
 *     → live AudioContext plays audio in real-time
 *
 *   SERVER (this file, OfflineAudioContext):
 *     Pre-compute ALL CPPN samples in one call (single full-duration, not chunked)
 *     → AudioBufferSourceNode delivers samples into the DSP graph (postMessage timing
 *        is unreliable in OfflineAudioContext, so direct buffer feed replaces
 *        CPPNOutputProcessor — functionally equivalent)
 *     → SAME DSP graph (streaming mode) — identical to browser
 *     → SAME WavetableMixProcessor AudioWorklet for crossfade
 *     → SAME DynamicsCompressor (threshold=-1dB, ratio=20:1)
 *     → OfflineAudioContext renders at full machine speed
 *     → Peak normalisation to fill WAV range [−1, 1]
 *
 * OUTPUT CHAIN PARITY:
 *   Both paths use the same DynamicsCompressor (threshold=-1dB, ratio=20:1) as a
 *   transparent safety limiter — only catches peaks near clipping.  Browser follows
 *   with gain(0.25) for speaker safety; WAV follows with peak normalisation to fill
 *   the full [-1,1] range.
 *
 * WHY single CPPN call (not chunked):
 *   Chunked calls to startMemberOutputsRendering produce different values for
 *   genomes with recurrent/stateful CPPN networks — each chunk resets internal
 *   state. A single full-duration call ensures identical CPPN values to the
 *   browser (which also computes a single continuous signal per play).
 *
 * WHY AudioBufferSourceNode instead of CPPNOutputProcessor:
 *   In node-web-audio-api, postMessage to an AudioWorklet is not guaranteed to
 *   be delivered before startRendering() processes the first frames. This caused
 *   the worklet to output zeros initially, which after peak-normalisation appeared
 *   as a "long fade-in". AudioBufferSourceNode loads data synchronously into the
 *   audio context, guaranteeing availability from frame 0.
 */

import NodeWebAudioAPI from '../../../kromosynth/node_modules/node-web-audio-api/index.mjs';
const { OfflineAudioContext } = NodeWebAudioAPI;
import { ensureBufferStartsAndEndsAtZero } from '../../../kromosynth/util/audio-buffer.js';

const KROMOSYNTH_PATH = '../../../kromosynth';

/**
 * Render a genome using the unified offline approach.
 *
 * @param {Object} genomeData — genome with .asNEATPatch and .waveNetwork
 * @param {number} duration — duration in seconds
 * @param {number} noteDelta — pitch offset
 * @param {number} velocity — velocity [0,1]
 * @param {number} sampleRate — sample rate (e.g. 48000)
 * @param {boolean} useGPU — whether to use GPU for CPPN computation
 * @param {Object} options — { onProgress }
 * @returns {Promise<{ samples: Float32Array, totalSamples: number, renderTimeMs: number }>}
 */
export async function renderWithWorkletOffline(
  genomeData, duration, noteDelta, velocity, sampleRate,
  useGPU = false,
  options = {}
) {
  const { onProgress } = options;
  const startTime = performance.now();

  console.log(`[WORKLET-OFFLINE] Starting: duration=${duration}s, sampleRate=${sampleRate}`);

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

  const totalSamples = Math.round(sampleRate * duration);

  // ── Step 1: Single full-duration CPPN call ───────────────────────
  // One call covering the entire duration ensures recurrent/stateful CPPN networks
  // produce the same values as the browser live path (which also runs continuously).
  // Chunked calls reset internal state between chunks, causing value divergence.
  console.log(`[WORKLET-OFFLINE] Computing CPPN: ${totalSamples} samples (${duration}s), ${synthIsPatch.networkOutputs?.length || 0} network outputs`);
  const cppnStartTime = performance.now();

  const result = await startMemberOutputsRendering(
    genomeData.waveNetwork, synthIsPatch,
    duration, noteDelta, sampleRate, velocity,
    false,  // reverse
    false,  // useOvertoneInharmonicityFactors
    useGPU,
    false,  // antiAliasing
    false,  // frequencyUpdatesApplyToAllPatchNetworkOutputs
    totalSamples,  // sampleCountToActivate — full duration in one call
    0              // sampleOffset — start from frame 0
  );
  const { memberOutputs, patch: modifiedPatch } = result;

  const cppnTotalMs = performance.now() - cppnStartTime;
  console.log(`[WORKLET-OFFLINE] CPPN computation: ${(cppnTotalMs / 1000).toFixed(2)}s`);

  if (onProgress) onProgress({ phase: 'cppn', chunk: 1, numChunks: 1, totalMs: cppnTotalMs });

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
  const offlineContext = new OfflineAudioContext({
    numberOfChannels: 1,
    length: totalSamples,
    sampleRate,
  });

  // ── Step 4: Build AudioBufferSourceNodes from CPPN data ──────────
  //
  // For each CPPN output channel, load samples into an AudioBuffer and connect:
  //   AudioBufferSourceNode → GainNode (wrapper, gain=1.0)
  //
  // The GainNode is the "wrapper node" consumed by connectLiveSignals — identical
  // interface to what BrowserLiveRenderer creates from CPPNOutputProcessor outputs.
  // source.start(0) guarantees data from the very first rendered sample.
  const sequentialWrapperNodes = new Map();
  const rawSamplesPerChannel = new Map(); // raw CPPN samples per seqIndex — needed for wavetable mix curves
  const sources = []; // collected for .start(0) after DSP graph is wired

  for (let ch = 0; ch < numberOfChannels; ch++) {
    const noiseType = channelNoiseType[ch];
    const moKey = channelToMOKey[ch];
    const allSamples = new Float32Array(totalSamples); // zero-initialised

    if (noiseType) {
      // White noise inline (same as BrowserLiveRenderer noise channels)
      for (let i = 0; i < totalSamples; i++) {
        allSamples[i] = Math.random() * 2 - 1;
      }
    } else {
      const output = memberOutputs.get(moKey);
      let samples;
      if (output?.samples?.length > 0) {
        samples = output.samples;
      } else if (output instanceof Float32Array && output.length > 0) {
        samples = output;
      }
      if (samples) {
        allSamples.set(samples.subarray(0, Math.min(totalSamples, samples.length)), 0);
      }
      // Missing output: zeros remain
    }

    rawSamplesPerChannel.set(ch, allSamples); // keep for wavetable mix gain curve computation

    const audioBuffer = offlineContext.createBuffer(1, totalSamples, sampleRate);
    audioBuffer.copyToChannel(allSamples, 0);

    const source = offlineContext.createBufferSource();
    source.buffer = audioBuffer;

    const wrapperGain = offlineContext.createGain();
    wrapperGain.gain.value = 1.0;
    source.connect(wrapperGain);

    sources.push(source);
    sequentialWrapperNodes.set(ch, wrapperGain);
  }

  console.log(`[WORKLET-OFFLINE] ${numberOfChannels} channels → ${numberOfChannels} AudioBufferSourceNodes`);

  // Collapsed mapping for Renderer.connectWrapperNodesToGraph
  const collapsedWrapperNodes = new Map();
  for (const [networkOutputIndex, seqIndex] of networkOutputToChannel.entries()) {
    const wrapperNode = sequentialWrapperNodes.get(seqIndex);
    if (wrapperNode) collapsedWrapperNodes.set(networkOutputIndex, wrapperNode);
  }

  // ── Step 5: Wire DSP graph in 'streaming' mode ───────────────────
  const renderer = new Renderer(sampleRate);

  // Prevent the Renderer's own connectWrapperNodesToGraph from running —
  // it collapses duplicate networkOutput values. We connect ourselves via
  // the 1:1 sequential mapping in connectLiveSignals below.
  renderer._wrapperNodesConnected = true;

  const virtualAudioGraph = await renderer.wireUpAudioGraphAndConnectToAudioContextDestination(
    memberOutputs,
    patchForRender,
    noteDelta,
    offlineContext,
    totalSamples,     // full duration — matches BrowserLiveRenderer full-render graph construction
    collapsedWrapperNodes,
    'streaming'       // mode — skips setValueCurveAtTime, uses wrapper node placeholders
  );

  // ── Step 6: Connect live signals (1:1 sequential mapping) ────────
  // Mirrors BrowserLiveRenderer._connectLiveSignals:
  //   - standard AudioParams: wrapperNode → audioNode.param (with range remapping)
  //   - buffer (wavetable): wrapperNode → audioWave{N} passthrough
  //   - mix (wavetable crossfade): collected into wavetableMixInfo — handled in step 6.5
  const wavetableMixInfo = await connectLiveSignals(
    patchForRender, sequentialWrapperNodes, virtualAudioGraph, offlineContext
  );

  // ── Step 6.5: Apply wavetable crossfade gain curves ──────────────
  // In BrowserLiveRenderer the mix signal drives WavetableMixProcessor (AudioWorklet),
  // which computes per-wave gains in real-time. In OfflineAudioContext, both AudioWorklet
  // nodes AND setValueCurveAtTime have startup issues (gain=0 for the first several render
  // quanta). Instead, we deliver the pre-computed gain values as audio-rate signals via
  // AudioBufferSourceNode — the same approach used for CPPN data, guaranteed from frame 0.
  const gainSources = applyWavetableMixCurves(
    wavetableMixInfo, rawSamplesPerChannel, virtualAudioGraph, offlineContext, totalSamples, duration
  );

  // ── Step 6.7: Insert compressor for parity with browser preview ────
  // BrowserLiveRenderer uses a DynamicsCompressor as a brickwall limiter to
  // prevent clipping during real-time playback.  Without it, some genomes
  // produce signals far above 0dB.  We apply the same compressor here so
  // the WAV output has comparable dynamics and loudness to the browser.
  // After rendering, peak normalisation fills the WAV range [-1, 1].
  const compressor = offlineContext.createDynamicsCompressor();
  compressor.threshold.value = -1;   // only catch peaks near clipping
  compressor.knee.value = 0;         // hard knee — transparent below threshold
  compressor.ratio.value = 20;       // brickwall above threshold
  compressor.attack.value = 0.001;   // fast attack to catch transients
  compressor.release.value = 0.01;   // fast release to avoid pumping/fade-out

  compressor.connect(offlineContext.destination);

  // Reconnect DSP graph outputs: destination → compressor
  for (const key in virtualAudioGraph.virtualNodes) {
    const vnode = virtualAudioGraph.virtualNodes[key];
    if (!vnode) continue;
    const output = vnode.output;
    if (output === 'output' || (Array.isArray(output) && output.includes('output'))) {
      if (vnode.audioNode) {
        try {
          vnode.audioNode.disconnect(offlineContext.destination);
          vnode.audioNode.connect(compressor);
        } catch {}
      }
      if (vnode.virtualNodes) {
        for (const childKey in vnode.virtualNodes) {
          const child = vnode.virtualNodes[childKey];
          const childOutput = child?.output;
          if (childOutput === 'output' || (Array.isArray(childOutput) && childOutput.includes('output'))) {
            if (child.audioNode) {
              try {
                child.audioNode.disconnect(offlineContext.destination);
                child.audioNode.connect(compressor);
              } catch {}
            }
          }
        }
      }
    }
  }

  console.log(`[WORKLET-OFFLINE] Compressor inserted: threshold=-1dB, ratio=20:1, knee=0 (transparent safety limiter)`);

  // ── Step 7: Start all AudioBufferSourceNodes at time 0 ───────────
  // Must be done AFTER DSP graph is wired and BEFORE startRendering().
  // Includes both CPPN sources and wavetable gain sources.
  for (const source of sources) {
    source.start(0);
  }
  for (const gainSrc of gainSources) {
    gainSrc.start(0);
  }

  // ── Step 8: Render offline ───────────────────────────────────────
  const renderStart = performance.now();
  const rawBuffer = await offlineContext.startRendering();
  const renderMs = performance.now() - renderStart;
  console.log(`[WORKLET-OFFLINE] Offline render: ${(renderMs / 1000).toFixed(2)}s for ${duration}s audio (${(duration / (renderMs / 1000)).toFixed(1)}x realtime)`);

  // ── Step 9: Extract and normalise audio ─────────────────────────
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
  if (totalNaN > 0) console.warn(`[WORKLET-OFFLINE] ${totalNaN} NaN samples in raw buffer`);
  if (totalNonZero === 0) console.warn(`[WORKLET-OFFLINE] Raw buffer is silent (0 non-zero samples)`);

  // Peak-normalise
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


// ─── Helper: Connect live signals ────────────────────────────────────────────
/**
 * Port of BrowserLiveRenderer._connectLiveSignals for the offline context.
 *
 * Connects wrapper GainNodes (backed by AudioBufferSourceNodes) to the DSP graph
 * audio parameters — matching the browser live path.
 *
 * Handles:
 *   - Standard AudioParam connections (gain, frequency, Q, etc.) with range remapping
 *   - Buffer connections (wavetable audio waves + standard passthrough gains)
 *   - Partial buffer connections (additive synthesis)
 *   - Gain envelope connections (additive partials)
 *   - Mix connections (wavetable crossfade) — info collected and returned; actual gain
 *     curves are applied by applyWavetableMixCurves() via setValueCurveAtTime
 *   - Curve connections (skipped — static property)
 *
 * @returns {Map} wavetableMixInfo — keyed by audioGraphNodeKey, values: { seqIndex, numWaves, range }
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

  // Collect mix info per wavetable node (for applyWavetableMixCurves after this loop).
  const wavetableMixInfo = new Map();

  // Count audio waves per wavetable node upfront (needed to size the gain curve arrays).
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
            } else {
              wrapperNode.connect(targetNode);
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
              }
            }
            return;
          }

          // ── Mix wave (wavetable crossfade control) ─────────────────
          // Collect info for applyWavetableMixCurves (called after this function).
          // The gain curves are pre-computed from raw CPPN samples and applied via
          // setValueCurveAtTime — avoids AudioWorklet startup latency in OfflineAudioContext.
          if (paramName === 'mix') {
            if (isCustomNode) {
              const numWaves = wavetableAudioWaveCounts.get(audioGraphNodeKey) || 0;
              if (numWaves > 0) {
                wavetableMixInfo.set(audioGraphNodeKey, {
                  seqIndex,
                  numWaves,
                  range: connection.range || null
                });
              }
            }
            return;
          }

          // ── Curve (skip — static property set during graph construction) ──
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
            } else {
              audioNode[paramName].value = 0;
              wrapperNode.connect(audioNode[paramName]);
              connectionsCount++;
            }
          }
        } catch (connErr) {
          console.warn(`[WORKLET-OFFLINE] connection error [${seqIndex}] ${connection.paramName} → ${audioGraphNodeKey}:`, connErr.message);
        }
      });
    }
  });

  console.log(`[WORKLET-OFFLINE] connected: ${connectionsCount} total (mix curves applied separately)`);
  return wavetableMixInfo;
}


// ─── Helper: Apply wavetable crossfade gain curves ────────────────────────────
/**
 * Pre-compute per-wave gain arrays from raw CPPN mix-signal samples and deliver
 * them as audio-rate data via AudioBufferSourceNodes connected to each wavetable
 * node's gainValueCurve{w}.gain AudioParam.
 *
 * WHY AudioBufferSourceNode instead of setValueCurveAtTime or AudioWorkletNode:
 *   Both scheduling APIs (setValueCurveAtTime) and AudioWorkletNode have startup
 *   issues in OfflineAudioContext — the gain is 0 for the first several render
 *   quanta (≈841 samples), producing a leading-silence artefact after normalization.
 *   AudioBufferSourceNode delivers data synchronously from frame 0, guaranteeing
 *   correct gain values for every sample.
 *
 * Math is identical to WavetableMixProcessor: triangular band-splitting over [-1,1].
 *
 * @returns {AudioBufferSourceNode[]} gainSources — must be .start(0)'d before startRendering()
 */
function applyWavetableMixCurves(wavetableMixInfo, rawSamplesPerChannel, virtualAudioGraph, audioContext, totalSamples, duration) {
  const gainSources = [];

  for (const [nodeKey, info] of wavetableMixInfo.entries()) {
    const { seqIndex, numWaves, range } = info;
    const rawSamples = rawSamplesPerChannel.get(seqIndex);
    if (!rawSamples) {
      console.warn(`[WORKLET-OFFLINE] mix-xfade: no raw samples for seqIndex ${seqIndex} (${nodeKey})`);
      continue;
    }

    const virtualNode = virtualAudioGraph.virtualNodes[nodeKey];
    if (!virtualNode?.virtualNodes) continue;

    // Band-splitting spans — identical to WavetableMixProcessor._computeSpans()
    const fraction = 2 / numWaves;
    const halfFraction = fraction / 2;
    const spans = [];
    for (let i = 0; i < numWaves; i++) {
      const start = i * fraction - 1;
      spans.push({
        start:  start - (i ? halfFraction : 0),
        middle: start + halfFraction,
        end:    start + fraction + ((i + 1) < numWaves ? halfFraction : 0)
      });
    }

    // Range remapping factors (connection.range maps CPPN [-1,1] → [min,max])
    let rangeScale = 1.0, rangeOffset = 0.0;
    if (range) {
      const [min, max] = range;
      rangeScale = (max - min) / 2;
      rangeOffset = (min + max) / 2;
    }

    // Pre-compute per-wave gain arrays (same per-sample math as WavetableMixProcessor.process)
    const gainCurves = Array.from({ length: numWaves }, () => new Float32Array(rawSamples.length));
    for (let i = 0; i < rawSamples.length; i++) {
      const sample = rawSamples[i] * rangeScale + rangeOffset;
      for (let w = 0; w < numWaves; w++) {
        const span = spans[w];
        gainCurves[w][i] = (sample > span.start && sample < span.end)
          ? Math.max(0, 1 - Math.abs(span.middle - sample) / fraction)
          : 0;
      }
    }

    // Deliver each gain curve via AudioBufferSourceNode → gainValueCurve{w}.gain
    // AudioBufferSourceNode guarantees data from frame 0 (no scheduling startup latency).
    for (let w = 0; w < numWaves; w++) {
      const childKey = `gainValueCurve${w + 1}`;
      const child = virtualNode.virtualNodes[childKey];
      if (child?.audioNode?.gain) {
        // Zero the intrinsic gain value — the AudioBufferSource provides the full gain.
        // AudioParam audio-rate input is ADDED to the intrinsic value, so value=0 is correct.
        child.audioNode.gain.cancelScheduledValues(0);
        child.audioNode.gain.value = 0;

        const gainBuffer = audioContext.createBuffer(1, rawSamples.length, audioContext.sampleRate);
        gainBuffer.copyToChannel(gainCurves[w], 0);

        const gainSource = audioContext.createBufferSource();
        gainSource.buffer = gainBuffer;
        gainSource.connect(child.audioNode.gain);
        gainSources.push(gainSource);
      }
    }

    console.log(`[WORKLET-OFFLINE] mix-xfade [${seqIndex}]: AudioBufferSrc(${numWaves}ch) → ${nodeKey}`);
  }

  return gainSources;
}
