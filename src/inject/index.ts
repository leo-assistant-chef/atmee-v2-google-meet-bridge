// Runs in the meeting page before any of its scripts. It replaces the page's
// camera and microphone with the avatar, taps the meeting's audio for the
// avatar to hear, and waits for the Node process to say where the avatar is.
import type { AvatarConnectParams, BridgeGlobal, InjectApi, InjectConfig, InjectEvent } from '../protocol.js';
import { AudioBus, VirtualCamera } from './media.js';
import { patchPeerConnection, patchUserMedia } from './patch.js';
import { connectFake, connectLiveKit, type AvatarSource } from './sources.js';

const DEFAULTS: InjectConfig = { botName: 'Atmee Avatar', width: 1280, height: 720, fps: 25, fit: 'contain' };
const HEARTBEAT_MS = 5_000;

function install(): void {
  const scope = window as unknown as BridgeGlobal;
  if (window.top !== window || scope.__atmeeBridge) return; // the meeting's own page only, once

  const cfg = { ...DEFAULTS, ...scope.__atmeeBridgeConfig };

  const pending: InjectEvent[] = [];
  const flush = () => {
    const send = scope.__atmeeBridgeEmit;
    if (!send) return;
    for (const event of pending.splice(0)) void send(JSON.stringify(event));
  };
  const emit = (event: InjectEvent) => {
    pending.push(event);
    flush();
  };

  const camera = new VirtualCamera(cfg);
  const audio = new AudioBus();
  audio.onMeetingTracksChanged = (count) => emit({ type: 'meeting-audio-track', count });

  let mediaRequests = 0;
  patchUserMedia({
    video: () => camera.track,
    audio: () => audio.mouthTrack,
    onRequest: (wantAudio, wantVideo) => {
      mediaRequests++;
      emit({ type: 'media-requested', audio: wantAudio, video: wantVideo });
    },
  });
  patchPeerConnection((track) => audio.addMeetingTrack(track));

  let source: AvatarSource | null = null;
  const requireSource = () => {
    if (!source) throw new Error('the avatar is not connected');
    return source;
  };

  const api: InjectApi = {
    async connect(params: AvatarConnectParams) {
      if (source) throw new Error('the avatar is already connected');
      source = params.kind === 'fake'
        ? connectFake({ camera, audio, emit })
        : await connectLiveKit(params, {
          camera,
          audio,
          emit: (event) => {
            if (event.type === 'avatar-disconnected') source = null;
            emit(event);
          },
        });
      emit({ type: 'avatar-live' });
    },
    say: (text) => requireSource().say(text),
    send: (message) => requireSource().send(message),
    async disconnect() {
      const current = source;
      source = null;
      await current?.disconnect();
    },
    stats: () => ({
      avatarConnected: source !== null,
      mediaRequests,
      meetingAudioTracks: audio.meetingTrackCount,
      avatarAudioTracks: audio.avatarTrackCount,
      meetingAudioLevel: audio.meetingAudioLevel(),
      avatarAudioLevel: audio.avatarAudioLevel(),
      msSinceMeetingAudio: audio.msSinceMeetingAudio(),
    }),
  };
  scope.__atmeeBridge = api;

  setInterval(() => {
    flush();
    emit({
      type: 'heartbeat',
      avatarConnected: source !== null,
      meetingAudioTracks: audio.meetingTrackCount,
      msSinceMeetingAudio: audio.msSinceMeetingAudio(),
    });
  }, HEARTBEAT_MS);

  emit({ type: 'inject-ready' });
}

try {
  install();
} catch (err) {
  console.error('[atmee-meet-bridge] could not install', err);
}
