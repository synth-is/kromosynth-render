import NodeWebAudioAPI from 'node-web-audio-api';
const { AudioContext, OfflineAudioContext } = NodeWebAudioAPI;
import { getAudioBufferFromGenomeAndMeta } from 'kromosynth';

// TODO: copied from kromosynth-cli - possibly move to a common package?

let audioCtx;
export const SAMPLE_RATE = 48000;

export function getAudioContext() {
	if( ! audioCtx ) audioCtx = new AudioContext({sampleRate: SAMPLE_RATE});
	
	// https://github.com/ircam-ismm/node-web-audio-api/issues/23#issuecomment-1636134712
	// audioCtx.destination.channelCount = 2;
	// audioCtx.destination.channelInterpretation = 'discrete';
	// await audioCtx.resume();
// console.log('audioCtx', audioCtx);
	return audioCtx;
}

export function getNewOfflineAudioContext( duration ) {
	const offlineAudioContext = new OfflineAudioContext({
		numberOfChannels: 2,
		length: Math.round(SAMPLE_RATE * duration),
		// length: SAMPLE_RATE * duration,
		sampleRate: SAMPLE_RATE,
	});
	// offlineAudioContext.destination.channelCount = 1;
	// offlineAudioContext.destination.channelInterpretation = 'discrete';
	return offlineAudioContext;
}

export async function generateAudioDataFromGenomeString( 
	genomeString,
	duration,
	noteDelta,
	velocity,
	reverse,
	useOvertoneInharmonicityFactors,
	overrideGenomeDurationNoteDeltaAndVelocity,
	useGPU,
	antiAliasing,
	frequencyUpdatesApplyToAllPathcNetworkOutputs
) {
  const genome = JSON.parse(genomeString);
  let _duration, _noteDelta, _velocity;
  if( overrideGenomeDurationNoteDeltaAndVelocity) {

  } else {
    _duration = duration;
    _noteDelta = noteDelta;
    _velocity = velocity;
  }

	const genomeAndMeta = {
		genome: genome.genome || genome, // TODO: oh this is a hack to handle different wrappings of genome
		duration: _duration,
		noteDelta: _noteDelta,
		velocity: _velocity,
		reverse,
		useOvertoneInharmonicityFactors
	};

  // const audioContext = await getAudioContext();
  const audioBuffer = await getAudioBufferFromGenomeAndMeta(
    genomeAndMeta,
    duration, noteDelta, velocity, reverse,
    false, // asDataArray
    getNewOfflineAudioContext( duration ),
    getAudioContext(),
    useOvertoneInharmonicityFactors,
		useGPU,
		antiAliasing,
		frequencyUpdatesApplyToAllPathcNetworkOutputs
  );
  // console.log('audio buffer:', audioBuffer);
  return audioBuffer;
}