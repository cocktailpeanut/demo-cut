import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const marker = fileURLToPath(new URL('.installed', import.meta.url));
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';

rmSync(marker, { force: true });
try {
  if (Number(process.versions.node.split('.')[0]) < 20) {
    throw new Error('Demo Cut requires Node.js 20 or newer. Update Pinokio’s managed runtime and run Install again.');
  }
  const run = (binary, args) => execFileSync(binary, args, {
    encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe']
  });
  const ffmpegVersion = run(ffmpeg, ['-version']).split('\n')[0];
  const ffprobeVersion = run(ffprobe, ['-version']).split('\n')[0];
  const encoders = run(ffmpeg, ['-hide_banner', '-encoders']);
  const filters = run(ffmpeg, ['-hide_banner', '-filters']);
  for (const encoder of ['libx264', 'aac']) {
    if (!new RegExp(`\\s${encoder}\\s`).test(encoders)) {
      throw new Error(`FFmpeg is missing the ${encoder} encoder. Install a GPL-enabled FFmpeg build and run Install again.`);
    }
  }
  if (!/\szoompan\s/.test(filters)) throw new Error('FFmpeg is missing the zoompan filter. Update FFmpeg and run Install again.');
  writeFileSync(marker, JSON.stringify({ node: process.versions.node, ffmpeg: ffmpegVersion, ffprobe: ffprobeVersion }, null, 2));
  console.log(`Node.js ${process.versions.node}`);
  console.log(ffmpegVersion);
  console.log(ffprobeVersion);
  console.log('Demo Cut is ready. Click Start.');
} catch (error) {
  console.error(`Setup failed: ${error.message}`);
  process.exitCode = 1;
}
