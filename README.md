# Demo Cut

[![Install with Pinokio](https://badges.pinokio.co/install.svg)](https://pinokio.co/resolve?url=https://github.com/cocktailpeanut/demo-cut)

Turn a screen recording into a focused demo. Pause the recording, click what matters, adjust the timing and zoom strength, then export an MP4 with smooth zooms in and out. Demo Cut runs locally in your browser and keeps the recording's audio.

## Start with Pinokio

1. Open **Demo Cut** in Pinokio and click **Install**. Setup checks Node.js, FFmpeg, and FFprobe; if the media tools are missing, it installs FFmpeg through Pinokio's Conda environment.
2. Click **Start**. Pinokio opens the running app at its assigned local URL.
3. To stop it, use Pinokio's built-in stop control for the Start script.

**Update** pulls source changes when this project has a Git upstream, then checks setup again. For an unpublished local project, it keeps the current source and checks setup. **Reset setup** clears the setup marker so Install can run again; it keeps recordings, focus points, exports, and source code.

## Make a demo

1. Drop a recording onto the editor or choose **Import video**. MP4, MOV, WebM, and other formats supported by the installed FFmpeg can be imported, up to 2 GB per file. The app prepares a browser-compatible preview before opening the recording.
2. Scrub to the moment you want to highlight and pause. In **Edit focus**, click the area to emphasize, or use **Add focus** to place a point in the center.
3. Adjust **Zoom strength**, **Starts at**, and **Duration** in the inspector. Duration includes both the zoom-in and zoom-out. Use **Reposition focus** to change the target.
4. Choose **Preview zooms** and play the result. Press **Space** to play or pause. Muting the preview does not remove audio from the export.
5. Click **Export MP4**, wait for the render, then **Download MP4**. You can cancel an export while it is waiting or rendering.

Each focus point eases in for up to 0.6 seconds, holds, then eases back out. Short intervals split their duration equally between in and out. Intervals cannot overlap; shorten or move one if the editor reports a conflict. A recording supports up to 100 focus points and zoom strengths from 1.1× to 4×.

## Files, picture, and audio

- Recordings and edits remain on this computer in `app/data/videos/`. Each recording has its untouched uploaded source, a normalized preview, and its saved focus points. Exports are stored in `app/data/exports/` as well as wherever you download them.
- The editor and export use the same smooth zoom curve. Focus near an edge is clamped to the picture so a zoom never exposes empty space outside it.
- The output is H.264 MP4 with the recording's displayed orientation and frame shape. Inputs are converted to square pixels. Odd dimensions receive up to one pixel of padding for H.264 compatibility. Frame rate is normalized to a constant rate between 1 and 60 fps, based on the source rate.
- The first audio track is kept. AAC audio is copied; other audio codecs are converted to AAC during import. The prepared audio track is then copied into the final export without another audio encode. Silent recordings remain silent. Additional audio tracks and subtitles are not exported.
- Video is encoded during preview preparation and, when zooms are present, again during export. The result is not a bit-for-bit copy of the original. Exporting without focus points copies the prepared preview.
- No cloud service or account is used for editing or rendering. Install may access Conda if required media tools are missing; Update may contact the configured Git upstream.

Data is excluded from Git. To reclaim space, stop Demo Cut and remove recordings or exports you no longer need from `app/data/`; deleting a recording folder also deletes its saved edits. Reset setup does not perform this deletion.

## Run without Pinokio

Install Node.js 20 or newer and an FFmpeg build containing `libx264`, `aac`, and `zoompan`, with `ffprobe` available. Then:

```sh
cd app
node setup.mjs
node server.mjs
```

Open the printed URL. The server binds to `127.0.0.1` and chooses a free port unless `PORT` is set. There are no npm dependencies. Optional environment variables are `PORT`, `FFMPEG_PATH`, `FFPROBE_PATH`, and `DEMO_CUT_DATA` (an alternative data directory).

## Local API

Use the running URL shown by Pinokio as `BASE`. The examples below use `http://127.0.0.1:42004`; your port may differ. Error responses contain an `error` string. Upload bodies contain the raw file bytes, not multipart form data.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | App health and version |
| GET | `/api/videos` | List imported recordings and their saved points |
| POST | `/api/videos?name=recording.mp4` | Upload and prepare a recording; returns its metadata |
| GET | `/api/videos/:id` | Read recording metadata and points |
| GET | `/api/videos/:id/media` | Play the prepared MP4; supports byte ranges |
| PUT | `/api/videos/:id/project` | Save `{ "points": [...] }` |
| POST | `/api/exports` | Start an export with `{ "videoId": "...", "points": [...] }`; returns `{ "id": "..." }` |
| GET | `/api/exports/:id` | Read `status`, `progress` (0–1), and the completed download `url` |
| DELETE | `/api/exports/:id` | Cancel a queued or rendering export |
| GET | `/api/exports/:id/download` | Download a completed MP4 |

A focus point has this shape:

```json
{"id":"focus-1","time":1,"duration":3,"zoom":2,"x":0.7,"y":0.4}
```

`x` and `y` are normalized coordinates in the original picture, from 0 to 1. `time` and `duration` are seconds. The interval must fit inside the recording, last at least 0.2 seconds, and not overlap another interval. IDs must be unique. Export statuses are `queued`, `rendering`, `complete`, `cancelled`, and `error`. Import requests return after preview preparation; allow time for large recordings. Four exports can be queued or rendering at once and are processed one at a time.

### JavaScript (Node.js 20+)

This example imports a recording at least four seconds long, saves one focus point, exports it, and saves the MP4.

```js
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const base = 'http://127.0.0.1:42004';
async function api(route, options) {
  const response = await fetch(base + route, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error);
  return body;
}
const video = await api('/api/videos?name=recording.mp4', {
  method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
  body: createReadStream('recording.mp4'), duplex: 'half'
});
const points = [{ id: 'focus-1', time: 1, duration: 3, zoom: 2, x: 0.7, y: 0.4 }];
const json = value => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
await api(`/api/videos/${video.id}/project`, { method: 'PUT', ...json({ points }) });
const job = await api('/api/exports', { method: 'POST', ...json({ videoId: video.id, points }) });
let status;
do {
  await new Promise(resolve => setTimeout(resolve, 500));
  status = await api(`/api/exports/${job.id}`);
} while (['queued', 'rendering'].includes(status.status));
if (status.status !== 'complete') throw new Error(status.error || status.status);
const result = await fetch(base + status.url);
if (!result.ok) throw new Error(`Download failed: ${result.status}`);
await pipeline(Readable.fromWeb(result.body), createWriteStream('demo-cut.mp4'));
```

### Python (standard library)

This short example reads the upload into memory. Use a recording at least four seconds long.

```python
import json
import time
from pathlib import Path
from urllib.request import Request, urlopen

BASE = "http://127.0.0.1:42004"

def api(route, method="GET", body=None, binary=False):
    data = body if binary else (json.dumps(body).encode() if body is not None else None)
    content_type = "application/octet-stream" if binary else "application/json"
    request = Request(BASE + route, data=data, method=method,
                      headers={"Content-Type": content_type})
    with urlopen(request) as response:
        return json.load(response)

video = api("/api/videos?name=recording.mp4", "POST",
            Path("recording.mp4").read_bytes(), binary=True)
points = [{"id": "focus-1", "time": 1, "duration": 3, "zoom": 2, "x": 0.7, "y": 0.4}]
api(f"/api/videos/{video['id']}/project", "PUT", {"points": points})
job = api("/api/exports", "POST", {"videoId": video["id"], "points": points})
while True:
    status = api(f"/api/exports/{job['id']}")
    if status["status"] not in ("queued", "rendering"):
        break
    time.sleep(0.5)
if status["status"] != "complete":
    raise RuntimeError(status.get("error", status["status"]))
with urlopen(BASE + status["url"]) as response, open("demo-cut.mp4", "wb") as output:
    while chunk := response.read(1024 * 1024):
        output.write(chunk)
```

### Curl

Upload, then replace `VIDEO_ID` with the returned ID. The example point requires a recording at least four seconds long.

```sh
curl -fS -X POST 'http://127.0.0.1:42004/api/videos?name=recording.mp4' \
  -H 'Content-Type: application/octet-stream' --data-binary @recording.mp4

curl -fS -X PUT 'http://127.0.0.1:42004/api/videos/VIDEO_ID/project' \
  -H 'Content-Type: application/json' \
  -d '{"points":[{"id":"focus-1","time":1,"duration":3,"zoom":2,"x":0.7,"y":0.4}]}'

curl -fS -X POST 'http://127.0.0.1:42004/api/exports' \
  -H 'Content-Type: application/json' \
  -d '{"videoId":"VIDEO_ID","points":[{"id":"focus-1","time":1,"duration":3,"zoom":2,"x":0.7,"y":0.4}]}'

# Replace EXPORT_ID with the returned ID. Repeat until status is "complete".
curl -fS 'http://127.0.0.1:42004/api/exports/EXPORT_ID'
curl -fS 'http://127.0.0.1:42004/api/exports/EXPORT_ID/download' -o demo-cut.mp4
```

## Development and verification

Run the Node test suite from `app/` with `npm test` (or `node --test test/*.test.mjs`). Media integration tests need FFmpeg and FFprobe on PATH or the corresponding environment variables.

The Pinokio Install, Start, Reset setup, and Update actions were exercised locally on macOS. Start's captured URL and the responding health endpoint were verified. The missing-media-tool Conda installation branch and execution on Windows/Linux have not been tested on those platforms; the scripts use cross-platform Node and Pinokio APIs.

The six automated tests passed with Pinokio's Node.js 24.22.1 and FFmpeg 8.1.2. They cover camera geometry, interval validation, actual decoded focus pixels, unchanged prepared-audio bytes during export, silent/rotated/odd-dimension/variable-frame-rate recordings, video duration, full MP4 decoding, API persistence, byte ranges, invalid input, and cancellation.

Chrome browser testing used isolated recording data and covered import, focus placement/repositioning, timing and zoom edits, overlap recovery, playback/mute, save/reload, and an MP4 download verified with FFprobe and a full decode. Additional browser checks passed for fractional end timing and repeated import/export clicks during delayed saves. Desktop and mobile layouts were reviewed. These tests do not alter the live recording workspace.
