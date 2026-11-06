// Where the avatar comes from: an Atmee session's LiveKit room, or a synthetic
// stand-in that needs no account (for dry runs and tests).
import { Room, RoomEvent, Track } from 'livekit-client';
import type { AppMessage, AvatarConnectParams, InjectEvent } from '../protocol.js';
import type { AudioBus, VirtualCamera } from './media.js';

export interface AvatarSource {
  say(text: string): Promise<void>;
  send(message: AppMessage): Promise<void>;
  disconnect(): Promise<void>;
}

export interface SourceDeps {
  camera: VirtualCamera;
  audio: AudioBus;
  emit(event: InjectEvent): void;
}

const CHAT_TOPIC = 'lk.chat';
const APP_TOPIC = 'atmee.app';
const TRANSCRIPTION_TOPIC = 'lk.transcription';
const TOOL_RPC = 'atmee.tool';
const LINK_DELAY_MS = 2_500; // atmee.app is heard only once the avatar's agent has linked the visitor
const EMPTY_ROOM_GRACE_MS = 10_000; // how long the avatar may be gone from the room before the session counts as over

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type LiveKitParams = Extract<AvatarConnectParams, { kind: 'livekit' }>;

export async function connectLiveKit(params: LiveKitParams, deps: SourceDeps): Promise<AvatarSource> {
  const { camera, audio, emit } = deps;
  // The avatar's video is drawn to a canvas, not shown in an element LiveKit can
  // measure, so adaptive stream would take it for hidden and pause it.
  const room = new Room({ adaptiveStream: false, dynacast: false });

  // The bridge declares no app tools; an avatar that calls one gets an answer instead of a hang.
  room.registerRpcMethod(TOOL_RPC, async () => 'error: this client handles no tools');

  room.registerTextStreamHandler(TRANSCRIPTION_TOPIC, async (reader, participant) => {
    const fromMeeting = participant?.identity === room.localParticipant.identity;
    let text = '';
    try {
      for await (const chunk of reader) text += chunk;
    } catch {
      // the stream was cut off; keep what arrived
    }
    text = text.replace(/^\s*\[(?:interruption|backchannel)\]\s*/i, '').trim();
    if (!text) return;
    // A growing utterance of the meeting arrives as several streams; only the last is final.
    if (fromMeeting && reader.info.attributes?.['lk.transcription_final'] !== 'true') return;
    emit({ type: 'transcript', speaker: fromMeeting ? 'meeting' : 'avatar', text });
  });

  let arrived!: () => void;
  const arrival = new Promise<void>((resolve) => { arrived = resolve; });

  room.on(RoomEvent.TrackSubscribed, (track) => {
    const media = track.mediaStreamTrack;
    if (track.kind === Track.Kind.Video) {
      camera.setSource(media);
      arrived();
    } else if (track.kind === Track.Kind.Audio) {
      audio.addAvatarTrack(media);
    }
  });
  room.on(RoomEvent.TrackUnsubscribed, (track) => {
    if (track.kind === Track.Kind.Video) camera.setSource(null);
    else if (track.kind === Track.Kind.Audio) audio.removeAvatarTrack(track.mediaStreamTrack);
  });
  let over = false;
  const finish = (reason: string) => {
    if (over) return;
    over = true;
    camera.setSource(null);
    camera.setStatus('Disconnected');
    emit({ type: 'avatar-disconnected', reason });
  };
  room.on(RoomEvent.Disconnected, (reason) => finish(`room disconnected (${String(reason ?? 'unknown')})`));

  // A session that ends on Atmee's side may leave the room open with nobody in it.
  let emptyTimer: ReturnType<typeof setTimeout> | undefined;
  room.on(RoomEvent.ParticipantDisconnected, () => {
    if (room.remoteParticipants.size > 0 || emptyTimer) return;
    emptyTimer = setTimeout(() => {
      finish('the avatar left the room');
      void room.disconnect();
    }, EMPTY_ROOM_GRACE_MS);
  });
  room.on(RoomEvent.ParticipantConnected, () => {
    clearTimeout(emptyTimer);
    emptyTimer = undefined;
  });

  camera.setStatus('Avatar is joining…');
  await room.connect(params.serverUrl, params.userToken);
  await room.localParticipant.publishTrack(audio.earsTrack, {
    source: Track.Source.Microphone,
    name: 'meeting-audio',
  });

  const timeout = sleep(params.arrivalTimeoutMs).then(() => 'timeout' as const);
  if ((await Promise.race([arrival, timeout])) === 'timeout') {
    await room.disconnect();
    throw new Error('arrival_timeout: the avatar video did not arrive in time');
  }

  const sendText = async (topic: string, text: string) => {
    await room.localParticipant.sendText(text, { topic });
  };
  const send = (message: AppMessage) => sendText(APP_TOPIC, JSON.stringify(message));

  void (async () => {
    await sleep(LINK_DELAY_MS);
    for (const text of params.notes) {
      await send({ type: 'note', text }).catch((err: unknown) => {
        emit({ type: 'log', level: 'warn', message: `could not send a context note: ${String(err)}` });
      });
    }
  })();

  return {
    say: (text) => sendText(CHAT_TOPIC, text),
    send,
    disconnect: async () => {
      over = true; // a disconnect the bridge asked for is not a lost session
      clearTimeout(emptyTimer);
      await room.disconnect();
    },
  };
}

export const FAKE_AVATAR_COLOR = { r: 255, g: 0, b: 128 };
export const FAKE_AVATAR_TONE_HZ = 440;

/** A synthetic avatar: a flat colour with a sweeping bar, and a steady tone for a voice. */
export function connectFake(deps: SourceDeps): AvatarSource {
  const { camera, audio } = deps;
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2d canvas is not available');
  let frame = 0;
  const { r, g, b } = FAKE_AVATAR_COLOR;
  const paint = () => {
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect((frame++ * 8) % canvas.width, 0, 12, 24);
  };
  paint();
  const timer = setInterval(paint, 40);
  const stream = canvas.captureStream(25);
  camera.setSource(stream.getVideoTracks()[0] ?? null);

  const tone = audio.ctx.createOscillator();
  tone.frequency.value = FAKE_AVATAR_TONE_HZ;
  const gain = audio.ctx.createGain();
  gain.gain.value = 0.2;
  tone.connect(gain);
  gain.connect(audio.mouthInput);
  tone.start();

  return {
    say: async () => {},
    send: async () => {},
    disconnect: async () => {
      clearInterval(timer);
      tone.stop();
      gain.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      camera.setSource(null);
    },
  };
}
