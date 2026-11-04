# MotionDJ

**English** · [Español](README.es.md)

> **Your hands are the controller.** A two-deck web DJ console you play with hand gestures in front of a webcam, with stems powered by **Meta Demucs v4**.

Built during the **Meta Global AI Developer Hackathon**.

📖 **[Full user guide](docs/GUIDE.md)**, for beginners and experienced DJs. It is also inside the app under **? Ayuda → Guía de uso**.

> The interface is in Spanish. Labels you will see: **FRENO** = brake, **SUBIDA** = build-up, **FILTRO** = filter, **ECO** = echo, **VOZ / BATERÍA / BAJO / RESTO** = vocals / drums / bass / other, **FÁCIL** = easy view.

## The problem

Becoming a DJ has a high barrier to entry:

- **Expensive gear.** A basic used controller costs around US$200; a professional setup costs thousands.
- **Complex software full of jargon.** Cue, sync, EQ, quantize… it scares off anyone starting out.
- **The most exciting features are paid.** Stems and per-part effects sit behind licenses and subscriptions.

So most people never try mixing. At a party, the music stays a playlist that plays by itself.

## Vision

**Anyone can be a DJ.** No gear to buy, nothing to install, no music knowledge needed: open the app, raise your hands and mix. The only thing between a person and their first mix should be the music they love.

## The solution

MotionDJ turns a computer with a webcam into a DJ booth. Your hands replace the console, and every gesture is a physical metaphor you understand without explanation:

| Gesture | What happens |
|---|---|
| ✋ "Stop" palm | The song **brakes** like vinyl |
| ☝️✌️🤟 Count fingers | **Rolls** the beat: more fingers, faster |
| ✊ Fist, then 👍 thumbs up | **Grab** the song and **throw** it to the other deck with echo |
| 🙌 Raise both hands, then 🙏 press palms together | **Build the tension** and release the **drop** |
| 🤏 Stretch with both hands | Opens and closes the **filter** like a string |
| 🤏 Pinch a part | Mutes or unmutes the **vocals, drums or bass** |

## Why it's fun

- **You learn it in seconds.** Gestures look like what they do: braking is saying "stop", throwing is throwing.
- **It sounds good even if you don't know how.** Everything lands on the beat or the bar, so a late gesture never breaks the mix.
- **It's a show.** Mixing with your hands in the air looks amazing at a party or on video.
- **Training wheels included:** easy view, Auto DJ, one-button "match and mix", and demo tracks to try without your own music.

## Why it's professional too

- **Stems with Meta AI.** Meta Demucs v4 splits every song into vocals, drums, bass and other. Each effect can target a single part: roll only the drums, throw only the vocals.
- **Beat grid and phase-aligned SYNC.** Effects are quantized to the beat and the bar.
- **A full console:** jog wheel that scrubs with audio forward and backward, EQ, filter, limiter, clipping and "two bass lines" warnings, hot cues and loops.
- **Headphone cue** on a separate output, like a real booth.
- **Record your mix** to share it.

## Details made for DJs

**In hand mode**

- **The string filter moves the knob you choose.** Switch from FILTER to **HIGH, MID, LOW, TRIM or ECHO**: pull the pinches apart and that knob goes up, bring them together and it goes down. Cut lows or highs with your hands, like in a real mix.
- **Each effect targets one part of the song** (with stems): **ROLL** only the drums while the vocals stay clean; **ECHO** on the vocals by default for an echoed acapella throw; **BRAKE** everything except the vocals (**MÚSICA**), or a single part.
- **The echo throw is a full transition.** Thumbs up and the current deck cuts on the beat while the other one enters **on that same beat, tempo matched**. A second fist controls how long the echo tail lasts. Throw A → B and back to A without taking your hands away.
- **The track keeps running under every effect.** Release ROLL or BRAKE and the song returns **on the beat, exactly where it would have been**, without losing the phrase (*slip*).
- **The DROP waits for the next bar.** Even if you press your palms together late, it lands on the bar.

**In the console**

- **Pinch grabs a control without jumps.** The fader or knob moves from where it is, not to where your hand is.
- **Per-deck lineup.** Build the A and B queues with **+A / +B**. When a deck becomes free its next track loads by itself, never over a track you prepared.
- **"Two bass lines" warning** when both decks play with the lows up, the classic beginner mistake.
- **Limiter with a measured ceiling and a clipping warning**, so the mix never distorts.
- **Phase-aligned SYNC** on the beat grid, and a jog that scrubs **with audio forward and backward** to find the entry point by ear.
- **Hands don't get mixed up when they cross.** Each hand keeps its identity, so two-hand gestures never flip.

## Advantages

- **Free and open source.**
- **No hardware:** just a browser and a webcam. Also works with mouse, keyboard and touch.
- **Private:** your music never leaves your computer. The AI (Meta Demucs, open weights) runs on your own GPU.
- **Works offline.**

## Who it's for

- **Beginners:** their first mix in minutes.
- **Party hosts:** the music stops being a playlist that plays by itself.
- **Content creators:** a visual show to record.
- **DJs:** a new way to perform, with gesture effects no console has.

## Quick start

1. Open the app and click **? Ayuda → Inicio guiado** (guided start): enable audio, load the demos or your music, enable the camera.
2. **Beginners:** click **FÁCIL**, load a song on A and press PLAY, load another on B, click **Igualar y mezclar** (match and mix).
3. **Hands:** click **MANOS · FX** on the playing deck, pinch an effect, and play. Take both hands out of view to leave.
4. **DJs:** click **DJ** for the full console: SYNC, EQ, jog, pads, lineup and headphone cue.

Everything else is in the **[full guide](docs/GUIDE.md)**.

## How Meta Demucs is used

1. When you load a track, the app sends it to a small local server (`stems-server/`, `127.0.0.1:8765`).
2. The server runs **Meta Demucs v4 (`htdemucs`)** and separates it into 4 stems (about 13 s per song on an RTX 3060 Ti).
3. The browser plays the 4 stems in sync through Web Audio. Every hand effect can target one stem: roll only the drums, echo only the vocals, brake everything except the vocals, mute or unmute parts on the beat.

Everything stays on your machine: your songs and the stems cache are never uploaded anywhere. If the server is not running, MotionDJ works the same with the full track.

## Run it

Requirements: Node.js 20+ and Chrome or Edge (Web Audio + `getUserMedia`). **No internet needed**: the hand-tracking model and its WASM are bundled in the project.

```powershell
npm install
npm run dev
```

Open http://127.0.0.1:5173, click **Activar audio** (enable audio), then **Cargar demos** (two tracks generated by the app itself, no copyrighted music) or import your own music. Your files are processed in your browser and never leave your computer.

### Optional: stems server (Meta Demucs)

Requires Python 3.10+, [Demucs](https://github.com/facebookresearch/demucs) 4.x and PyTorch (a CUDA GPU is recommended; CPU works but is slow).

```powershell
python -m venv venv
.\venv\Scripts\pip install demucs torch torchaudio
.\venv\Scripts\python stems-server\server.py --cache .\stems-cache
```

Options: `--host`, `--port`, `--cache`, `--device` (`cuda` or `cpu`). `stems-server/start.ps1` is the author's launcher with local paths. API details in [stems-server/README.md](stems-server/README.md).

For a static build: `npm run build` creates `dist/` (works on Vercel, Netlify or any static host; the camera requires HTTPS or localhost).

## What is estimated or limited

- **BPM is estimated** by our own analysis. SYNC matches the effective BPM and aligns the phase to that grid; it is not infallible beatmatching.
- Tempo also changes pitch (no time-stretch).
- The webcam sees hands in 2D: no depth and no real contact.
- No key detection and no microphone.

## Tests

```powershell
npm test
npm run build
```

Pure-logic tests (beat grid, SYNC, echo, scrub, gestures, roll, brake, build-up, queues…) plus in-browser checks without a camera. What can only be validated with a webcam and ears is listed in `docs/pruebas.md`.

## Tech stack

- **Meta Demucs v4** (`htdemucs`, MIT): local stem separation on GPU
- **MediaPipe Hand Landmarker** (Apache-2.0, Google): 21 landmarks per hand, bundled in `public/mediapipe/`
- **Web Audio API** + AudioWorklet: all mixing, effects and scrubbing in the browser
- **Vite** (MIT): build only; the app is vanilla JavaScript

The rest is original code and sound synthesis; details in `docs/licencias.md`. Project docs (in Spanish) are in `docs/`.
