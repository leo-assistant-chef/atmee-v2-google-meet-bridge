// The two hooks into the meeting page: what it gets when it asks for a camera
// and a microphone, and a tap on the audio it receives from other participants.
import { INJECT_SOURCE_NAME } from '../protocol.js';

export interface MediaSources {
  video(): MediaStreamTrack;
  audio(): MediaStreamTrack;
  onRequest(audio: boolean, video: boolean): void;
}

/** A copy of the track that a page may stop or re-constrain without touching the original. */
function handOut(track: MediaStreamTrack): MediaStreamTrack {
  const copy = track.clone();
  const native = copy.applyConstraints.bind(copy);
  copy.applyConstraints = (constraints?: MediaTrackConstraints) => native(constraints).catch(() => {});
  return copy;
}

/** getUserMedia answers with the avatar's camera and voice, whatever device was asked for. */
export function patchUserMedia(sources: MediaSources): void {
  if (typeof MediaDevices === 'undefined') return;
  const native = MediaDevices.prototype.getUserMedia;
  MediaDevices.prototype.getUserMedia = function (this: MediaDevices, constraints?: MediaStreamConstraints) {
    const wantAudio = Boolean(constraints?.audio);
    const wantVideo = Boolean(constraints?.video);
    if (!wantAudio && !wantVideo) return native.call(this, constraints);
    sources.onRequest(wantAudio, wantVideo);
    const tracks: MediaStreamTrack[] = [];
    if (wantAudio) tracks.push(handOut(sources.audio()));
    if (wantVideo) tracks.push(handOut(sources.video()));
    return Promise.resolve(new MediaStream(tracks));
  };
}

/**
 * True when the code constructing a peer connection is the injected bundle itself
 * (its LiveKit connection to the avatar). `framesToSkip` are the bundle's own
 * frames between the caller and here, which would otherwise always match.
 */
function calledFromBridge(framesToSkip: number): boolean {
  const frames = new Error().stack?.split('\n').slice(1 + framesToSkip) ?? [];
  return frames.some((frame) => frame.includes(INJECT_SOURCE_NAME));
}

/** Reports every remote audio track the meeting's own peer connections receive. */
export function patchPeerConnection(onMeetingAudio: (track: MediaStreamTrack) => void): void {
  const Native = window.RTCPeerConnection;
  if (!Native) return;
  const Patched = new Proxy(Native, {
    construct(target, args, newTarget) {
      const pc = Reflect.construct(target, args, newTarget) as RTCPeerConnection;
      if (!calledFromBridge(2)) { // skips calledFromBridge and this trap
        pc.addEventListener('track', (event) => {
          if (event.track.kind === 'audio') onMeetingAudio(event.track);
        });
      }
      return pc;
    },
  });
  window.RTCPeerConnection = Patched;
  const legacy = window as unknown as { webkitRTCPeerConnection?: typeof RTCPeerConnection };
  if (legacy.webkitRTCPeerConnection) legacy.webkitRTCPeerConnection = Patched;
}
