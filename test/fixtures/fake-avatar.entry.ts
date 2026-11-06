// A stand-in for an Atmee avatar: joins the LiveKit room, publishes a green
// video and a 520 Hz voice, and reports what the visitor (the bridge) sends it.
import { Room, RoomEvent, Track } from 'livekit-client';

interface AvatarState {
  published: boolean;
  visitorJoined: boolean;
  notes: unknown[];
  chats: string[];
  heardLevel: number;
  heardHz: number;
  error: string | null;
}

const params = new URLSearchParams(location.search);
const state: AvatarState = { published: false, visitorJoined: false, notes: [], chats: [], heardLevel: 0, heardHz: 0, error: null };

const canvas = document.createElement('canvas');
canvas.width = 640;
canvas.height = 360;
const paint = canvas.getContext('2d')!;
let frame = 0;
setInterval(() => {
  paint.fillStyle = 'rgb(0, 200, 80)';
  paint.fillRect(0, 0, canvas.width, canvas.height);
  paint.fillStyle = '#ffffff';
  paint.fillRect((frame++ * 8) % canvas.width, 0, 12, 24);
}, 40);

const ctx = new AudioContext();
const voice = ctx.createOscillator();
voice.frequency.value = 520;
const volume = ctx.createGain();
volume.gain.value = 0.2;
const out = ctx.createMediaStreamDestination();
voice.connect(volume);
volume.connect(out);
voice.start();
const heard = ctx.createAnalyser();
heard.fftSize = 4096;

function measure(): void {
  const samples = new Float32Array(heard.fftSize);
  heard.getFloatTimeDomainData(samples);
  state.heardLevel = Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
  const spectrum = new Float32Array(heard.frequencyBinCount);
  heard.getFloatFrequencyData(spectrum);
  let peak = 0;
  for (let i = 1; i < spectrum.length; i++) if (spectrum[i]! > spectrum[peak]!) peak = i;
  state.heardHz = Math.round((peak * ctx.sampleRate) / heard.fftSize);
}

const room = new Room({ adaptiveStream: false, dynacast: false });
room.registerTextStreamHandler('atmee.app', async (reader) => {
  state.notes.push(JSON.parse(await reader.readAll()) as unknown);
});
room.registerTextStreamHandler('lk.chat', async (reader) => {
  state.chats.push(await reader.readAll());
});
room.on(RoomEvent.TrackSubscribed, (track) => {
  if (track.kind !== Track.Kind.Audio) return;
  const media = new MediaStream([track.mediaStreamTrack]);
  const element = new Audio();
  element.muted = true;
  element.srcObject = media;
  element.play().catch(() => {});
  ctx.createMediaStreamSource(media).connect(heard);
});
room.on(RoomEvent.ParticipantConnected, () => {
  state.visitorJoined = true;
  setTimeout(() => {
    room.localParticipant.sendText('Hello from the avatar.', { topic: 'lk.transcription' }).catch(() => {});
  }, 1500);
});

(async () => {
  try {
    await room.connect(params.get('url')!, params.get('token')!);
    await room.localParticipant.publishTrack(canvas.captureStream(25).getVideoTracks()[0]!, { source: Track.Source.Camera, simulcast: false });
    await room.localParticipant.publishTrack(out.stream.getAudioTracks()[0]!, { source: Track.Source.Microphone });
    state.published = true;
  } catch (err) {
    state.error = String(err);
  }
})();

setInterval(() => {
  measure();
  fetch('/report?kind=avatar', { method: 'POST', keepalive: true, body: JSON.stringify(state) }).catch(() => {});
}, 300);
