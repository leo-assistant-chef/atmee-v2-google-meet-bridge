// The two media devices the meeting page is handed in place of real ones:
// a camera that shows the avatar, and an audio bus that carries the avatar's
// voice into the meeting and the meeting's voices back to the avatar.
import type { InjectConfig } from '../protocol.js';

/** A canvas-backed camera: a placeholder card until the avatar's video arrives, then the avatar. */
export class VirtualCamera {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly stream: MediaStream;
  private video: HTMLVideoElement | null = null;
  private status = 'Connecting…';
  private tick = 0;

  constructor(private readonly cfg: InjectConfig) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = cfg.width;
    this.canvas.height = cfg.height;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2d canvas is not available');
    this.ctx = ctx;
    this.draw();
    this.stream = this.canvas.captureStream(cfg.fps);
    setInterval(() => this.draw(), 1000 / cfg.fps);
  }

  get track(): MediaStreamTrack {
    const track = this.stream.getVideoTracks()[0];
    if (!track) throw new Error('the virtual camera has no video track');
    return track;
  }

  setStatus(status: string): void {
    this.status = status;
  }

  /** Shows this video track full-frame; null goes back to the placeholder card. */
  setSource(track: MediaStreamTrack | null): void {
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
    if (!track) return;
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.srcObject = new MediaStream([track]);
    void video.play().catch(() => {});
    this.video = video;
  }

  private draw(): void {
    const { ctx, cfg } = this;
    this.tick++;
    ctx.fillStyle = '#0b0f16';
    ctx.fillRect(0, 0, cfg.width, cfg.height);
    const video = this.video;
    if (video && video.readyState >= 2 && video.videoWidth > 0) {
      const scale = cfg.fit === 'cover'
        ? Math.max(cfg.width / video.videoWidth, cfg.height / video.videoHeight)
        : Math.min(cfg.width / video.videoWidth, cfg.height / video.videoHeight);
      const w = video.videoWidth * scale;
      const h = video.videoHeight * scale;
      ctx.drawImage(video, (cfg.width - w) / 2, (cfg.height - h) / 2, w, h);
      return;
    }
    // The placeholder keeps changing so the capture stream keeps sending frames.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e5e7eb';
    ctx.font = `600 ${Math.round(cfg.height / 12)}px system-ui, sans-serif`;
    ctx.fillText(cfg.botName, cfg.width / 2, cfg.height / 2 - cfg.height / 16);
    ctx.fillStyle = '#9ca3af';
    ctx.font = `${Math.round(cfg.height / 24)}px system-ui, sans-serif`;
    ctx.fillText(this.status, cfg.width / 2, cfg.height / 2 + cfg.height / 16);
    const phase = (this.tick / cfg.fps) * Math.PI * 2;
    ctx.fillStyle = `rgba(99, 102, 241, ${0.55 + 0.45 * Math.sin(phase)})`;
    ctx.beginPath();
    ctx.arc(cfg.width / 2, cfg.height / 2 + cfg.height / 6, cfg.height / 60, 0, Math.PI * 2);
    ctx.fill();
  }
}

interface Tap {
  node: MediaStreamAudioSourceNode;
  element: HTMLAudioElement;
}

const SPEECH_LEVEL = 0.01; // RMS above which the meeting counts as "someone is speaking"
const EXCLUSION_GRACE_MS = 300;

/**
 * mouth: the avatar's voice, mixed into the track the meeting takes as the microphone.
 * ears: every remote voice in the meeting, mixed into the track the avatar hears.
 */
export class AudioBus {
  readonly ctx: AudioContext;
  private readonly mouthMix: GainNode;
  private readonly earsMix: GainNode;
  private readonly mouthOut: MediaStreamAudioDestinationNode;
  private readonly earsOut: MediaStreamAudioDestinationNode;
  private readonly mouthMeter: AnalyserNode;
  private readonly earsMeter: AnalyserNode;
  private readonly mouthTaps = new Map<MediaStreamTrack, Tap>();
  private readonly earTaps = new Map<MediaStreamTrack, Tap>();
  private readonly excluded = new WeakSet<MediaStreamTrack>();
  private lastMeetingAudioAt: number | null = null;
  onMeetingTracksChanged: (count: number) => void = () => {};

  constructor() {
    this.ctx = new AudioContext({ sampleRate: 48_000 });
    this.mouthMix = this.ctx.createGain();
    this.earsMix = this.ctx.createGain();
    this.mouthOut = this.ctx.createMediaStreamDestination();
    this.earsOut = this.ctx.createMediaStreamDestination();
    this.mouthMeter = this.ctx.createAnalyser();
    this.earsMeter = this.ctx.createAnalyser();
    this.mouthMix.connect(this.mouthOut);
    this.mouthMix.connect(this.mouthMeter);
    this.earsMix.connect(this.earsOut);
    this.earsMix.connect(this.earsMeter);
    // A silent source keeps both output tracks producing audio frames from the start.
    const silence = this.ctx.createConstantSource();
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    silence.connect(mute);
    mute.connect(this.mouthMix);
    mute.connect(this.earsMix);
    silence.start();
    setInterval(() => {
      void this.ctx.resume().catch(() => {});
      if (this.meetingAudioLevel() > SPEECH_LEVEL) this.lastMeetingAudioAt = Date.now();
    }, 500);
  }

  /** The track the meeting gets as the bot's microphone. */
  get mouthTrack(): MediaStreamTrack {
    return this.first(this.mouthOut);
  }

  /** The track the avatar gets as the visitor's microphone. */
  get earsTrack(): MediaStreamTrack {
    return this.first(this.earsOut);
  }

  get mouthInput(): AudioNode {
    return this.mouthMix;
  }

  private first(out: MediaStreamAudioDestinationNode): MediaStreamTrack {
    const track = out.stream.getAudioTracks()[0];
    if (!track) throw new Error('the audio bus has no output track');
    return track;
  }

  private tap(track: MediaStreamTrack, into: AudioNode): Tap {
    const stream = new MediaStream([track]);
    // Chrome only pulls a remote WebRTC track into WebAudio while a media element plays it.
    const element = new Audio();
    element.muted = true;
    element.srcObject = stream;
    void element.play().catch(() => {});
    const node = this.ctx.createMediaStreamSource(stream);
    node.connect(into);
    return { node, element };
  }

  private untap(taps: Map<MediaStreamTrack, Tap>, track: MediaStreamTrack): boolean {
    const tap = taps.get(track);
    if (!tap) return false;
    tap.node.disconnect();
    tap.element.srcObject = null;
    taps.delete(track);
    return true;
  }

  addAvatarTrack(track: MediaStreamTrack): void {
    this.exclude(track);
    if (this.mouthTaps.has(track)) return;
    this.mouthTaps.set(track, this.tap(track, this.mouthMix));
    track.addEventListener('ended', () => this.removeAvatarTrack(track), { once: true });
  }

  removeAvatarTrack(track: MediaStreamTrack): void {
    this.untap(this.mouthTaps, track);
  }

  /** Never let this track into the ears: it is the avatar's own voice. */
  exclude(track: MediaStreamTrack): void {
    this.excluded.add(track);
    if (this.untap(this.earTaps, track)) this.onMeetingTracksChanged(this.earTaps.size);
  }

  /** A remote audio track of the meeting. Taken after a short grace, so the avatar's own tracks can be excluded first. */
  addMeetingTrack(track: MediaStreamTrack): void {
    setTimeout(() => {
      if (this.excluded.has(track) || this.earTaps.has(track) || track.readyState === 'ended') return;
      this.earTaps.set(track, this.tap(track, this.earsMix));
      this.onMeetingTracksChanged(this.earTaps.size);
      track.addEventListener('ended', () => {
        if (this.untap(this.earTaps, track)) this.onMeetingTracksChanged(this.earTaps.size);
      }, { once: true });
    }, EXCLUSION_GRACE_MS);
  }

  private level(meter: AnalyserNode): number {
    const samples = new Float32Array(meter.fftSize);
    meter.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    return Math.sqrt(sum / samples.length);
  }

  meetingAudioLevel(): number {
    return this.level(this.earsMeter);
  }

  avatarAudioLevel(): number {
    return this.level(this.mouthMeter);
  }

  get meetingTrackCount(): number {
    return this.earTaps.size;
  }

  get avatarTrackCount(): number {
    return this.mouthTaps.size;
  }

  msSinceMeetingAudio(): number | null {
    return this.lastMeetingAudioAt === null ? null : Date.now() - this.lastMeetingAudioAt;
  }
}
