import { expect, it } from 'vitest';
import { probeCapability } from '../scripts/probe-capability.mjs';

const commit = 'c66dcb693ba3fa6a683e81a946d6be5e8880796e';
const image =
  'us-east4-docker.pkg.dev/tour-itinerary-513414/tour-itinerary/api@sha256:26fcbf17ece404d46baefea25f3d2ffae4308ab65c4be094413b1561fb9588ef';
it('recognizes only the reviewed exact legacy commit/image as health-only', () => {
  const labels = { 'org.opencontainers.image.revision': commit };
  expect(probeCapability(image, commit, labels)).toBe(false);
  expect(() => probeCapability(`${image}0`, commit, labels)).toThrow(
    'Recovery capability',
  );
  expect(() => probeCapability(image, 'a'.repeat(40), labels)).toThrow(
    'inconsistent',
  );
  expect(() =>
    probeCapability(image, commit, {
      ...labels,
      'dev.tour-itinerary.probe': 'unknown',
    }),
  ).toThrow('Recovery capability');
});
