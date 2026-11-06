#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { AtmeeApiError, AtmeeClient } from './atmee.js';
import { BridgeError, runBridge, type BridgeController, type LogLevel } from './bridge.js';
import { parseCli, UsageError, USAGE, type JoinCommand } from './options.js';
import { detectPlatform, JoinError } from './platforms/index.js';

const EXIT = { ok: 0, failed: 1, usage: 2, join: 3, atmee: 4 } as const;

function print(event: object): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

/** Lines on stdin drive the bot while it is in the call. */
function listenForCommands(controller: BridgeController, log: (level: LogLevel, message: string) => void): void {
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    const [, verb = '', text = ''] = /^\s*(\S+)\s*(.*)$/.exec(line) ?? [];
    const run = async () => {
      if (verb === 'leave') return controller.leave();
      if (!text) throw new Error(`"${verb}" needs text`);
      if (verb === 'say') return controller.say(text);
      if (verb === 'note' || verb === 'event' || verb === 'state') return controller.send({ type: verb, text });
      throw new Error(`unknown command "${verb}"`);
    };
    if (verb) run().catch((err: unknown) => log('warn', `stdin: ${(err as Error).message}`));
  });
}

async function join(command: JoinCommand): Promise<number> {
  if (!detectPlatform(command.meetingUrl)) {
    throw new UsageError(`Not a supported meeting link: ${command.meetingUrl} (Google Meet links look like https://meet.google.com/abc-defg-hij)`);
  }
  const log = (level: LogLevel, message: string) => {
    if (level === 'debug' && !command.verbose) return;
    process.stderr.write(`[${level}] ${message}\n`);
  };
  const context = command.contextFile ? await readFile(command.contextFile, 'utf8') : undefined;

  const stop = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM'] as const) {
    process.once(name, () => {
      log('info', `${name}: leaving the meeting`);
      stop.abort();
    });
  }

  const result = await runBridge({
    meetingUrl: command.meetingUrl,
    botName: command.botName,
    avatar: command.fakeAvatar
      ? { kind: 'fake' }
      : {
        kind: 'atmee',
        client: new AtmeeClient({ apiKey: command.apiKey!, baseUrl: command.apiBaseUrl }),
        avatarId: command.avatarId!,
        language: command.language,
        welcome: command.welcome,
        checkInAfterS: command.checkInAfterS,
      },
    context,
    maxDurationSeconds: command.maxDurationSeconds,
    joinTimeoutMs: command.joinTimeoutMs,
    leaveAfterSilenceMs: command.leaveAfterSilenceMs,
    headless: command.headless,
    profileDir: command.profileDir,
    debugDir: command.debugDir,
    video: { fit: command.fit },
    signal: stop.signal,
    onEvent: print,
    onReady: (controller) => listenForCommands(controller, log),
    log,
  });
  print({ type: 'ended', ...result });
  return EXIT.ok;
}

async function main(): Promise<number> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  try {
    const command = parseCli(process.argv.slice(2), process.env);
    if (command.command === 'help') {
      process.stdout.write(USAGE);
      return EXIT.ok;
    }
    return await join(command);
  } catch (err) {
    const error = err as Error;
    if (err instanceof UsageError) {
      process.stderr.write(`${error.message}\n\nRun "atmee-meet-bridge --help" for usage.\n`);
      return EXIT.usage;
    }
    if (err instanceof JoinError) {
      print({ type: 'error', code: `join-${err.failure}`, message: error.message });
      return EXIT.join;
    }
    if (err instanceof AtmeeApiError) {
      print({ type: 'error', code: `atmee-${err.code}`, message: error.message });
      return EXIT.atmee;
    }
    print({ type: 'error', code: err instanceof BridgeError ? err.code : 'failed', message: error.message });
    return EXIT.failed;
  }
}

// Not process.exit: stdout may still hold the last events.
main().then((code) => {
  process.exitCode = code;
  process.stdin.destroy();
});
