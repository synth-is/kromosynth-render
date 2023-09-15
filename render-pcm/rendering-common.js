import NodeWebAudioAPI from 'node-web-audio-api';
const { AudioContext, OfflineAudioContext } = NodeWebAudioAPI;

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