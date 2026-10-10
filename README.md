# netwatch

A small Node.js tool that watches your internet connection every second for hours and records every time it drops, so you can show an ISP technician evidence of the 10-20 second dropouts that break Zoom / Google Meet but never show up in a quick speed test.

No `npm install` needed (Node.js only, no dependencies). macOS.

## How it works

Once per second, netwatch checks three things: your **router**, the **internet** (pings to 1.1.1.1, 8.8.8.8 and 9.9.9.9), and **upload** (a steady ~3 Mbps stream of data, like a video call). If the internet stops responding, or upload nearly stops, for **3 seconds in a row**, that is logged as a **drop** with its start time and length. If your router was still responding during the drop, the problem is outside your home (the ISP). If the router stopped responding too, the problem is inside your home (Wi-Fi or the cable to the router).

## Quick start

```bash
node netwatch.mjs
```

Leave it running. Press **Ctrl+C** to stop; it saves the final report.

```bash
node netwatch.mjs --duration 3h   # stop automatically after 3 hours
```

Use a tall terminal window (about 45 rows; maximize it). If the window is too short, the screen says so.

## What the screen shows

Top to bottom, most important first:

| Section | Meaning |
|---|---|
| **Status banner** | Green "Connection OK", or a red **DROP IN PROGRESS** with a one-sentence diagnosis. |
| **RIGHT NOW** | Whether your **router** (the box in your home) and the **internet** are reachable, how long a test message takes (ms), and your **upload** speed. |
| **EVENT LOG** | Every drop, with start and end times and the likely location of the problem. |
| **INTERNET RESPONSE TIME** graph | One bar per second: how long a test message takes to reach the internet and come back. Shorter is better. Yellow = over 300 ms. Red = no reply. |
| **UPLOAD SPEED** graph | One bar per second: how much data you are sending out (5-second average). The test aims for about 3 Mbps, the middle line. Red = upload stalled. |
| **CONNECTION STATUS** strip | One block per second: green = working, yellow = very slow, red = dropped. The right edge is "now". |

Graph scales are fixed (ping 0-300 ms, upload 0 to twice the goal), so the same bar height always means the same thing.

## What counts as a drop, and who is at fault

A **drop** is logged when the internet stops responding, or upload nearly stops, for **3 or more seconds in a row** (change with `--min-outage`).

At the same time the tool checks your router:

- Router **still responding** during the drop: the problem is **outside your home**. That points to the ISP's line or equipment.
- Router **not responding** either: the problem is **inside your home** (Wi-Fi or the cable to the router).

Plugging in with an Ethernet cable removes Wi-Fi as a variable and makes the "outside the home" conclusion stronger.

### How each check works

- **Router**: pinged. If your router ignores ping (many do), it is asked a DNS question instead. It answers `localhost` from its own memory, which proves it is alive without needing the ISP. If the router answers neither, the tool says "cannot be tested" and will not guess inside vs outside.
- **Internet**: pinged at three public servers (1.1.1.1, 8.8.8.8, 9.9.9.9). The internet counts as down only if all three fail.
- **Upload**: a steady stream of data is sent to Cloudflare's speed-test endpoint at about 3 Mbps, similar to a video call. Upload checks begin after 15 seconds of warm-up.

Note: the upload test itself adds traffic to your connection, which is deliberate (it mimics a call). Running it at a heavier rate (`--upload-mbps`) can add its own delay on a slow uplink.

## Output

Each run creates `logs/<start time>/`:

- **`report.html`**: open this in a browser and show it to the technician. It has a plain-English summary, a "how to read this" box, two labelled charts with drops shaded red, and a table of every drop. It refreshes every 60 seconds and when you press Ctrl+C.
- `samples.csv`: one row per second of raw measurements.
- `events.csv`: one row per drop or slow period.
- `run.json`: the settings used (so a rebuilt report reads the same).

## Options

```bash
node netwatch.mjs --duration 3h          # stop after a set time (e.g. 90s, 30m, 3h)
node netwatch.mjs --upload-mbps 5        # heavier upload simulation (default 3)
node netwatch.mjs --no-upload            # skip the upload test
node netwatch.mjs --min-outage 5         # require 5s of failure before it counts as a drop
node netwatch.mjs --plain                # single status line instead of the live graphs
node netwatch.mjs --report logs/<folder> # rebuild report.html from saved CSVs
node netwatch.mjs --help
```

## Tips

1. Start it **now**. Hours of data are far more convincing than a snapshot.
2. Use **Ethernet** if you can.
3. Keep the laptop plugged in. The tool runs `caffeinate` so the Mac stays awake while it runs.
4. When the technician arrives, show them `report.html` and point out: how long it ran, the number of drops, how long each lasted, and whether the router stayed reachable.

## Requirements

- macOS (uses `ping`, `route`, `caffeinate`)
- Node.js 20+
