// Google Meet's web client, joined as a guest (or as whoever the browser profile is signed in as).
//
// Meet has no public API for this, so the adapter reads the page. Everything it
// depends on is in the constants below: when Meet changes its wording or markup,
// this is the place to update. The UI is forced to English with `hl=en`.
import type { Page } from 'playwright';
import { JoinError, type CallState, type JoinOptions, type MeetingPlatform } from './types.js';

const MEETING_CODE = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})\/?$/;
const LOOKUP_PATH = /^\/lookup\/[\w-]+\/?$/;

export const MEET_SELECTORS = {
  nameInput: 'input[aria-label="Your name" i], input[placeholder="Your name" i]',
  leaveButton: 'button[aria-label*="Leave call" i]',
  joinButtonName: /^(ask to join|join now|join anyway)$/i,
  dismissButtonName: /^(got it|dismiss|continue without microphone and camera)$/i,
} as const;

export const MEET_TEXT = {
  invalid: /check your meeting code|invalid video call name|couldn.t find the meeting you.re looking for/i,
  blocked: /you can.t join this video call/i,
  denied: /denied your request to join|no one responded to your request|you can.t join this call/i,
  waiting: /asking to be let in|you.ll join the call when someone lets you in|please wait until a meeting host brings you/i,
  ended: /you.ve been removed from the meeting|you were removed|you left the meeting|the meeting has ended|the call ended|ended the meeting for everyone|return to home screen/i,
} as const;

const POLL_MS = 500;
/** How long the Leave button may be missing before the call counts as over without an explanation on screen. */
const MISSING_LEAVE_GRACE_MS = 10_000;
const LEAVE_SETTLE_MS = 750;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function bodyText(page: Page): Promise<string> {
  return page.locator('body').innerText({ timeout: 2_000 }).catch(() => '');
}

async function inCall(page: Page): Promise<boolean> {
  return page.locator(MEET_SELECTORS.leaveButton).first().isVisible().catch(() => false);
}

export class GoogleMeet implements MeetingPlatform {
  readonly id = 'google-meet';
  readonly name = 'Google Meet';
  private leaveMissingSince = new WeakMap<Page, number>();

  matches(url: URL): boolean {
    return url.hostname === 'meet.google.com' && (MEETING_CODE.test(url.pathname) || LOOKUP_PATH.test(url.pathname));
  }

  entryUrl(url: URL): string {
    const entry = new URL(url.pathname, 'https://meet.google.com');
    entry.searchParams.set('hl', 'en');
    const authuser = url.searchParams.get('authuser');
    if (authuser) entry.searchParams.set('authuser', authuser);
    return entry.toString();
  }

  async join(page: Page, options: JoinOptions): Promise<void> {
    const deadline = Date.now() + options.timeoutMs;
    let asked = false;
    let announcedWaiting = false;

    while (Date.now() < deadline) {
      options.signal?.throwIfAborted();
      if (await inCall(page)) return;

      if (new URL(page.url()).hostname === 'accounts.google.com') {
        throw new JoinError('sign-in-required', 'Google asks to sign in before joining this meeting');
      }

      const text = await bodyText(page);
      if (MEET_TEXT.invalid.test(text)) throw new JoinError('invalid-meeting', 'Google Meet does not know this meeting code');
      if (MEET_TEXT.blocked.test(text)) {
        throw new JoinError('blocked', 'Google Meet refused the join ("You can\'t join this video call")');
      }
      if (asked && MEET_TEXT.denied.test(text)) throw new JoinError('denied', 'Nobody in the call admitted the bot');

      if (asked) {
        if (!announcedWaiting && MEET_TEXT.waiting.test(text)) {
          announcedWaiting = true;
          options.onWaitingRoom?.();
        }
      } else {
        const dismiss = page.getByRole('button', { name: MEET_SELECTORS.dismissButtonName }).first();
        if (await dismiss.isVisible().catch(() => false)) await dismiss.click().catch(() => {});

        const name = page.locator(MEET_SELECTORS.nameInput).first();
        if (await name.isVisible().catch(() => false) && (await name.inputValue().catch(() => '')) !== options.botName) {
          await name.fill(options.botName).catch(() => {});
        }

        const join = page.getByRole('button', { name: MEET_SELECTORS.joinButtonName }).first();
        if (await join.isVisible().catch(() => false) && await join.isEnabled().catch(() => false)) {
          await join.click();
          asked = true;
        }
      }
      await sleep(POLL_MS);
    }
    throw new JoinError(
      'timeout',
      asked ? 'Nobody admitted the bot before the join timeout' : 'The Google Meet join screen did not appear in time',
    );
  }

  async callState(page: Page): Promise<CallState> {
    if (await inCall(page)) {
      this.leaveMissingSince.delete(page);
      return { inCall: true };
    }
    const text = await bodyText(page);
    const ended = MEET_TEXT.ended.exec(text);
    if (ended) return { inCall: false, reason: ended[0].toLowerCase() };
    const since = this.leaveMissingSince.get(page) ?? Date.now();
    this.leaveMissingSince.set(page, since);
    if (Date.now() - since < MISSING_LEAVE_GRACE_MS) return { inCall: true };
    return { inCall: false, reason: 'the call is no longer on screen' };
  }

  async leave(page: Page): Promise<void> {
    const button = page.locator(MEET_SELECTORS.leaveButton).first();
    if (!(await button.isVisible().catch(() => false))) return;
    await button.click({ timeout: 3_000 }).catch(() => {});
    // Give the page time to tell the meeting, or the bot lingers there as a frozen participant.
    await button.waitFor({ state: 'hidden', timeout: 3_000 }).catch(() => {});
    await page.waitForTimeout(LEAVE_SETTLE_MS).catch(() => {});
  }
}
