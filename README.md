# atmee-v2-google-meet-bridge

Put an [Atmee](https://www.atmee.ai) real-time video avatar into a Google Meet call.

Atmee avatars live in a LiveKit room that a web page joins; they do not join Zoom or
Google Meet calls themselves. This bridge is the missing piece: a bot that joins the
meeting as a participant whose camera and microphone *are* the avatar, and that feeds
what the meeting says back to the avatar so it can answer.

Unofficial, and not affiliated with Atmanity or Google.

## Status

Early (v0.1). What has been verified, and what has not:

| | |
|---|---|
| Avatar video and voice reach the other participants | Tested end to end in Chromium over real WebRTC |
| Meeting voices reach the avatar, without the avatar hearing itself | Tested end to end |
| The Atmee session flow (`POST /v1/sessions`, LiveKit room, notes, typed turns, transcripts, session end) | Tested against a real LiveKit server with a mock Atmee API and a stand-in avatar |
| The bridge's injection on the real Google Meet site | Verified: Meet loads, asks for camera and microphone, and gets the avatar's |
| Joining a real Google Meet call (name, "Ask to join", admission, leaving) | Written from Meet's current UI and tested against a mock of it. **Not yet run in a live call** |
| A session with the real Atmee API | **Not yet run**: needs an Atmee API key |

Zoom is not supported yet (see [Roadmap](#roadmap)).

## How it works

```
        Atmee API                    LiveKit room                 headless Chromium                Google Meet
  POST /v1/sessions  ──────►  avatar video + voice  ──────►  virtual camera + mic   ──────►  other participants
                              visitor microphone    ◄──────  mix of the meeting's   ◄──────  see and hear the
                                                             remote audio                    avatar, and talk
```

1. A headless Chromium opens the meeting link. A script injected before the page loads
   replaces `getUserMedia`, so the meeting gets a canvas-backed camera and a WebAudio
   microphone instead of real devices, and taps the remote audio of the meeting's
   peer connections.
2. The bot types its name and asks to join. Until someone admits it, the camera shows a
   placeholder card and **no Atmee session exists**, so waiting costs nothing.
3. Once admitted, the bridge starts the Atmee session from Node (the API key never
   reaches the browser) and the page joins the session's LiveKit room. The avatar's
   video is drawn into the camera, its voice goes to the microphone, and the mixed
   meeting audio is published to the room as the visitor's microphone.
4. When the meeting ends, the bot is removed, the session runs out, or you tell it to
   leave, it leaves the call and ends the Atmee session.

## Quick start

Needs Node 22.12 or newer.

```bash
git clone https://github.com/leo-assistant-chef/atmee-v2-google-meet-bridge
cd atmee-v2-google-meet-bridge
npm install
npx playwright install chromium     # add --with-deps on a fresh Linux machine
npm run build
```

Try the meeting side first, with a synthetic avatar (a magenta screen and a tone). It
needs no Atmee account and spends no credits:

```bash
node dist/cli.js join https://meet.google.com/abc-defg-hij --fake-avatar --bot-name "Test bot"
```

Admit the bot in the meeting; you should see the magenta video and hear the tone.

Then with a real avatar. Create an API key in [Atmee Studio](https://www.atmee.ai/studio/api-keys)
with the `sessions` scope, and take the id of a finished avatar:

```bash
cp .env.example .env                # fill in ATMEE_API_KEY and ATMEE_AVATAR_ID
node dist/cli.js join https://meet.google.com/abc-defg-hij \
  --bot-name "Leo (AI)" \
  --context-file meeting-notes.txt
```

The avatar's look, voice and personality are the avatar's own, set in Atmee Studio or
through the Atmee API. `--context-file` adds what it should know about this particular
meeting.

## Options

```
Avatar:
  --avatar-id <id>            Atmee avatar to bring (or ATMEE_AVATAR_ID)
  --bot-name <name>           Name shown in the meeting (default "Atmee Avatar (AI)")
  --context-file <path>       Text the avatar should know about this meeting
  --language <tag>            Session language, e.g. en, ja, zh-TW
  --no-welcome                The avatar waits to be spoken to instead of greeting the call
  --check-in-after <seconds>  Silence before the avatar speaks up (0 turns check-ins off)
  --fake-avatar               A synthetic avatar: tests the meeting side without an Atmee account

Limits:
  --max-duration <seconds>    Longest session (default 1800)
  --leave-after-silence <s>   Leave when nobody has spoken for this long; 0 never (default 600)
  --join-timeout <seconds>    How long to wait to be admitted (default 300)

Browser:
  --headful                   Show the browser window (needs a display, e.g. xvfb-run)
  --profile-dir <path>        Chromium profile to reuse, to join as a signed-in Google account
  --fit <contain|cover>       How the avatar fills the 16:9 camera frame (default contain)
  --debug-dir <path>          Save a screenshot and the page text when joining fails
```

The API key is read from `ATMEE_API_KEY` (environment or `.env`) only, never from the
command line, where it would show up in process lists and shell history.

### Cost guards

A session is billed by Atmee per minute while it runs (see
[Atmee's pricing](https://www.atmee.ai/docs/api/overview)). A bot forgotten in an empty
meeting would keep spending, so two limits are on by default: the session is capped at
30 minutes (`--max-duration`), and the bot leaves after 10 minutes in which nobody spoke
(`--leave-after-silence`). Raise them for longer meetings. The session is ended on every
exit path, including `Ctrl+C` and `SIGTERM`.

## Driving it from a program

Events are printed to stdout, one JSON object per line. Logs go to stderr.

```json
{"type":"starting","platform":"google-meet"}
{"type":"waiting-room"}
{"type":"joined"}
{"type":"avatar-starting"}
{"type":"avatar-live","sessionId":"550e8400-…"}
{"type":"transcript","speaker":"meeting","text":"Can you summarise the last sprint?"}
{"type":"transcript","speaker":"avatar","text":"Sure. Three things shipped…"}
{"type":"ended","reason":"meeting-ended","detail":"you left the meeting"}
```

`ended.reason` is one of `meeting-ended`, `left`, `avatar-session-ended`, `silence`,
`max-duration`, `browser-closed`. A failure prints `{"type":"error","code":…}` instead.

While the bot is in the call, it takes commands on stdin, one per line:

| Command | Effect |
|---|---|
| `leave` | Leave the meeting and end the session |
| `say <text>` | A typed turn: the avatar answers it out loud |
| `note <text>` | Something the avatar should keep in mind for the rest of the session |
| `state <text>` | What is true right now; replaces the previous state |
| `event <text>` | Something that just happened; the avatar remarks on it in its own words |

Exit codes: `0` the call ended normally, `2` bad usage, `3` could not join the meeting,
`4` the Atmee API refused, `1` anything else.

It is also a library:

```ts
import { AtmeeClient, runBridge } from 'atmee-v2-google-meet-bridge';

const result = await runBridge({
  meetingUrl: 'https://meet.google.com/abc-defg-hij',
  botName: 'Leo (AI)',
  avatar: { kind: 'atmee', client: new AtmeeClient({ apiKey: process.env.ATMEE_API_KEY! }), avatarId: '…' },
  maxDurationSeconds: 1800,
  joinTimeoutMs: 300_000,
  leaveAfterSilenceMs: 600_000,
  headless: true,
  onEvent: console.log,
  onReady: (bot) => { /* bot.say(…), bot.send(…), bot.leave() */ },
});
```

## Good to know

- **Tell people.** The bot joins as a visible participant and the host has to admit it,
  but it is still a synthetic person in a call with real ones. Give it a name that says
  so (the default ends in "(AI)") and make sure participants know.
- **Guest joins can be refused.** Google sometimes turns anonymous guests away
  ("You can't join this video call"), and some organisations do not allow guests at all.
  Signing in helps: run once with `--headful --profile-dir .profile`, sign in to a Google
  account in the window, and reuse `--profile-dir .profile` afterwards.
- **Meet's UI changes.** Meet has no API for joining as a participant, so the adapter
  reads the page. Everything it depends on is in the constants at the top of
  [`src/platforms/google-meet.ts`](src/platforms/google-meet.ts). When a join fails,
  `--debug-dir` saves a screenshot and the page text to make the fix quick.
- **It needs a real CPU.** One machine decodes the avatar's video, composites it and
  encodes it again for the meeting, in software if there is no GPU. Give it two or more
  cores.
- **The avatar hears one mixed voice.** Everyone in the meeting arrives on a single
  audio channel, so the avatar cannot tell speakers apart.

## Roadmap

- A shakedown in a live Google Meet call and against the real Atmee API.
- Zoom. Its web client does not play remote audio through plain WebRTC tracks, so it
  needs its own audio tap as well as its own join flow.
- Vision: publish the meeting's active speaker video as the visitor's camera, so
  avatars that can see react to who is talking.
- Atmee's Avatar-only mode (`POST /v1/avatar_sessions`), so an existing voice agent can
  bring its own brain and use Atmee only for the face.

## Development

```bash
npm run lint
npm run typecheck
npm test                              # builds, then runs everything
./scripts/get-livekit-server.sh       # once: enables the LiveKit end-to-end test
```

The tests run the real bridge in headless Chromium:

- `test/bridge.e2e.test.ts` joins a mock meeting (`test/fixtures/meeting.html`) that has
  Meet's affordances and a second participant on the other end of a real WebRTC call.
  That participant measures the colour of the video and the pitch of the audio it
  receives, and speaks a tone of its own for the bot to hear.
- `test/bridge.livekit.e2e.test.ts` adds a local LiveKit server, a mock Atmee API and a
  stand-in avatar, to cover the path a real Atmee session takes. It is skipped when the
  LiveKit server has not been downloaded.

## License

MIT
