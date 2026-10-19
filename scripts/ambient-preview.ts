// Renders one short take of each ambient layer to a wav. The takes are
// peak-normalised so they can be listened to; in the viewer the same beds sit
// well under the master. No browser and no assets: the buffer builders run
// against a sample-rate stand-in.
//
//   npx tsx scripts/ambient-preview.ts [out-dir]

import { mkdirSync, writeFileSync } from 'node:fs';
import { renderAmbientPreview, renderArmyChatter, renderCityScene, renderDroneOnly, renderOutbreakStage, type AmbientLayer, type OutbreakPreview } from '../src/audio/audio';

const outDir = process.argv[2] ?? '/opt/cursor/artifacts';
const seconds = 14;
const rate = 22050;

function wav(samples: Float32Array): Buffer {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return buf;
}

mkdirSync(outDir, { recursive: true });
for (const layer of ['city', 'outbreak', 'cordon'] as const satisfies readonly AmbientLayer[]) {
  const samples = renderAmbientPreview(layer, seconds, rate);
  const path = `${outDir}/ambient-${layer}.wav`;
  writeFileSync(path, wav(samples));
  console.log(`${path}  ${seconds}s  ${rate} Hz  peak-normalised`);
}
const chatterSeconds = 18;
const chatter = renderAmbientPreview('cordon', chatterSeconds, rate);
const chatterPath = `${outDir}/ambient-cordon-chatter.wav`;
writeFileSync(chatterPath, wav(chatter));
console.log(`${chatterPath}  ${chatterSeconds}s  ${rate} Hz  peak-normalised`);

const scenes = [
  ['ambient-city-day-v3.wav', 'day', 20],
  ['ambient-city-night-v3.wav', 'night', 20],
  ['ambient-city-outbreak.wav', 'outbreak', 15],
] as const;
for (const [name, scene, len] of scenes) {
  const samples = renderCityScene(scene, len, rate);
  const path = `${outDir}/${name}`;
  writeFileSync(path, wav(samples));
  console.log(`${path}  ${len}s  ${rate} Hz  peak-normalised`);
}
const droneSeconds = 10;
const drone = renderDroneOnly(droneSeconds, rate);
const dronePath = `${outDir}/ambient-city-drone-only.wav`;
writeFileSync(dronePath, wav(drone));
console.log(`${dronePath}  ${droneSeconds}s  ${rate} Hz  drone only, peak-normalised`);

const outbreakStagesPreview = [
  ['ambient-outbreak-first-signs.wav', 'first'],
  ['ambient-outbreak-spreading.wav', 'spreading'],
  ['ambient-outbreak-panic.wav', 'panic'],
  ['ambient-outbreak-overrun.wav', 'overrun'],
] as const satisfies readonly (readonly [string, OutbreakPreview])[];
for (const [name, stage] of outbreakStagesPreview) {
  const samples = renderOutbreakStage(stage, 12, rate);
  const path = `${outDir}/${name}`;
  writeFileSync(path, wav(samples));
  console.log(`${path}  12s  ${rate} Hz  peak-normalised`);
}

const armySeconds = 18;
const army = renderArmyChatter(armySeconds, rate);
const armyPath = `${outDir}/ambient-army-chatter.wav`;
writeFileSync(armyPath, wav(army));
console.log(`${armyPath}  ${armySeconds}s  ${rate} Hz  peak-normalised`);
