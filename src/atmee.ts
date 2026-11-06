// A minimal client for the part of the Atmee API the bridge needs:
// start a Behavior-driven Full-stack session, and end it.
// https://www.atmee.ai/docs/api/reference/session/createSession

export const DEFAULT_ATMEE_BASE_URL = 'https://api.atmanity.us';

export interface CreateSessionRequest {
  avatarId: string;
  maxDurationSeconds?: number;
  language?: string;
  welcome?: boolean;
  checkInAfterS?: number;
  metadata?: Record<string, unknown>;
}

export interface AtmeeSession {
  sessionId: string;
  serverUrl: string;
  userToken: string;
  roomName?: string;
  actualDurationSeconds?: number;
  durationCapped?: boolean;
  billingMode?: string;
}

export class AtmeeApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AtmeeApiError';
  }
}

export interface AtmeeClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export interface CreateSessionOptions {
  /** How long to keep retrying a 503 (no capacity) before giving up. */
  capacityWaitMs?: number;
  retryDelayMs?: number;
  signal?: AbortSignal;
  onRetry?: (attempt: number, error: AtmeeApiError) => void;
}

const START_TIMEOUT_MS = 120_000; // the API answers only once the avatar is in the room
const END_TIMEOUT_MS = 15_000;

/** The error code out of the shapes an error body may take; the status when there is none. */
export function extractErrorCode(status: number, body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      const nested = record.error;
      if (typeof nested === 'string') return nested;
      if (nested && typeof nested === 'object') {
        const code = (nested as Record<string, unknown>).code;
        if (typeof code === 'string') return code;
      }
      if (typeof record.code === 'string') return record.code;
    }
  } catch {
    // not JSON: fall through to the status
  }
  return `http_${status}`;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });

export class AtmeeClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AtmeeClientOptions) {
    if (!options.apiKey) throw new Error('An Atmee API key is required');
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_ATMEE_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async post(path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Api-Key': this.apiKey },
      body: JSON.stringify(body ?? {}),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const text = await response.text();
    if (!response.ok) {
      const code = extractErrorCode(response.status, text);
      throw new AtmeeApiError(response.status, code, `Atmee API ${path} failed: ${response.status} ${code}`);
    }
    return text ? JSON.parse(text) : {};
  }

  async createSession(request: CreateSessionRequest, options: CreateSessionOptions = {}): Promise<AtmeeSession> {
    const { capacityWaitMs = 120_000, retryDelayMs = 5_000, signal, onRetry } = options;
    const deadline = Date.now() + capacityWaitMs;
    for (let attempt = 1; ; attempt++) {
      try {
        const data = (await this.post('/v1/sessions', request, START_TIMEOUT_MS, signal)) as Partial<AtmeeSession>;
        if (typeof data.sessionId !== 'string' || typeof data.serverUrl !== 'string' || typeof data.userToken !== 'string') {
          throw new AtmeeApiError(502, 'invalid_response', 'Atmee API answered without sessionId, serverUrl or userToken');
        }
        return data as AtmeeSession;
      } catch (err) {
        const retryable = err instanceof AtmeeApiError && err.status === 503;
        if (!retryable || Date.now() + retryDelayMs > deadline) throw err;
        onRetry?.(attempt, err);
        await sleep(retryDelayMs, signal);
      }
    }
  }

  /** Idempotent: safe to call from every teardown path. */
  async endSession(sessionId: string): Promise<void> {
    await this.post(`/v1/sessions/${encodeURIComponent(sessionId)}/end`, {}, END_TIMEOUT_MS);
  }
}
