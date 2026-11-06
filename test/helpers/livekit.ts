// A local LiveKit server in dev mode, and the tokens to join it.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync } from 'node:fs';

export const LIVEKIT_BIN = process.env.LIVEKIT_SERVER_BIN ?? new URL('../../.livekit/livekit-server', import.meta.url).pathname;
export const hasLiveKit = existsSync(LIVEKIT_BIN);

// livekit-server --dev accepts this key pair.
const API_KEY = 'devkey';
const API_SECRET = 'secret';
const PORT = 7880;
export const LIVEKIT_URL = `ws://127.0.0.1:${PORT}`;

const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

export function livekitToken(identity: string, room: string): string {
  const now = Math.floor(Date.now() / 1000);
  const head = encode({ alg: 'HS256', typ: 'JWT' });
  const claims = encode({
    iss: API_KEY,
    sub: identity,
    nbf: now - 10,
    exp: now + 3600,
    video: { room, roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true },
  });
  const signature = createHmac('sha256', API_SECRET).update(`${head}.${claims}`).digest('base64url');
  return `${head}.${claims}.${signature}`;
}

export async function startLiveKit(): Promise<ChildProcess> {
  const child = spawn(LIVEKIT_BIN, ['--dev', '--bind', '127.0.0.1', '--port', String(PORT)], { stdio: 'ignore' });
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`livekit-server exited with ${child.exitCode} (is port ${PORT} taken?)`);
    const up = await fetch(`http://127.0.0.1:${PORT}`).then((res) => res.ok, () => false);
    if (up) return child;
    if (Date.now() > deadline) {
      child.kill();
      throw new Error('livekit-server did not start in time');
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}
