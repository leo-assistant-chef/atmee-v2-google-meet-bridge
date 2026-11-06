// One bot in one meeting: open the meeting in a browser whose camera and
// microphone are the avatar, get admitted, start the avatar's session, and stay
// until the meeting or the session is over. Always ends the Atmee session.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join as joinPath } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { AtmeeClient } from './atmee.js';
import { detectPlatform, type MeetingPlatform } from './platforms/index.js';
import {
  EMIT_BINDING,
  type AppMessage,
  type BridgeGlobal,
  type InjectApi,
  type InjectConfig,
  type InjectEvent,
  type VideoFit,
} from './protocol.js';

export type EndReason =
  | 'meeting-ended'
  | 'left'
  | 'avatar-session-ended'
  | 'silence'
  | 'max-duration'
  | 'browser-closed';

export type OutputEvent =
  | { type: 'starting'; platform: string }
  | { type: 'waiting-room' }
  | { type: 'joined' }
  | { type: 'avatar-starting' }
  | { type: 'avatar-live'; sessionId?: string }
  | { type: 'transcript'; speaker: 'avatar' | 'meeting'; text: string }
  | { type: 'ended'; reason: EndReason; detail?: string };

export type AvatarOptions =
  | {
    kind: 'atmee';
    client: AtmeeClient;
    avatarId: string;
    language?: string;
    welcome?: boolean;
    checkInAfterS?: number;
  }
  | { kind: 'fake' };

export interface BridgeController {
  /** A typed turn: the avatar answers it out loud. */
  say(text: string): Promise<void>;
  /** State, a note or an event for the avatar (Atmee's `atmee.app` topic). */
  send(message: AppMessage): Promise<void>;
  leave(): void;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface BridgeOptions {
  meetingUrl: string;
  botName: string;
  avatar: AvatarOptions;
  /** Extra context for the avatar about this meeting, sent as notes once it is live. */
  context?: string;
  maxDurationSeconds: number;
  joinTimeoutMs: number;
  /** Leave after this long without anyone speaking in the meeting; 0 never does. */
  leaveAfterSilenceMs: number;
  headless: boolean;
  /** A Chromium profile directory, to join as a signed-in Google account. */
  profileDir?: string;
  /** Where to save a screenshot and the page text when joining fails. */
  debugDir?: string;
  video?: { width?: number; height?: number; fps?: number; fit?: VideoFit };
  /** Overrides platform detection (tests). */
  platform?: MeetingPlatform;
  signal?: AbortSignal;
  onEvent?: (event: OutputEvent) => void;
  onReady?: (controller: BridgeController) => void;
  log?: (level: LogLevel, message: string) => void;
}

export interface BridgeResult {
  reason: EndReason;
  detail?: string;
}

export class BridgeError extends Error {
  constructor(
    public readonly code: 'unsupported-url' | 'avatar-failed',
    message: string,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

const NOTE_MAX_CHARS = 1_900; // Atmee takes notes of up to 2,000 characters each
const AVATAR_ARRIVAL_TIMEOUT_MS = 90_000;
const POLL_MS = 1_000;
const DURATION_BACKSTOP_MS = 30_000;

const CHROMIUM_ARGS = [
  // A camera and a microphone exist and are granted without a prompt; the injected script supplies their content.
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  // The render loop and the audio graph must keep running in a window nobody looks at.
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  // Google Meet turns guests away when navigator.webdriver is set.
  '--disable-blink-features=AutomationControlled',
  '--mute-audio',
];

/** Splits text into notes of at most `max` characters, on paragraph and then word boundaries. */
export function chunkNotes(text: string, max = NOTE_MAX_CHARS): string[] {
  const notes: string[] = [];
  let current = '';
  const push = () => {
    if (current.trim()) notes.push(current.trim());
    current = '';
  };
  for (const paragraph of text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean)) {
    if (paragraph.length > max) {
      push();
      let line = '';
      for (const word of paragraph.split(/\s+/)) {
        for (let rest = word; rest; rest = rest.slice(max)) {
          const piece = rest.slice(0, max);
          if (line && line.length + 1 + piece.length > max) {
            notes.push(line);
            line = '';
          }
          line = line ? `${line} ${piece}` : piece;
        }
      }
      if (line) notes.push(line);
    } else if (current && current.length + 2 + paragraph.length > max) {
      push();
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  push();
  return notes;
}

export function buildNotes(platformName: string, botName: string, context?: string): string[] {
  const setting =
    `You are attending a ${platformName} video call as "${botName}". Several people may be in the call. ` +
    'You hear all of them on one audio channel, so do not assume every voice is the same person.';
  return [setting, ...chunkNotes(context ?? '')];
}

async function loadInjectBundle(): Promise<string> {
  const candidates = [new URL('./inject.js', import.meta.url), new URL('../dist/inject.js', import.meta.url)];
  for (const candidate of candidates) {
    try {
      return await readFile(candidate, 'utf8');
    } catch {
      // try the next location
    }
  }
  throw new Error('dist/inject.js is missing: run "npm run build" first');
}

function callInject<M extends keyof InjectApi>(page: Page, method: M, ...args: Parameters<InjectApi[M]>) {
  return page.evaluate(
    ([name, values]) => {
      const api = (globalThis as unknown as BridgeGlobal).__atmeeBridge;
      if (!api) throw new Error('the bridge script is not installed in this page');
      return (api[name] as (...input: unknown[]) => unknown)(...values);
    },
    [method, args] as const,
  ) as Promise<Awaited<ReturnType<InjectApi[M]>>>;
}

/** Headless Chromium names itself in the user agent; sites that turn automation away read it. */
async function useRegularUserAgent(context: BrowserContext, page: Page): Promise<void> {
  const cdp = await context.newCDPSession(page);
  const { userAgent } = await cdp.send('Browser.getVersion');
  if (userAgent.includes('Headless')) {
    await cdp.send('Network.setUserAgentOverride', { userAgent: userAgent.replace('HeadlessChrome', 'Chrome') });
  }
}

async function saveDebug(page: Page | undefined, dir: string | undefined, log: BridgeOptions['log']): Promise<void> {
  if (!page || !dir || page.isClosed()) return;
  try {
    await mkdir(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await page.screenshot({ path: joinPath(dir, `${stamp}.png`) });
    await writeFile(joinPath(dir, `${stamp}.txt`), `${page.url()}\n\n${await page.locator('body').innerText()}`);
    log?.('info', `saved a screenshot and the page text to ${dir}`);
  } catch (err) {
    log?.('warn', `could not save debug output: ${String(err)}`);
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });

export async function runBridge(options: BridgeOptions): Promise<BridgeResult> {
  const log = options.log ?? (() => {});
  const emit = options.onEvent ?? (() => {});

  const detected = options.platform
    ? { platform: options.platform, url: new URL(options.meetingUrl) }
    : detectPlatform(options.meetingUrl);
  if (!detected) throw new BridgeError('unsupported-url', `Not a supported meeting link: ${options.meetingUrl}`);
  const { platform, url } = detected;

  const config: InjectConfig = {
    botName: options.botName,
    width: options.video?.width ?? 1280,
    height: options.video?.height ?? 720,
    fps: options.video?.fps ?? 25,
    fit: options.video?.fit ?? 'contain',
  };
  const injectSource = await loadInjectBundle();

  const leaving = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, leaving.signal]) : leaving.signal;

  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let sessionId: string | undefined;
  let avatarGone: string | null = null;
  let avatarLiveAt = 0;
  let lastMeetingAudioAt: number | null = null;

  const onInjectEvent = (json: string) => {
    let event: InjectEvent;
    try {
      event = JSON.parse(json) as InjectEvent;
    } catch {
      return;
    }
    switch (event.type) {
      case 'transcript':
        emit({ type: 'transcript', speaker: event.speaker, text: event.text });
        break;
      case 'avatar-disconnected':
        avatarGone = event.reason;
        break;
      case 'heartbeat':
        if (event.msSinceMeetingAudio !== null) lastMeetingAudioAt = Date.now() - event.msSinceMeetingAudio;
        // A reloaded page comes back without the avatar: the session is lost.
        if (avatarLiveAt && !event.avatarConnected) avatarGone ??= 'the meeting page lost the avatar connection';
        break;
      case 'log':
        log(event.level, event.message);
        break;
      default:
        log('debug', `page: ${json}`);
    }
  };

  try {
    const launchOptions = { headless: options.headless, channel: 'chromium', args: CHROMIUM_ARGS };
    const contextOptions = {
      bypassCSP: true, // the meeting page must be allowed to reach the avatar's LiveKit room
      permissions: ['camera', 'microphone'],
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
    };
    if (options.profileDir) {
      context = await chromium.launchPersistentContext(options.profileDir, { ...launchOptions, ...contextOptions });
    } else {
      browser = await chromium.launch(launchOptions);
      context = await browser.newContext(contextOptions);
    }
    await context.exposeBinding(EMIT_BINDING, (_source, json: string) => onInjectEvent(json));
    await context.addInitScript({ content: `window.__atmeeBridgeConfig = ${JSON.stringify(config)};\n${injectSource}` });
    page = context.pages()[0] ?? (await context.newPage());
    await useRegularUserAgent(context, page);

    emit({ type: 'starting', platform: platform.id });
    await page.goto(platform.entryUrl(url), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await platform.join(page, {
      botName: options.botName,
      timeoutMs: options.joinTimeoutMs,
      signal,
      onWaitingRoom: () => emit({ type: 'waiting-room' }),
    });
    emit({ type: 'joined' });

    // The avatar's session starts only now: nothing is billed while the bot waits to be admitted.
    emit({ type: 'avatar-starting' });
    const avatar = options.avatar;
    if (avatar.kind === 'fake') {
      await callInject(page, 'connect', { kind: 'fake' });
    } else {
      const session = await avatar.client.createSession(
        {
          avatarId: avatar.avatarId,
          maxDurationSeconds: options.maxDurationSeconds,
          ...(avatar.language ? { language: avatar.language } : {}),
          ...(avatar.welcome === undefined ? {} : { welcome: avatar.welcome }),
          ...(avatar.checkInAfterS === undefined ? {} : { checkInAfterS: avatar.checkInAfterS }),
        },
        { signal, onRetry: (attempt, err) => log('info', `Atmee has no capacity yet (${err.code}), retry ${attempt}`) },
      );
      sessionId = session.sessionId;
      if (session.durationCapped) log('warn', `Atmee capped the session at ${session.actualDurationSeconds}s`);
      try {
        await callInject(page, 'connect', {
          kind: 'livekit',
          serverUrl: session.serverUrl,
          userToken: session.userToken,
          notes: buildNotes(platform.name, options.botName, options.context),
          arrivalTimeoutMs: AVATAR_ARRIVAL_TIMEOUT_MS,
        });
      } catch (err) {
        throw new BridgeError('avatar-failed', `The avatar did not come up in the meeting: ${(err as Error).message}`);
      }
    }
    avatarLiveAt = Date.now();
    emit({ type: 'avatar-live', ...(sessionId ? { sessionId } : {}) });

    const live = page;
    options.onReady?.({
      say: (text) => callInject(live, 'say', text),
      send: (message) => callInject(live, 'send', message),
      leave: () => leaving.abort(),
    });

    const hardStopAt = avatarLiveAt + options.maxDurationSeconds * 1000 + DURATION_BACKSTOP_MS;
    for (;;) {
      if (signal.aborted) return { reason: 'left' };
      if (page.isClosed()) return { reason: 'browser-closed' };
      const call = await platform.callState(page);
      if (!call.inCall) return { reason: 'meeting-ended', detail: call.reason };
      if (avatarGone) return { reason: 'avatar-session-ended', detail: avatarGone };
      const quietSince = Math.max(avatarLiveAt, lastMeetingAudioAt ?? 0);
      if (options.leaveAfterSilenceMs > 0 && Date.now() - quietSince > options.leaveAfterSilenceMs) {
        return { reason: 'silence', detail: `nobody spoke for ${Math.round(options.leaveAfterSilenceMs / 1000)}s` };
      }
      if (Date.now() > hardStopAt) return { reason: 'max-duration' };
      await sleep(POLL_MS, signal);
    }
  } catch (err) {
    await saveDebug(page, options.debugDir, log);
    throw err;
  } finally {
    if (page && !page.isClosed()) {
      await platform.leave(page).catch(() => {});
      await callInject(page, 'disconnect').catch(() => {});
    }
    if (sessionId && options.avatar.kind === 'atmee') {
      await options.avatar.client.endSession(sessionId).catch((err: unknown) => {
        log('error', `could not end Atmee session ${sessionId}: ${String(err)}. End it in Atmee Studio to stop billing.`);
      });
    }
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}
