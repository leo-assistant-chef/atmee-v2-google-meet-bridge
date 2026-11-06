import { describe, expect, it } from 'vitest';
import { parseCli, UsageError } from '../src/options.js';

const ENV = { ATMEE_API_KEY: 'sk_atmee_test', ATMEE_AVATAR_ID: 'avatar-env' };
const URL = 'https://meet.google.com/abc-defg-hij';

describe('parseCli', () => {
  it('shows help with no arguments or --help', () => {
    expect(parseCli([], ENV)).toEqual({ command: 'help' });
    expect(parseCli(['join', URL, '--help'], ENV)).toEqual({ command: 'help' });
  });

  it('fills the defaults', () => {
    expect(parseCli(['join', URL], ENV)).toMatchObject({
      command: 'join',
      meetingUrl: URL,
      botName: 'Atmee Avatar (AI)',
      fakeAvatar: false,
      apiKey: 'sk_atmee_test',
      avatarId: 'avatar-env',
      welcome: true,
      maxDurationSeconds: 1800,
      joinTimeoutMs: 300_000,
      leaveAfterSilenceMs: 600_000,
      headless: true,
      fit: 'contain',
    });
  });

  it('takes the options', () => {
    const command = parseCli([
      'join', URL, '--avatar-id', 'avatar-flag', '--bot-name', 'Leo (AI)', '--no-welcome', '--check-in-after', '0',
      '--max-duration', '900', '--leave-after-silence', '0', '--join-timeout', '60', '--headful', '--fit', 'cover',
      '--language', 'ja', '--profile-dir', '/tmp/p', '--context-file', 'ctx.txt',
    ], ENV);
    expect(command).toMatchObject({
      avatarId: 'avatar-flag',
      botName: 'Leo (AI)',
      welcome: false,
      checkInAfterS: 0,
      maxDurationSeconds: 900,
      leaveAfterSilenceMs: 0,
      joinTimeoutMs: 60_000,
      headless: false,
      fit: 'cover',
      language: 'ja',
      profileDir: '/tmp/p',
      contextFile: 'ctx.txt',
    });
  });

  it('needs a key and an avatar, unless the avatar is fake', () => {
    expect(() => parseCli(['join', URL], {})).toThrow(/ATMEE_API_KEY/);
    expect(() => parseCli(['join', URL], { ATMEE_API_KEY: 'k' })).toThrow(/avatar/i);
    expect(parseCli(['join', URL, '--fake-avatar'], {})).toMatchObject({ fakeAvatar: true, apiKey: undefined });
  });

  it('has no way to pass the key on the command line', () => {
    expect(() => parseCli(['join', URL, '--api-key', 'sk'], ENV)).toThrow(UsageError);
  });

  it.each([
    [['leave', URL], /Unknown command/],
    [['join'], /meeting URL/],
    [['join', URL, 'extra'], /Unexpected argument/],
    [['join', URL, '--fit', 'stretch'], /--fit/],
    [['join', URL, '--max-duration', 'soon'], /--max-duration/],
    [['join', URL, '--max-duration', '0'], /--max-duration/],
    [['join', URL, '--max-duration', '20000'], /14400/],
    [['join', URL, '--leave-after-silence', '-1'], /--leave-after-silence/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseCli(argv, ENV)).toThrow(message);
  });
});
