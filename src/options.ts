// The command line and the environment, turned into what the bridge needs.
import { parseArgs } from 'node:util';
import type { VideoFit } from './protocol.js';

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export interface JoinCommand {
  command: 'join';
  meetingUrl: string;
  botName: string;
  fakeAvatar: boolean;
  apiKey?: string;
  avatarId?: string;
  apiBaseUrl?: string;
  contextFile?: string;
  language?: string;
  welcome: boolean;
  checkInAfterS?: number;
  maxDurationSeconds: number;
  joinTimeoutMs: number;
  leaveAfterSilenceMs: number;
  headless: boolean;
  profileDir?: string;
  debugDir?: string;
  fit: VideoFit;
  verbose: boolean;
}

export type Command = JoinCommand | { command: 'help' };

export const USAGE = `atmee-meet-bridge: put an Atmee video avatar into a Google Meet call

Usage:
  atmee-meet-bridge join <meeting-url> [options]

Avatar:
  --avatar-id <id>            Atmee avatar to bring (or ATMEE_AVATAR_ID)
  --bot-name <name>           Name shown in the meeting (default "Atmee Avatar (AI)")
  --context-file <path>       Text the avatar should know about this meeting
  --language <tag>            Session language, e.g. en, ja, zh-TW
  --no-welcome                The avatar waits to be spoken to instead of greeting the call
  --check-in-after <seconds>  Silence before the avatar speaks up (0 turns check-ins off)
  --fake-avatar               A synthetic avatar: tests the meeting side without an Atmee account

Limits (they cap what a forgotten bot can cost):
  --max-duration <seconds>    Longest session (default 1800)
  --leave-after-silence <s>   Leave when nobody has spoken for this long; 0 never (default 600)
  --join-timeout <seconds>    How long to wait to be admitted (default 300)

Browser:
  --headful                   Show the browser window (needs a display, e.g. xvfb-run)
  --profile-dir <path>        Chromium profile to reuse, to join as a signed-in Google account
  --fit <contain|cover>       How the avatar fills the 16:9 camera frame (default contain)
  --debug-dir <path>          Save a screenshot and the page text when joining fails

Other:
  --api-base-url <url>        Atmee API base (or ATMEE_API_BASE_URL)
  --verbose                   Debug logging on stderr
  -h, --help

The API key is read from ATMEE_API_KEY only, never from the command line.
Events are printed to stdout as JSON lines; logs go to stderr.
While it runs, stdin takes: leave | say <text> | note <text> | event <text> | state <text>
`;

function seconds(name: string, value: string | undefined, fallback: number, min = 0): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min) throw new UsageError(`--${name} must be a number of seconds >= ${min}`);
  return parsed;
}

export function parseCli(argv: string[], env: NodeJS.ProcessEnv): Command {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        'avatar-id': { type: 'string' },
        'bot-name': { type: 'string' },
        'context-file': { type: 'string' },
        language: { type: 'string' },
        'no-welcome': { type: 'boolean', default: false },
        'check-in-after': { type: 'string' },
        'fake-avatar': { type: 'boolean', default: false },
        'max-duration': { type: 'string' },
        'leave-after-silence': { type: 'string' },
        'join-timeout': { type: 'string' },
        headful: { type: 'boolean', default: false },
        'profile-dir': { type: 'string' },
        fit: { type: 'string' },
        'debug-dir': { type: 'string' },
        'api-base-url': { type: 'string' },
        verbose: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.help || positionals.length === 0) return { command: 'help' };

  const [command, meetingUrl, ...extra] = positionals;
  if (command !== 'join') throw new UsageError(`Unknown command "${command}"`);
  if (!meetingUrl) throw new UsageError('join needs a meeting URL');
  if (extra.length) throw new UsageError(`Unexpected argument "${extra[0]}"`);

  const fakeAvatar = values['fake-avatar'];
  const apiKey = env.ATMEE_API_KEY || undefined;
  const avatarId = values['avatar-id'] ?? (env.ATMEE_AVATAR_ID || undefined);
  if (!fakeAvatar) {
    if (!apiKey) throw new UsageError('ATMEE_API_KEY is not set (or pass --fake-avatar for a dry run)');
    if (!avatarId) throw new UsageError('No avatar: pass --avatar-id or set ATMEE_AVATAR_ID');
  }

  const fit = values.fit ?? 'contain';
  if (fit !== 'contain' && fit !== 'cover') throw new UsageError('--fit must be contain or cover');

  const maxDurationSeconds = seconds('max-duration', values['max-duration'], 1800, 1);
  if (maxDurationSeconds > 14_400) throw new UsageError('--max-duration cannot exceed 14400 (Atmee\'s limit)');
  const checkIn = values['check-in-after'];

  return {
    command: 'join',
    meetingUrl,
    botName: values['bot-name'] ?? 'Atmee Avatar (AI)',
    fakeAvatar,
    apiKey,
    avatarId,
    apiBaseUrl: values['api-base-url'] ?? (env.ATMEE_API_BASE_URL || undefined),
    contextFile: values['context-file'],
    language: values.language,
    welcome: !values['no-welcome'],
    checkInAfterS: checkIn === undefined ? undefined : seconds('check-in-after', checkIn, 0),
    maxDurationSeconds,
    joinTimeoutMs: seconds('join-timeout', values['join-timeout'], 300, 1) * 1000,
    leaveAfterSilenceMs: seconds('leave-after-silence', values['leave-after-silence'], 600) * 1000,
    headless: !values.headful,
    profileDir: values['profile-dir'],
    debugDir: values['debug-dir'],
    fit,
    verbose: values.verbose,
  };
}
