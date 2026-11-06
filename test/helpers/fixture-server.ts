// Serves the mock meeting, and is the test's line to it: the page polls
// /control for what should happen and posts what it measures to /report.
import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize } from 'node:path';
import type { BridgeStats } from '../../src/protocol.js';

export interface Measurement {
  videoWidth: number;
  videoHeight: number;
  color: { r: number; g: number; b: number } | null;
  audioLevel: number;
  audioHz: number;
}

export interface MeetingReport {
  name: string;
  inCall: boolean;
  leftClicked: boolean;
  bridge: BridgeStats | null;
  participant: Measurement | null;
}

export interface Control {
  speaking: boolean;
  ended: null | 'removed' | 'ended';
}

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript' };

export class FixtureServer {
  control: Control = { speaking: false, ended: null };
  report: MeetingReport | null = null;
  /** Extra directories searched for static files after test/fixtures. */
  readonly extraRoots: string[] = [];
  /** Reports posted to /report?kind=<name> by pages other than the meeting. */
  readonly otherReports = new Map<string, unknown>();
  private server: Server | undefined;
  private readonly root = new URL('../fixtures/', import.meta.url).pathname;

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/control') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(this.control));
        return;
      }
      if (url.pathname === '/report' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => { body += chunk; });
        req.on('end', () => {
          const kind = url.searchParams.get('kind');
          if (kind) this.otherReports.set(kind, JSON.parse(body));
          else this.report = JSON.parse(body) as MeetingReport;
          res.writeHead(204).end();
        });
        return;
      }
      const relative = normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
      void this.serveFile(relative).then((file) => {
        if (!file) return void res.writeHead(404).end('not found');
        res.writeHead(200, { 'Content-Type': TYPES[extname(relative)] ?? 'application/octet-stream' }).end(file);
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  private async serveFile(relative: string): Promise<Buffer | null> {
    for (const root of [this.root, ...this.extraRoots]) {
      try {
        return await readFile(join(root, relative));
      } catch {
        // try the next root
      }
    }
    return null;
  }

  reset(): void {
    this.control = { speaking: false, ended: null };
    this.report = null;
    this.otherReports.clear();
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }
}

/** Polls until the predicate holds; throws with the last value seen when it never does. */
export async function waitFor<T>(read: () => T, ok: (value: T) => boolean, timeoutMs = 20_000, what = 'condition'): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (ok(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}
