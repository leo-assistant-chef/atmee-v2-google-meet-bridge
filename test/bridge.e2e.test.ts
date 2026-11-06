// The whole bridge in a real Chromium against a mock meeting: the Google Meet
// adapter drives a page with Meet's affordances, and a second participant on
// the other end of a real WebRTC call measures what the bot sends.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runBridge, type BridgeController, type BridgeOptions, type OutputEvent } from '../src/bridge.js';
import { GoogleMeet, JoinError } from '../src/platforms/index.js';
import { FixtureServer, waitFor, type MeetingReport } from './helpers/fixture-server.js';

/** The Google Meet adapter, pointed at the mock meeting. */
class LocalMeet extends GoogleMeet {
  override matches(): boolean {
    return true;
  }

  override entryUrl(url: URL): string {
    return url.toString();
  }
}

const AVATAR = { r: 255, g: 0, b: 128 }; // the fake avatar's colour
const AVATAR_HZ = 440; // and its voice
const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;
const showsAvatar = (report: MeetingReport | null) => {
  const seen = report?.participant;
  return Boolean(
    seen?.color && near(seen.color.r, AVATAR.r, 45) && near(seen.color.g, AVATAR.g, 45) && near(seen.color.b, AVATAR.b, 45),
  );
};
const hearsAvatar = (report: MeetingReport | null) =>
  Boolean(report?.participant && report.participant.audioLevel > 0.02 && near(report.participant.audioHz, AVATAR_HZ, 25));

const server = new FixtureServer();
let base: string;

// Every bridge a test starts, so one that fails mid-call cannot leave its bot in the next test's meeting.
const running: { stop: AbortController; run: Promise<unknown> }[] = [];

beforeAll(async () => {
  base = await server.start();
});
afterAll(() => server.stop());
beforeEach(() => server.reset());
afterEach(async () => {
  for (const { stop, run } of running.splice(0)) {
    stop.abort();
    await run.catch(() => {});
  }
});

function start(path: string, overrides: Partial<BridgeOptions> = {}) {
  const stop = new AbortController();
  const events: OutputEvent[] = [];
  const run = runBridge({
    meetingUrl: `${base}/${path}`,
    botName: 'Leo (AI)',
    avatar: { kind: 'fake' },
    maxDurationSeconds: 300,
    joinTimeoutMs: 20_000,
    leaveAfterSilenceMs: 0,
    headless: true,
    platform: new LocalMeet(),
    signal: stop.signal,
    onEvent: (event) => events.push(event),
    ...overrides,
  });
  running.push({ stop, run });
  const live = () => waitFor(() => events, (seen) => seen.some((event) => event.type === 'avatar-live'), 40_000, 'avatar-live');
  return { run, events, stop, live };
}

describe('bridge with a synthetic avatar', () => {
  it('joins under its name, shows and voices the avatar, hears the meeting, and leaves when removed', async () => {
    const { run, events } = start('meeting.html?admitDelay=800');

    // The avatar is seen and heard by the other participant, at the camera's 16:9 shape.
    const live = await waitFor(
      () => server.report,
      (report) => showsAvatar(report) && hearsAvatar(report) && report?.bridge?.meetingAudioTracks === 1,
      40_000,
      'the avatar on the far end',
    );
    expect(live!.name).toBe('Leo (AI)');
    expect(live!.participant!.videoWidth / live!.participant!.videoHeight).toBeCloseTo(16 / 9, 1);
    expect(live!.bridge!.avatarConnected).toBe(true);

    // Nobody is speaking: the bot must hear silence, not its own voice coming back.
    expect(live!.bridge!.meetingAudioLevel).toBeLessThan(0.005);
    expect(live!.bridge!.msSinceMeetingAudio).toBeNull();

    // The participant speaks: the bot hears it.
    server.control.speaking = true;
    await waitFor(() => server.report, (report) => (report?.bridge?.meetingAudioLevel ?? 0) > 0.02, 10_000, 'the meeting audio in the bridge');

    expect(events.map((event) => event.type)).toEqual(['starting', 'waiting-room', 'joined', 'avatar-starting', 'avatar-live']);

    server.control.ended = 'removed';
    await expect(run).resolves.toEqual({ reason: 'meeting-ended', detail: "you've been removed from the meeting" });
  });

  it('leaves through the Leave button when told to', async () => {
    let controller: BridgeController | undefined;
    const { run, live } = start('meeting.html', { onReady: (ready) => { controller = ready; } });
    await live();
    await waitFor(() => server.report, (report) => Boolean(report?.inCall), 10_000, 'the call');
    controller!.leave();
    await expect(run).resolves.toEqual({ reason: 'left' });
    expect(server.report).toMatchObject({ leftClicked: true, inCall: false });
  });

  it('leaves on an abort signal', async () => {
    const { run, live, stop } = start('meeting.html');
    await live();
    stop.abort();
    await expect(run).resolves.toEqual({ reason: 'left' });
    expect(server.report).toMatchObject({ leftClicked: true });
  });

  it('runs in a browser profile directory, as a signed-in account would', async () => {
    const profileDir = await mkdtemp(join(tmpdir(), 'atmee-bridge-profile-'));
    try {
      const { run, stop } = start('meeting.html', { profileDir });
      await waitFor(() => server.report, (report) => showsAvatar(report) && hearsAvatar(report), 40_000, 'the avatar on the far end');
      stop.abort();
      await expect(run).resolves.toEqual({ reason: 'left' });
    } finally {
      await rm(profileDir, { recursive: true, force: true });
    }
  });

  it('leaves once nobody has spoken for long enough, and not before', async () => {
    server.control.speaking = true;
    let done = false;
    const { run, live } = start('meeting.html', { leaveAfterSilenceMs: 8_000 });
    void run.finally(() => { done = true; }).catch(() => {});
    await live();
    await new Promise((resolve) => setTimeout(resolve, 12_000));
    expect(done).toBe(false); // someone was speaking the whole time
    server.control.speaking = false;
    await expect(run).resolves.toMatchObject({ reason: 'silence' });
  });

  it.each([
    ['meeting.html?scenario=denied', 'denied'],
    ['meeting.html?scenario=invalid', 'invalid-meeting'],
    ['meeting.html?scenario=blocked', 'blocked'],
  ])('fails %s as %s', async (path, failure) => {
    const error = await start(path).run.catch((err: unknown) => err);
    expect(error).toBeInstanceOf(JoinError);
    expect(error).toMatchObject({ failure });
  });

  it('gives up when nobody admits it, without ever starting the avatar', async () => {
    const { run, events } = start('meeting.html?admitDelay=60000', { joinTimeoutMs: 4_000 });
    const error = await run.catch((err: unknown) => err);
    expect(error).toMatchObject({ failure: 'timeout', message: expect.stringContaining('admitted') });
    expect(events.map((event) => event.type)).toEqual(['starting', 'waiting-room']);
  });
});
