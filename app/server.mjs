import http from 'node:http';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, rename, readdir, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { checkTools, probeVideo, normalizeVideo, exportVideo } from './render.mjs';
import { validatePoints } from './public/motion.js';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(APP_DIR, 'public');
export const MAX_UPLOAD = 2 * 1024 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const errorWithStatus = (message, status = 400) => Object.assign(new Error(message), { status });
const checkedPoints = (points, duration) => {
  try { return validatePoints(points, duration); }
  catch (error) { throw errorWithStatus(error.message); }
};
const json = (res, status, value) => {
  if (!res.destroyed && !res.headersSent) res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }).end(JSON.stringify(value));
};
async function atomicJson(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2));
  await rename(temp, file);
}
async function readJsonBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 256 * 1024) throw errorWithStatus('This edit contains too much data.', 413);
  }
  try { return JSON.parse(body); } catch { throw errorWithStatus('Send valid JSON.'); }
}
function saveUpload(req, file) {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(file, { flags: 'wx' });
    let bytes = 0, done = false;
    const cleanup = () => {
      req.off('data', data); req.off('end', end); req.off('aborted', abort); req.off('error', fail);
      output.off('drain', drain);
    };
    const fail = (error) => {
      if (done) return;
      done = true; cleanup(); req.resume();
      output.once('close', () => reject(error));
      output.destroy();
    };
    const data = (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_UPLOAD) return fail(errorWithStatus('Recordings must be smaller than 2 GB.', 413));
      if (!output.write(chunk)) req.pause();
    };
    const drain = () => req.resume();
    const end = () => output.end();
    const abort = () => fail(errorWithStatus('The upload was interrupted.'));
    output.on('error', fail);
    output.on('drain', drain);
    output.on('finish', () => { if (!done) { done = true; cleanup(); resolve(bytes); } });
    req.on('data', data); req.once('end', end); req.once('aborted', abort); req.once('error', fail);
  });
}

export async function serveFile(req, res, file, contentType, downloadName) {
  const info = await stat(file);
  if (!info.isFile()) throw errorWithStatus('File not found.', 404);
  const headers = { 'Content-Type': contentType, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
  if (downloadName) headers['Content-Disposition'] = `attachment; filename="demo-cut.mp4"; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
  let start = 0, end = info.size - 1, status = 200;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2])) {
      res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end(); return;
    }
    if (!match[1]) start = Math.max(0, info.size - Number(match[2]));
    else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end(); return;
    }
    status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
  }
  headers['Content-Length'] = Math.max(0, end - start + 1);
  res.writeHead(status, headers);
  if (req.method === 'HEAD' || !info.size) return res.end();
  const stream = createReadStream(file, { start, end });
  stream.on('error', () => res.destroy());
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}

export async function createServer({ dataDir = process.env.DEMO_CUT_DATA || path.join(APP_DIR, 'data') } = {}) {
  const videosDir = path.join(dataDir, 'videos'), exportsDir = path.join(dataDir, 'exports');
  await Promise.all([mkdir(videosDir, { recursive: true }), mkdir(exportsDir, { recursive: true })]);
  const jobs = new Map(), importControllers = new Set();
  let exporting = false, importing = false;
  const videoDir = (id) => {
    if (!UUID.test(id)) throw errorWithStatus('Recording not found.', 404);
    return path.join(videosDir, id);
  };
  const getVideo = async (id) => {
    try { return JSON.parse(await readFile(path.join(videoDir(id), 'video.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') throw errorWithStatus('Recording not found.', 404); throw error; }
  };
  const jobView = (job) => {
    const { id, status, progress, url, error } = job;
    return { id, status, progress, ...(url ? { url } : {}), ...(error ? { error } : {}) };
  };
  const persistJob = (job) => atomicJson(path.join(exportsDir, job.id, 'export.json'), { ...jobView(job), name: job.name });
  const pump = async () => {
    if (exporting) return;
    const job = [...jobs.values()].find((j) => j.status === 'queued');
    if (!job) return;
    exporting = true;
    job.status = 'rendering';
    try {
      await persistJob(job);
      await exportVideo({ input: path.join(videoDir(job.videoId), 'preview.mp4'), output: path.join(exportsDir, job.id, 'output.mp4'), points: job.points, metadata: job.metadata, signal: job.controller.signal, onProgress: (progress) => { job.progress = Math.max(job.progress, progress); } });
      job.status = 'complete'; job.progress = 1; job.url = `/api/exports/${job.id}/download`;
    } catch (error) {
      job.status = job.controller.signal.aborted ? 'cancelled' : 'error';
      if (job.status === 'error') { job.error = `Export failed: ${error.message}`; console.error(job.error); }
    } finally {
      await persistJob(job).catch((error) => console.error('Could not save export status:', error.message));
      exporting = false; void pump();
    }
  };

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const pathname = decodeURIComponent(url.pathname);
      if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
        throw errorWithStatus('Open Demo Cut directly to make changes.', 403);
      }
      if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { ok: true, app: 'Demo Cut', version: '1.0.0' });
      if (req.method === 'GET' && pathname === '/api/videos') {
        const entries = await readdir(videosDir);
        const recordings = (await Promise.all(entries.filter((id) => UUID.test(id)).map((id) => getVideo(id).catch(() => null)))).filter(Boolean);
        recordings.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return json(res, 200, recordings);
      }
      if (req.method === 'POST' && pathname === '/api/videos') {
        if (Number(req.headers['content-length']) > MAX_UPLOAD) { req.resume(); throw errorWithStatus('Recordings must be smaller than 2 GB.', 413); }
        if (importing) { req.resume(); throw errorWithStatus('Another recording is being prepared. Please wait for it to finish.', 409); }
        importing = true;
        const id = randomUUID(), folder = videoDir(id), controller = new AbortController();
        importControllers.add(controller);
        const disconnect = () => { if (!res.writableEnded) controller.abort(); };
        res.on('close', disconnect);
        try {
          await mkdir(folder);
          const original = path.join(folder, 'original');
          const bytes = await saveUpload(req, original);
          if (!bytes) throw errorWithStatus('The selected file is empty.');
          const source = await probeVideo(original);
          const info = await normalizeVideo(original, path.join(folder, 'preview.mp4'), source, { signal: controller.signal });
          const name = (url.searchParams.get('name') || 'Recording').replace(/\\/g, '/').split('/').pop().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180) || 'Recording';
          const metadata = { id, name, url: `/api/videos/${id}/media`, width: info.width, height: info.height, duration: info.duration, fps: info.fps, hasAudio: info.hasAudio, points: [], createdAt: new Date().toISOString() };
          await atomicJson(path.join(folder, 'video.json'), metadata);
          return json(res, 201, metadata);
        } catch (error) {
          await rm(folder, { recursive: true, force: true });
          throw errorWithStatus(error.message.startsWith('The ') || error.status ? error.message : `Could not prepare this video: ${error.message}`, error.status || 400);
        } finally {
          res.off('close', disconnect); importControllers.delete(controller); importing = false;
        }
      }
      const videoMatch = /^\/api\/videos\/([^/]+)(?:\/(project|media))?$/.exec(pathname);
      if (videoMatch) {
        const [, id, action] = videoMatch;
        const metadata = await getVideo(id);
        if (req.method === 'GET' && !action) return json(res, 200, metadata);
        if (['GET', 'HEAD'].includes(req.method) && action === 'media') return await serveFile(req, res, path.join(videoDir(id), 'preview.mp4'), 'video/mp4');
        if (req.method === 'PUT' && action === 'project') {
          const body = await readJsonBody(req);
          metadata.points = checkedPoints(body.points, metadata.duration);
          await atomicJson(path.join(videoDir(id), 'video.json'), metadata);
          return json(res, 200, metadata);
        }
      }
      if (req.method === 'POST' && pathname === '/api/exports') {
        const body = await readJsonBody(req);
        const metadata = await getVideo(body.videoId);
        const points = checkedPoints(body.points, metadata.duration);
        if ([...jobs.values()].filter((j) => ['queued', 'rendering'].includes(j.status)).length >= 4) throw errorWithStatus('There are already four exports waiting. Let one finish before adding another.', 409);
        const id = randomUUID();
        const job = { id, videoId: metadata.id, points, metadata, name: `${metadata.name.replace(/\.[^.]+$/, '')}-demo-cut.mp4`, status: 'queued', progress: 0, controller: new AbortController() };
        await mkdir(path.join(exportsDir, id));
        await persistJob(job); jobs.set(id, job); void pump();
        return json(res, 202, { id });
      }
      const exportMatch = /^\/api\/exports\/([^/]+)(?:\/(download))?$/.exec(pathname);
      if (exportMatch) {
        const [, id, action] = exportMatch;
        if (!UUID.test(id)) throw errorWithStatus('Export not found.', 404);
        let job = jobs.get(id);
        if (!job) {
          try { job = JSON.parse(await readFile(path.join(exportsDir, id, 'export.json'), 'utf8')); }
          catch (error) { if (error.code === 'ENOENT') throw errorWithStatus('Export not found.', 404); throw error; }
          if (['queued', 'rendering'].includes(job.status)) job = { ...job, status: 'error', error: 'The app stopped during this export. Export the recording again.' };
        }
        if (req.method === 'GET' && !action) return json(res, 200, jobView(job));
        if (['GET', 'HEAD'].includes(req.method) && action === 'download') {
          if (job.status !== 'complete') throw errorWithStatus('This export is not ready to download.', 409);
          return await serveFile(req, res, path.join(exportsDir, id, 'output.mp4'), 'video/mp4', job.name);
        }
        if (req.method === 'DELETE' && !action) {
          if (['queued', 'rendering'].includes(job.status)) {
            job.controller?.abort(); job.status = 'cancelled'; await persistJob(job);
          }
          return json(res, 200, jobView(job));
        }
      }
      if (['GET', 'HEAD'].includes(req.method) && !pathname.startsWith('/api/')) {
        const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
        if (relative.split('/').some((segment) => segment.startsWith('.') || segment.includes('\\'))) throw errorWithStatus('File not found.', 404);
        const file = path.resolve(PUBLIC_DIR, relative);
        if (!file.startsWith(`${PUBLIC_DIR}${path.sep}`) || !MIME[path.extname(file)]) throw errorWithStatus('File not found.', 404);
        return await serveFile(req, res, file, MIME[path.extname(file)]);
      }
      throw errorWithStatus('Not found.', 404);
    } catch (error) {
      const status = error.status || (error.code === 'ENOENT' ? 404 : error instanceof URIError || error instanceof SyntaxError ? 400 : 500);
      if (status === 500) console.error(error);
      json(res, status, { error: status === 500 ? 'Something went wrong. Please try again.' : error.message });
    }
  });
  server.requestTimeout = 0;
  server.stopJobs = () => { for (const job of jobs.values()) job.controller.abort(); for (const controller of importControllers) controller.abort(); };
  server.on('close', server.stopJobs);
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await checkTools();
    const server = await createServer();
    const port = process.env.PORT === undefined ? 0 : Number(process.env.PORT);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be a number between 0 and 65535.');
    server.listen(port, '127.0.0.1', () => console.log(`Demo Cut is ready at http://127.0.0.1:${server.address().port}`));
    server.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
    const stop = () => { server.stopJobs(); server.close(); server.closeAllConnections(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
