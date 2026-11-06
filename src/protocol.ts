// Types shared by the Node process and the script injected into the meeting page.

export type VideoFit = 'contain' | 'cover';

export interface InjectConfig {
  botName: string;
  width: number;
  height: number;
  fps: number;
  fit: VideoFit;
}

/** What the app can tell an Atmee avatar on the `atmee.app` topic. */
export type AppMessage =
  | { type: 'state'; text: string }
  | { type: 'note'; text: string }
  | { type: 'event'; text: string; ttl_s?: number };

export type AvatarConnectParams =
  | { kind: 'livekit'; serverUrl: string; userToken: string; notes: string[]; arrivalTimeoutMs: number }
  | { kind: 'fake' };

/** Events the injected script reports to the Node process. */
export type InjectEvent =
  | { type: 'inject-ready' }
  | { type: 'media-requested'; audio: boolean; video: boolean }
  | { type: 'meeting-audio-track'; count: number }
  | { type: 'avatar-live' }
  | { type: 'avatar-disconnected'; reason: string }
  | { type: 'transcript'; speaker: 'avatar' | 'meeting'; text: string }
  | { type: 'heartbeat'; avatarConnected: boolean; meetingAudioTracks: number; msSinceMeetingAudio: number | null }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string };

export interface BridgeStats {
  avatarConnected: boolean;
  mediaRequests: number;
  meetingAudioTracks: number;
  avatarAudioTracks: number;
  meetingAudioLevel: number;
  avatarAudioLevel: number;
  msSinceMeetingAudio: number | null;
}

/** The API the injected script puts on `window.__atmeeBridge`. */
export interface InjectApi {
  connect(params: AvatarConnectParams): Promise<void>;
  say(text: string): Promise<void>;
  send(message: AppMessage): Promise<void>;
  disconnect(): Promise<void>;
  stats(): BridgeStats;
}

export interface BridgeGlobal {
  __atmeeBridge?: InjectApi;
  __atmeeBridgeConfig?: InjectConfig;
  __atmeeBridgeEmit?: (json: string) => Promise<void> | void;
}

export const EMIT_BINDING = '__atmeeBridgeEmit';
/** Names the injected bundle in stack traces, so its own peer connections are told apart from the meeting's. */
export const INJECT_SOURCE_NAME = 'atmee-meet-bridge-inject.js';
