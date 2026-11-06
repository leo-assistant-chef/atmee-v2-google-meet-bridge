import type { Page } from 'playwright';

export type JoinFailure =
  | 'invalid-meeting'
  | 'blocked'
  | 'denied'
  | 'sign-in-required'
  | 'timeout';

export class JoinError extends Error {
  constructor(
    public readonly failure: JoinFailure,
    message: string,
  ) {
    super(message);
    this.name = 'JoinError';
  }
}

export interface JoinOptions {
  botName: string;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Called once, when the bot has asked to join and is waiting for someone to admit it. */
  onWaitingRoom?: () => void;
}

export type CallState = { inCall: true } | { inCall: false; reason: string };

/** One meeting product's web client: how to get into a call, tell that it is over, and leave. */
export interface MeetingPlatform {
  readonly id: string;
  readonly name: string;
  matches(url: URL): boolean;
  /** The URL to open for this meeting link. */
  entryUrl(url: URL): string;
  /** Resolves once the bot is in the call; throws a JoinError otherwise. The page is already at entryUrl. */
  join(page: Page, options: JoinOptions): Promise<void>;
  callState(page: Page): Promise<CallState>;
  leave(page: Page): Promise<void>;
}
