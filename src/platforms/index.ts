import { GoogleMeet } from './google-meet.js';
import type { MeetingPlatform } from './types.js';

export * from './types.js';
export { GoogleMeet } from './google-meet.js';

export const PLATFORMS: readonly MeetingPlatform[] = [new GoogleMeet()];

/** The platform that handles this meeting link, with the link parsed; null when none does. */
export function detectPlatform(link: string): { platform: MeetingPlatform; url: URL } | null {
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(link) ? link : `https://${link}`);
  } catch {
    return null;
  }
  const platform = PLATFORMS.find((candidate) => candidate.matches(url));
  return platform ? { platform, url } : null;
}
