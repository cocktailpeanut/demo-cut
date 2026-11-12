import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { once } from 'node:events';
import { runProcess, probeVideo, normalizeVideo, exportVideo, ffmpegPath } from '../render.mjs';
import { createServer, MAX_UPLOAD } from '../server.mjs';

const ffmpeg = (args) => runProcess(ffmpegPath(), ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args]);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const focus = [{ id: 'center', time: 0.2, duration: 1.4, zoom: 2, x: 0.8, y: 0.2 }];

test('real media import and export preserve duration, audio, orientation and dimensions', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'demo-cut-media-'));
  try {
    const audio = path.join(dir, 'audio.mp4');
    await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', audio]);
    const preview = path.join(dir, 'preview.mp4');
    const metadata = await normalizeVideo(audio, preview, await probeVideo(audio));
    assert.equal(metadata.hasAudio, true); assert.equal(metadata.fps, 24);
    assert.equal(metadata.width, 320); assert.equal(metadata.height, 180);
    const output = path.join(dir, 'export.mp4');
    const progress = [];
    await exportVideo({ input: preview, output, points: focus, metadata, onProgress: (value) => progress.push(value) });
    const exported = await probeVideo(output);
    assert.equal(exported.hasAudio, true);
    assert.ok(Math.abs(exported.duration - metadata.duration) <= 1 / 24);
    assert.equal(exported.width, 320); assert.equal(exported.height, 180);
    assert.equal(progress.at(-1), 1);
    await ffmpeg(['-i', output, '-f', 'null', '-']);
    // Inspect actual decoded pixels at full zoom, not just the output container.
    const expectedFrame = path.join(dir, 'expected.gray'), actualFrame = path.join(dir, 'actual.gray');
    await ffmpeg(['-ss', '1', '-i', preview, '-vf', 'crop=160:90:160:0,scale=320:180:flags=bicubic,format=gray', '-frames:v', '1', '-f', 'rawvideo', expectedFrame]);
    await ffmpeg(['-ss', '1', '-i', output, '-vf', 'format=gray', '-frames:v', '1', '-f', 'rawvideo', actualFrame]);
    const expected = await readFile(expectedFrame), actual = await readFile(actualFrame);
    const meanError = actual.reduce((sum, value, index) => sum + Math.abs(value - expected[index]), 0) / actual.length;
    assert.ok(meanError < 10, `Rendered focus differs from its expected crop (${meanError.toFixed(2)} mean gray levels).`);
    const copy = path.join(dir, 'copy.mp4');
    await exportVideo({ input: preview, output: copy, points: [], metadata });
    assert.equal((await probeVideo(copy)).hasAudio, true);
    const audioBefore = await ffmpeg(['-i', preview, '-map', '0:a:0', '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-']);
    const audioAfter = await ffmpeg(['-i', output, '-map', '0:a:0', '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-']);
    assert.equal(audioAfter.stdout, audioBefore.stdout, 'export copies the prepared audio bytes');

    const rotated = path.join(dir, 'rotated.mp4');
    await ffmpeg(['-display_rotation', '90', '-i', audio, '-c', 'copy', rotated]);
    const rotateInfo = await probeVideo(rotated);
    assert.equal(rotateInfo.width, 180); assert.equal(rotateInfo.height, 320);
    const rotatePreview = path.join(dir, 'rotate-preview.mp4');
    const normalizedRotate = await normalizeVideo(rotated, rotatePreview, rotateInfo);
    assert.equal(normalizedRotate.width, 180); assert.equal(normalizedRotate.height, 320);
    await exportVideo({ input: rotatePreview, output: path.join(dir, 'rotate-export.mp4'), points: focus, metadata: normalizedRotate });

    const odd = path.join(dir, 'odd.mkv');
    await ffmpeg(['-f', 'lavfi', '-i', 'testsrc=size=321x181:rate=15:duration=2', '-c:v', 'ffv1', odd]);
    const oddPreview = path.join(dir, 'odd-preview.mp4');
    const oddInfo = await normalizeVideo(odd, oddPreview, await probeVideo(odd));
    assert.equal(oddInfo.width, 322); assert.equal(oddInfo.height, 182); assert.equal(oddInfo.hasAudio, false);
    const oddExport = path.join(dir, 'odd-export.mp4');
    await exportVideo({ input: oddPreview, output: oddExport, points: focus, metadata: oddInfo });
    assert.equal((await probeVideo(oddExport)).hasAudio, false);

    const vfr = path.join(dir, 'vfr.mp4');
    await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-vf', "select='if(lt(t,1),not(mod(n,2)),1)'", '-fps_mode', 'vfr', '-c:v', 'libx264', '-c:a', 'aac', vfr]);
    const vfrPreview = path.join(dir, 'vfr-preview.mp4');
    const vfrInfo = await normalizeVideo(vfr, vfrPreview, await probeVideo(vfr));
    const vfrOutput = path.join(dir, 'vfr-export.mp4');
    await exportVideo({ input: vfrPreview, output: vfrOutput, points: focus, metadata: vfrInfo });
    const vfrExported = await probeVideo(vfrOutput);
    assert.ok(Math.abs(vfrExported.duration - vfrInfo.duration) <= 1 / vfrInfo.fps);
    assert.equal(vfrExported.hasAudio, true);

    const controller = new AbortController(); controller.abort();
    const cancelled = path.join(dir, 'cancelled.mp4');
    await assert.rejects(exportVideo({ input: preview, output: cancelled, points: focus, metadata, signal: controller.signal }), /cancelled/);
    await assert.rejects(access(cancelled), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('HTTP upload, project persistence, validation, ranges, export and cancellation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'demo-cut-http-'));
  const server = await createServer({ dataDir: path.join(dir, 'data') });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const file = path.join(dir, 'fixture.mp4');
    await ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=2', '-c:v', 'libx264', file]);
    const body = await readFile(file);
    let response = await fetch(`${base}/api/health`); assert.equal(response.status, 200);
    response = await fetch(`${base}/api/videos?name=screen.mp4`, { method: 'POST', body });
    assert.equal(response.status, 201, await response.clone().text());
    const video = await response.json(); assert.equal(video.name, 'screen.mp4');
    response = await fetch(`${base}/api/videos`); assert.equal((await response.json()).length, 1);
    response = await fetch(`${base}/api/videos/${video.id}/project`, { method: 'PUT', body: JSON.stringify({ points: focus }) });
    assert.equal(response.status, 200);
    response = await fetch(`${base}/api/videos/${video.id}`); assert.deepEqual((await response.json()).points, focus);
    response = await fetch(`${base}/api/videos/${video.id}/project`, { method: 'PUT', body: JSON.stringify({ points: [...focus, { ...focus[0], id: 'overlap' }] }) });
    assert.equal(response.status, 400); assert.match((await response.json()).error, /overlap/);
    response = await fetch(`${base}${video.url}`, { headers: { Range: 'bytes=0-99' } });
    assert.equal(response.status, 206); assert.equal((await response.arrayBuffer()).byteLength, 100);
    response = await fetch(`${base}${video.url}`, { headers: { Range: 'bytes=-20' } });
    assert.equal(response.status, 206); assert.equal((await response.arrayBuffer()).byteLength, 20);
    response = await fetch(`${base}${video.url}`, { headers: { Range: 'bytes=99999999999-' } }); assert.equal(response.status, 416);
    response = await fetch(`${base}/api/videos/not-an-id`); assert.equal(response.status, 404);
    response = await fetch(`${base}/../server.mjs`); assert.equal(response.status, 404);
    response = await fetch(`${base}/api/videos`, { method: 'POST', headers: { Origin: 'https://example.com' }, body }); assert.equal(response.status, 403);
    response = await fetch(`${base}/api/videos?name=broken.mp4`, { method: 'POST', body: 'not a video' }); assert.equal(response.status, 400); assert.ok((await response.json()).error);
    response = await fetch(`${base}/api/exports`, { method: 'POST', body: JSON.stringify({ videoId: video.id, points: focus }) }); assert.equal(response.status, 202);
    const { id } = await response.json();
    let job;
    for (let i = 0; i < 100; i++) {
      job = await (await fetch(`${base}/api/exports/${id}`)).json();
      if (['complete', 'error'].includes(job.status)) break;
      await pause(30);
    }
    assert.equal(job.status, 'complete', job.error); assert.equal(job.progress, 1);
    response = await fetch(`${base}${job.url}`); assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /attachment/); assert.ok((await response.arrayBuffer()).byteLength > 100);
    response = await fetch(`${base}/api/exports`, { method: 'POST', body: JSON.stringify({ videoId: video.id, points: focus }) });
    const pending = await response.json();
    response = await fetch(`${base}/api/exports/${pending.id}`, { method: 'DELETE' });
    assert.equal((await response.json()).status, 'cancelled');
    assert.equal(MAX_UPLOAD, 2147483648);
  } finally {
    server.stopJobs(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    await pause(100); await rm(dir, { recursive: true, force: true });
  }
});
