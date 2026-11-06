// The chain a real Atmee session takes, with everything but Atmee itself real:
// a mock Atmee API starts a "session" by putting a fake avatar into a room of a
// local LiveKit server, and the bridge carries it into the mock meeting.
// Needs the LiveKit server: scripts/get-livekit-server.sh. Skipped without it.
import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AtmeeClient } from '../src/atmee.js';
import { runBridge, type BridgeController, type OutputEvent } from '../src/bridge.js';
import { GoogleMeet } from '../src/platforms/index.js';
import { FixtureServer, waitFor, type MeetingReport } from './helpers/fixture-server.js';
import { hasLiveKit, LIVEKIT_URL, livekitToken, startLiveKit } from './helpers/livekit.js';

class LocalMeet extends GoogleMeet {
  override matches(): boolean {
    return true;
  }

  override entryUrl(url: URL): string {
    return url.toString();
  }
}

interface AvatarReport {
  published: boolean;
  visitorJoined: boolean;
  notes: { type: string; text: string }[];
  chats: string[];
  heardLevel: number;
  heardHz: number;
  error: string | null;
}

const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;
const AVATAR_GREEN = { r: 0, g: 200, b: 80 };
const AVATAR_HZ = 520;
const PARTICIPANT_HZ = 660;

describe.skipIf(!hasLiveKit)('bridge with an avatar in a LiveKit room', () => {
  const fixtures = new FixtureServer();
  let base: string;
  let livekit: ChildProcess;
  let bundleDir: string;
  let avatarBrowser: Browser;
  let avatarPage: Page | undefined;
  let api: Server;
  let apiUrl: string;
  const apiCalls: { path: string; apiKey: string | undefined; body: Record<string, unknown> }[] = [];
  const avatar = () => fixtures.otherReports.get('avatar') as AvatarReport | undefined;

  beforeAll(async () => {
    livekit = await startLiveKit();
    bundleDir = await mkdtemp(join(tmpdir(), 'atmee-bridge-test-'));
    await build({
      entryPoints: [new URL('./fixtures/fake-avatar.entry.js', import.meta.url).pathname],
      outfile: join(bundleDir, 'fake-avatar.bundle.js'),
      bundle: true,
      format: 'iife',
      platform: 'browser',
      logLevel: 'silent',
    });
    fixtures.extraRoots.push(bundleDir);
    base = await fixtures.start();
    avatarBrowser = await chromium.launch({
      channel: 'chromium',
      args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'],
    });

    // The mock Atmee API: a session is a room with the fake avatar already in it.
    api = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        void (async () => {
          const path = req.url ?? '';
          apiCalls.push({ path, apiKey: req.headers['x-api-key'] as string | undefined, body: raw ? JSON.parse(raw) : {} });
          if (path === '/v1/sessions') {
            const room = `rk-${Date.now()}`;
            avatarPage = await avatarBrowser.newPage();
            await avatarPage.goto(`${base}/fake-avatar.html?url=${encodeURIComponent(LIVEKIT_URL)}&token=${livekitToken('avatar', room)}`);
            await waitFor(avatar, (report) => Boolean(report?.published || report?.error), 20_000, 'the fake avatar in the room');
            res.writeHead(201, { 'Content-Type': 'application/json' }).end(JSON.stringify({
              sessionId: 'session-1',
              serverUrl: LIVEKIT_URL,
              roomName: room,
              userToken: livekitToken('visitor', room),
              billingMode: 'metered',
              watermark: false,
            }));
          } else if (path === '/v1/sessions/session-1/end') {
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ alreadyEnded: false }));
          } else {
            res.writeHead(404).end();
          }
        })();
      });
    });
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await avatarBrowser?.close();
    await new Promise<void>((resolve) => api?.close(() => resolve()) ?? resolve());
    await fixtures.stop();
    livekit?.kill();
    if (bundleDir) await rm(bundleDir, { recursive: true, force: true });
  });

  it('carries the avatar into the meeting and the meeting back to the avatar, then ends the session', async () => {
    const events: OutputEvent[] = [];
    let controller: BridgeController | undefined;
    const stop = new AbortController();
    const run = runBridge({
      meetingUrl: `${base}/meeting.html`,
      botName: 'Leo (AI)',
      avatar: { kind: 'atmee', client: new AtmeeClient({ apiKey: 'sk_atmee_test', baseUrl: apiUrl }), avatarId: 'avatar-1', welcome: false },
      context: 'Weekly sync. Sam leads it.',
      maxDurationSeconds: 300,
      joinTimeoutMs: 20_000,
      leaveAfterSilenceMs: 0,
      headless: true,
      platform: new LocalMeet(),
      signal: stop.signal,
      onEvent: (event) => events.push(event),
      onReady: (ready) => { controller = ready; },
    });

    try {
      await waitFor(() => events, (seen) => seen.some((event) => event.type === 'avatar-live'), 60_000, 'avatar-live');
      expect(avatar()?.error).toBeNull();

      // The session was asked for only after the bot was admitted, with the options given.
      const order = events.map((event) => event.type);
      expect(order.indexOf('joined')).toBeLessThan(order.indexOf('avatar-starting'));
      expect(apiCalls[0]).toEqual({
        path: '/v1/sessions',
        apiKey: 'sk_atmee_test',
        body: { avatarId: 'avatar-1', maxDurationSeconds: 300, welcome: false },
      });
      expect(events).toContainEqual({ type: 'avatar-live', sessionId: 'session-1' });

      // Avatar -> meeting: the participant sees the avatar's video and hears its voice.
      const seen = (report: MeetingReport | null) => {
        const far = report?.participant;
        return Boolean(far?.color && near(far.color.r, AVATAR_GREEN.r, 45) && near(far.color.g, AVATAR_GREEN.g, 45)
          && near(far.color.b, AVATAR_GREEN.b, 45) && far.audioLevel > 0.02 && near(far.audioHz, AVATAR_HZ, 25));
      };
      await waitFor(() => fixtures.report, seen, 30_000, 'the avatar in the meeting');

      // Nobody speaks in the meeting: the avatar must hear silence, not its own voice fed back.
      await waitFor(() => fixtures.report, (report) => report?.bridge?.meetingAudioTracks === 1, 10_000, 'the meeting audio tap');
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(fixtures.report!.bridge).toMatchObject({ meetingAudioTracks: 1, avatarAudioTracks: 1 });
      expect(fixtures.report!.bridge!.meetingAudioLevel).toBeLessThan(0.005);
      expect(avatar()!.heardLevel).toBeLessThan(0.005);

      // Meeting -> avatar: the participant speaks, and the avatar hears that voice.
      fixtures.control.speaking = true;
      await waitFor(avatar, (report) => Boolean(report && report.heardLevel > 0.02 && near(report.heardHz, PARTICIPANT_HZ, 25)), 15_000, 'the meeting voice at the avatar');

      // The avatar is told where it is and what the meeting is about.
      const notes = await waitFor(() => avatar()?.notes ?? [], (list) => list.length >= 2, 15_000, 'the context notes');
      expect(notes[0]).toMatchObject({ type: 'note', text: expect.stringContaining('Google Meet video call as "Leo (AI)"') });
      expect(notes[1]).toEqual({ type: 'note', text: 'Weekly sync. Sam leads it.' });

      // What the avatar says comes out as a transcript; what the operator types reaches the avatar.
      await waitFor(() => events, (list) => list.some((event) => event.type === 'transcript'), 15_000, 'a transcript');
      expect(events).toContainEqual({ type: 'transcript', speaker: 'avatar', text: 'Hello from the avatar.' });
      await controller!.say('Please introduce yourself.');
      await controller!.send({ type: 'event', text: 'Sam just joined.' });
      await waitFor(() => avatar()?.chats ?? [], (list) => list.includes('Please introduce yourself.'), 10_000, 'the typed turn');
      await waitFor(() => avatar()?.notes ?? [], (list) => list.some((note) => note.type === 'event' && note.text === 'Sam just joined.'), 10_000, 'the event');

      // The session ends on Atmee's side (the avatar leaves): the bot leaves the meeting and ends the session.
      await avatarPage!.close();
      await expect(run).resolves.toMatchObject({ reason: 'avatar-session-ended' });
      expect(fixtures.report).toMatchObject({ leftClicked: true });
      expect(apiCalls.at(-1)).toMatchObject({ path: '/v1/sessions/session-1/end', apiKey: 'sk_atmee_test' });
    } finally {
      stop.abort();
      await run.catch(() => {});
    }
  });
});
