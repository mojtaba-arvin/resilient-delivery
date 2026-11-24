import type { RouteScore } from "./types.js";
const MAX_SHAPE = 100;
function gammaSample(shape: number, random: () => number): number {
  if (shape < 1) return gammaSample(shape + 1, random) * Math.max(Number.EPSILON, random()) ** (1 / shape);
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (let i = 0; i < 64; i++) {
    const u1 = Math.max(Number.EPSILON, random()), u2 = Math.max(Number.EPSILON, random());
    const x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2), v0 = 1 + c * x;
    if (v0 <= 0) continue;
    const v = v0 ** 3, u = random();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(Math.max(Number.EPSILON, u)) < 0.5 * x ** 2 + d * (1 - v + Math.log(v))) return d * v;
  }
  return shape;
}
/** In-memory Thompson sampler with bounded exponential forgetting. */
export class RouteBandit {
  private scores: RouteScore[];
  constructor(count: number, private random = Math.random, private forgetting = 0.995) {
    if (!Number.isInteger(count) || count < 1) throw new RangeError("routeCount must be positive");
    if (!(forgetting > 0 && forgetting <= 1)) throw new RangeError("forgetting must be in (0, 1]");
    this.scores = Array.from({length: count}, () => ({alpha: 1, beta: 1}));
  }
  choose(eligible: readonly number[] = this.scores.map((_, i) => i)): number {
    if (!eligible.length) throw new RangeError("No eligible routes");
    let winner = eligible[0]!, best = -Infinity;
    for (const index of eligible) {
      const s = this.scores[index]; if (!s) throw new RangeError("Unknown route index");
      const a = gammaSample(s.alpha, this.random), b = gammaSample(s.beta, this.random), sample = a / (a + b);
      if (sample > best) { best = sample; winner = index; }
    }
    return winner;
  }
  observe(index: number, success: boolean): void {
    const s = this.scores[index]; if (!s) throw new RangeError("Unknown route index");
    this.scores[index] = {
      alpha: Math.min(MAX_SHAPE, 1 + (s.alpha - 1) * this.forgetting + (success ? 1 : 0)),
      beta: Math.min(MAX_SHAPE, 1 + (s.beta - 1) * this.forgetting + (success ? 0 : 1)),
    };
  }
  snapshot(): readonly RouteScore[] { return this.scores.map(s => ({...s})); }
}
