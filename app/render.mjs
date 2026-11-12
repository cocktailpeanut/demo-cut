import { spawn } from 'node:child_process';
import { writeFile, rename, rm } from 'node:fs/promises';
import { validatePoints, RAMP_DURATION } from './public/motion.js';

export const ffmpegPath = () => process.env.FFMPEG_PATH || 'ffmpeg';
export const ffprobePath = () => process.env.FFPROBE_PATH || 'ffprobe';

export function runProcess(command, args, { signal, onProgress, duration = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Export cancelled.'));
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', progressBuffer = '';
    const cancel = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', cancel, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout = (stdout + chunk).slice(-1024 * 1024);
      if (!onProgress) return;
      progressBuffer += chunk;
      const lines = progressBuffer.split('\n');
      progressBuffer = lines.pop();
      for (const line of lines) {
        if (line.startsWith('out_time_us=') && duration > 0) onProgress(Math.min(0.99, Math.max(0, Number(line.slice(12)) / 1e6 / duration)));
      }
    });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-32000); });
    child.on('error', (error) => {
      signal?.removeEventListener('abort', cancel);
      reject(new Error(error.code === 'ENOENT' ? `${command} is unavailable. Run Install in Pinokio, then start Demo Cut again.` : error.message));
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', cancel);
      if (signal?.aborted) return reject(new Error('Export cancelled.'));
      if (code !== 0) return reject(new Error(stderr.trim().split('\n').slice(-6).join('\n') || `Media processing exited with code ${code}.`));
      resolve({ stdout, stderr });
    });
  });
}

export async function checkTools() {
  await Promise.all([runProcess(ffmpegPath(), ['-version']), runProcess(ffprobePath(), ['-version'])]);
}

const fraction = (value) => {
  const [n, d = 1] = String(value || '0').split('/').map(Number);
  return d ? n / d : 0;
};

export async function probeVideo(file) {
  const { stdout } = await runProcess(ffprobePath(), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  const result = JSON.parse(stdout);
  const stream = result.streams?.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  if (!stream) throw new Error('This file does not contain a playable video track.');
  const audio = result.streams.find((s) => s.codec_type === 'audio');
  const duration = Number(stream.duration || result.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('The video duration could not be read. Try exporting it as MP4 first.');
  const rotation = Number(stream.side_data_list?.find((s) => s.rotation !== undefined)?.rotation || stream.tags?.rotate || 0);
  const rotated = Math.abs(rotation % 180) > 45 && Math.abs(rotation % 180) < 135;
  const sar = fraction(String(stream.sample_aspect_ratio || '1:1').replace(':', '/')) || 1;
  let width = Math.round(stream.width * sar), height = stream.height;
  if (rotated) [width, height] = [height, width];
  if (!width || !height || width > 16384 || height > 16384) throw new Error('This video has unsupported picture dimensions.');
  const sourceFps = fraction(stream.avg_frame_rate) || fraction(stream.r_frame_rate) || 30;
  return {
    width, height, duration, fps: Math.round(Math.min(60, Math.max(1, sourceFps)) * 1e6) / 1e6,
    hasAudio: Boolean(audio), audioCodec: audio?.codec_name, videoIndex: stream.index, audioIndex: audio?.index,
  };
}

export async function normalizeVideo(input, output, source, { signal } = {}) {
  const partial = output.replace(/\.mp4$/, '.partial.mp4');
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', input, '-map', `0:${source.videoIndex}`];
  if (source.hasAudio) args.push('-map', `0:${source.audioIndex}`);
  args.push('-vf', `scale=round(iw*sar):ih,setsar=1,pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0,fps=${source.fps}`, '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p');
  if (source.hasAudio) args.push('-c:a', source.audioCodec === 'aac' ? 'copy' : 'aac');
  args.push('-map_metadata', '-1', '-metadata:s:v:0', 'rotate=0', '-movflags', '+faststart', partial);
  try {
    await runProcess(ffmpegPath(), args, { signal });
    if (signal?.aborted) throw new Error('Import cancelled.');
    await rename(partial, output);
    return await probeVideo(output);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

const number = (n) => Number(n).toFixed(8).replace(/0+$/, '').replace(/\.$/, '') || '0';
const smoothExpression = (value) => `(pow(clip(${value},0,1),2)*(3-2*clip(${value},0,1)))`;

/** Same smoothstep and clamped crop as cameraAt; only trusted numbers enter the graph. */
export function buildFilter(points, metadata) {
  const clean = validatePoints(points, metadata.duration);
  const t = `(on/${number(metadata.fps)})`;
  let z = '1', x = '0', y = '0';
  for (const point of [...clean].reverse()) {
    const start = number(point.time), end = number(point.time + point.duration);
    const ramp = number(Math.min(RAMP_DURATION, point.duration / 2));
    const weight = `min(${smoothExpression(`(${t}-${start})/${ramp}`)},${smoothExpression(`(${end}-${t})/${ramp}`)})`;
    const active = `between(${t},${start},${end})`;
    z = `if(${active},1+${number(point.zoom - 1)}*${weight},${z})`;
    x = `if(${active},clip(${number(point.x)}-0.5/zoom,0,1-1/zoom),${x})`;
    y = `if(${active},clip(${number(point.y)}-0.5/zoom,0,1-1/zoom),${y})`;
  }
  return `[0:v]format=yuv444p,scale=iw*2:ih*2:flags=bicubic,zoompan=z='${z}':x='iw*(${x})':y='ih*(${y})':d=1:s=${metadata.width}x${metadata.height}:fps=${number(metadata.fps)},format=yuv420p[v]`;
}

export async function exportVideo({ input, output, points, metadata, signal, onProgress }) {
  const clean = validatePoints(points, metadata.duration);
  const partial = output.replace(/\.mp4$/, '.partial.mp4');
  const graphFile = `${output}.filter.txt`;
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', input];
  if (clean.length) {
    await writeFile(graphFile, buildFilter(clean, metadata));
    args.push('-filter_complex_script', graphFile, '-map', '[v]', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'copy');
  } else args.push('-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy');
  args.push('-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', partial);
  try {
    await runProcess(ffmpegPath(), args, { signal, onProgress, duration: metadata.duration });
    if (signal?.aborted) throw new Error('Export cancelled.');
    await rename(partial, output);
    if (signal?.aborted) {
      await rm(output, { force: true });
      throw new Error('Export cancelled.');
    }
    onProgress?.(1);
  } finally {
    await Promise.all([rm(partial, { force: true }), rm(graphFile, { force: true })]);
  }
}
