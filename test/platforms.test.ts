import { describe, expect, it } from 'vitest';
import { buildNotes, chunkNotes } from '../src/bridge.js';
import { detectPlatform } from '../src/platforms/index.js';

describe('detectPlatform', () => {
  it.each([
    'https://meet.google.com/abc-defg-hij',
    'meet.google.com/abc-defg-hij',
    'https://meet.google.com/abc-defg-hij?authuser=1&pli=1',
    'https://meet.google.com/lookup/team-standup',
  ])('takes %s as Google Meet', (link) => {
    expect(detectPlatform(link)?.platform.id).toBe('google-meet');
  });

  it.each([
    'https://meet.google.com/',
    'https://meet.google.com/landing',
    'https://meet.google.com/abc-defg-hij/extra',
    'https://meet.google.com.evil.example/abc-defg-hij',
    'https://evil.example/meet.google.com/abc-defg-hij',
    'https://zoom.us/j/123456789',
    'not a url at all',
    '',
  ])('turns %j away', (link) => {
    expect(detectPlatform(link)).toBeNull();
  });

  it('opens the meeting in English and keeps the account choice only', () => {
    const detected = detectPlatform('https://meet.google.com/abc-defg-hij?authuser=1&pli=1&foo=bar')!;
    expect(detected.platform.entryUrl(detected.url)).toBe('https://meet.google.com/abc-defg-hij?hl=en&authuser=1');
  });
});

describe('chunkNotes', () => {
  it('keeps short text as one note', () => {
    expect(chunkNotes('One.\n\nTwo.')).toEqual(['One.\n\nTwo.']);
  });

  it('is empty for blank text', () => {
    expect(chunkNotes('  \n\n ')).toEqual([]);
  });

  it('splits on paragraphs, never past the limit', () => {
    expect(chunkNotes('aaaa\n\nbbbb\n\ncccc', 10)).toEqual(['aaaa\n\nbbbb', 'cccc']);
  });

  it('splits a long paragraph on words, and a long word by force', () => {
    const notes = chunkNotes(`${'word '.repeat(10)}${'x'.repeat(25)}`, 12);
    expect(notes.every((note) => note.length <= 12)).toBe(true);
    expect(notes.join(' ').replace(/\s+/g, '')).toBe(`${'word'.repeat(10)}${'x'.repeat(25)}`);
  });
});

describe('buildNotes', () => {
  it('tells the avatar where it is, then the context', () => {
    const notes = buildNotes('Google Meet', 'Leo', 'Weekly sync with the design team.');
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain('Google Meet video call as "Leo"');
    expect(notes[1]).toBe('Weekly sync with the design team.');
  });
});
