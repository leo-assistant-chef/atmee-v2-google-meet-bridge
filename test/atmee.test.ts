import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AtmeeApiError, AtmeeClient, extractErrorCode } from '../src/atmee.js';

interface Seen { method?: string; url?: string; apiKey?: string | string[]; body: unknown }

let server: Server | undefined;

/** A stand-in for the Atmee API: answers each request with the next reply in the list. */
async function mockApi(replies: { status: number; body: unknown }[]): Promise<{ baseUrl: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  server = createServer((req: IncomingMessage, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, apiKey: req.headers['x-api-key'], body: raw ? JSON.parse(raw) : null });
      const reply = replies.shift() ?? { status: 500, body: { error: 'no_reply_left' } };
      res.writeHead(reply.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

afterEach(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()) ?? resolve());
  server = undefined;
});

const SESSION = { sessionId: 's-1', serverUrl: 'wss://example.livekit.cloud', userToken: 'token', roomName: 'rk-1' };

describe('AtmeeClient', () => {
  it('starts a session with the key in X-Api-Key and the request as JSON', async () => {
    const { baseUrl, seen } = await mockApi([{ status: 201, body: SESSION }]);
    const client = new AtmeeClient({ apiKey: 'sk_atmee_test', baseUrl: `${baseUrl}/` });
    const session = await client.createSession({ avatarId: 'a-1', maxDurationSeconds: 600, welcome: false });
    expect(session).toMatchObject(SESSION);
    expect(seen).toEqual([{
      method: 'POST',
      url: '/v1/sessions',
      apiKey: 'sk_atmee_test',
      body: { avatarId: 'a-1', maxDurationSeconds: 600, welcome: false },
    }]);
  });

  it('reports the API error code', async () => {
    const { baseUrl } = await mockApi([{ status: 409, body: { error: 'avatar_busy', message: 'busy' } }]);
    const client = new AtmeeClient({ apiKey: 'k', baseUrl });
    const error = await client.createSession({ avatarId: 'a-1' }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(AtmeeApiError);
    expect(error).toMatchObject({ status: 409, code: 'avatar_busy' });
  });

  it('retries while Atmee has no capacity, then succeeds', async () => {
    const { baseUrl, seen } = await mockApi([
      { status: 503, body: { error: { code: 'no_capacity' } } },
      { status: 503, body: { error: { code: 'no_capacity' } } },
      { status: 201, body: SESSION },
    ]);
    const retries: string[] = [];
    const client = new AtmeeClient({ apiKey: 'k', baseUrl });
    const session = await client.createSession(
      { avatarId: 'a-1' },
      { retryDelayMs: 10, capacityWaitMs: 5_000, onRetry: (_attempt, err) => retries.push(err.code) },
    );
    expect(session.sessionId).toBe('s-1');
    expect(seen).toHaveLength(3);
    expect(retries).toEqual(['no_capacity', 'no_capacity']);
  });

  it('gives up on no capacity once the wait is over', async () => {
    const { baseUrl, seen } = await mockApi([{ status: 503, body: { error: 'no_capacity' } }]);
    const client = new AtmeeClient({ apiKey: 'k', baseUrl });
    const error = await client.createSession({ avatarId: 'a-1' }, { retryDelayMs: 50, capacityWaitMs: 10 }).catch((err: unknown) => err);
    expect(error).toMatchObject({ status: 503, code: 'no_capacity' });
    expect(seen).toHaveLength(1);
  });

  it('does not retry errors other than no capacity', async () => {
    const { baseUrl, seen } = await mockApi([{ status: 402, body: { code: 'insufficient_v2_credits' } }]);
    const client = new AtmeeClient({ apiKey: 'k', baseUrl });
    const error = await client.createSession({ avatarId: 'a-1' }, { retryDelayMs: 10 }).catch((err: unknown) => err);
    expect(error).toMatchObject({ status: 402, code: 'insufficient_v2_credits' });
    expect(seen).toHaveLength(1);
  });

  it('rejects an answer that cannot be joined', async () => {
    const { baseUrl } = await mockApi([{ status: 201, body: { sessionId: 's-1' } }]);
    const client = new AtmeeClient({ apiKey: 'k', baseUrl });
    await expect(client.createSession({ avatarId: 'a-1' })).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('ends a session by id', async () => {
    const { baseUrl, seen } = await mockApi([{ status: 200, body: { alreadyEnded: false } }]);
    await new AtmeeClient({ apiKey: 'k', baseUrl }).endSession('s 1');
    expect(seen[0]).toMatchObject({ method: 'POST', url: '/v1/sessions/s%201/end', apiKey: 'k' });
  });

  it('never puts the key in an error message', async () => {
    const { baseUrl } = await mockApi([{ status: 401, body: { error: 'unauthorized' } }]);
    const error = await new AtmeeClient({ apiKey: 'sk_atmee_secret', baseUrl }).createSession({ avatarId: 'a' }).catch((err: unknown) => err);
    expect(String((error as Error).message)).not.toContain('sk_atmee_secret');
  });

  it('refuses to be built without a key', () => {
    expect(() => new AtmeeClient({ apiKey: '' })).toThrow(/API key/);
  });
});

describe('extractErrorCode', () => {
  it.each([
    ['{"error":"avatar_busy"}', 'avatar_busy'],
    ['{"error":{"code":"no_capacity","message":"x"}}', 'no_capacity'],
    ['{"code":"invalid_request"}', 'invalid_request'],
    ['{"message":"nope"}', 'http_500'],
    ['<html>bad gateway</html>', 'http_500'],
    ['', 'http_500'],
  ])('reads %s as %s', (body, code) => {
    expect(extractErrorCode(500, body)).toBe(code);
  });
});
