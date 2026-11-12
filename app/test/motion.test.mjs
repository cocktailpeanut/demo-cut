import test from 'node:test';
import assert from 'node:assert/strict';
import { cameraAt, validatePoints } from '../public/motion.js';

const point = (changes = {}) => ({ id: 'focus', time: 1, duration: 2, zoom: 2, x: 0.7, y: 0.4, ...changes });

test('camera starts and ends at the full frame and reaches the requested focus', () => {
  const points = [point()];
  for (const time of [0, 1, 3, 4]) assert.deepEqual(cameraAt(points, time), { zoom: 1, x: 0, y: 0 });
  assert.deepEqual(cameraAt(points, 2), { zoom: 2, x: 0.7 - 0.25, y: 0.4 - 0.25 });
  assert.equal(cameraAt(points, 1.3).zoom, 1.5);
  assert.ok(Math.abs(cameraAt(points, 2.7).zoom - 1.5) < 1e-12);
});

test('corners and short intervals never reveal pixels outside the recording', () => {
  for (const x of [0, 0.5, 1]) for (const y of [0, 0.5, 1]) {
    const points = [point({ x, y, duration: 0.2, zoom: 4 })];
    for (let time = 0.99; time <= 1.21; time += 0.001) {
      const camera = cameraAt(points, time);
      assert.ok(camera.zoom >= 1 && camera.zoom <= 4);
      assert.ok(camera.x >= 0 && camera.y >= 0);
      assert.ok(camera.x + 1 / camera.zoom <= 1.00000001);
      assert.ok(camera.y + 1 / camera.zoom <= 1.00000001);
    }
  }
});

test('validation rejects overlap, non-finite inputs, bad bounds and duplicate IDs', () => {
  assert.throws(() => validatePoints([point(), point({ id: 'other', time: 2 })], 8), /overlap/);
  assert.throws(() => validatePoints([point({ x: NaN })], 8), /number/);
  assert.throws(() => validatePoints([point({ x: -0.1 })], 8), /inside/);
  assert.throws(() => validatePoints([point({ zoom: 4.1 })], 8), /zoom/);
  assert.throws(() => validatePoints([point({ time: 7 })], 8), /fit inside/);
  assert.throws(() => validatePoints([point({ duration: 0 })], 8), /at least/);
  assert.throws(() => validatePoints([point(), point({ time: 5 })], 8), /unique/);
  assert.throws(() => validatePoints(null, 8), /list/);
  assert.throws(() => validatePoints([point({ time: '1' })], 8), /number/);
});

test('adjacent points are valid and input objects are not mutated', () => {
  const first = point(), second = point({ id: 'second', time: 3 });
  const original = [second, first];
  const clean = validatePoints(original, 5);
  assert.equal(clean[0].id, first.id);
  assert.equal(original[0].id, second.id);
  assert.notEqual(clean[0], first);
});
