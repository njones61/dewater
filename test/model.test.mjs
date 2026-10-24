// node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { heads, influence, optimalRate, grid, inside, densify } from "../js/model.js";

const p = { H: 50, k: 5e-6, R: 500, rw: 0.15 };
const close = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${a} vs ${b}`);

test("one well matches the unconfined well equation", () => {
  const q = 0.002, r = 30;
  const { h } = heads([{ x: r, y: 0 }], [{ x: 0, y: 0, q }], p);
  close(h[0], Math.sqrt(p.H ** 2 - q / (Math.PI * p.k) * Math.log(p.R / r)));
});

test("beyond R a well has no effect; inside r_w the head is the head at r_w", () => {
  const w = [{ x: 0, y: 0, q: 0.002 }];
  close(heads([{ x: 600, y: 0 }], w, p).h[0], p.H);
  close(heads([{ x: 0.01, y: 0 }], w, p).h[0], heads([{ x: p.rw, y: 0 }], w, p).h[0]);
});

test("wells add in H² − h², not in drawdown", () => {
  const q = 0.002, pt = [{ x: 0, y: 0 }];
  const w1 = [{ x: -20, y: 0, q }], w2 = [{ x: 20, y: 0, q }];
  const h1 = heads(pt, w1, p).h[0], h2 = heads(pt, w2, p).h[0], h12 = heads(pt, [...w1, ...w2], p).h[0];
  close(p.H ** 2 - h12 ** 2, (p.H ** 2 - h1 ** 2) + (p.H ** 2 - h2 ** 2));
  assert.ok(h12 < p.H - ((p.H - h1) + (p.H - h2)));   // adding drawdowns leaves the water too high
});

test("the optimal rate puts the highest checked head exactly on the target", () => {
  const wells = [[-60, -40], [60, -40], [60, 40], [-60, 40], [0, -40], [0, 40]].map(([x, y]) => ({ x, y }));
  const ring = [{ x: -45, y: -25 }, { x: 45, y: -25 }, { x: 45, y: 25 }, { x: -45, y: 25 }];
  const pts = densify(ring, 2).concat(grid([-45, 45, -25, 25], 31, 21));
  const opt = optimalRate(pts, wells, p, 35);
  assert.ok(opt.feasible);
  const { h } = heads(pts, wells.map((w) => ({ ...w, q: opt.qEach })), p);
  close(Math.max(...h), 35, 1e-9);
  const lower = heads(pts, wells.map((w) => ({ ...w, q: opt.qEach * 0.99 })), p).h;
  assert.ok(Math.max(...lower) > 35);
});

test("influence is the per-unit-rate sum", () => {
  const wells = [{ x: 0, y: 0 }, { x: 10, y: 0 }], pt = [{ x: 5, y: 5 }];
  const A = influence(pt, wells, p)[0];
  const { h } = heads(pt, wells.map((w) => ({ ...w, q: 0.001 })), p);
  close(p.H ** 2 - h[0] ** 2, 0.001 * A);
});

test("a design that pumps a well dry is flagged", () => {
  const wells = [{ x: -100, y: 0 }];
  const opt = optimalRate([{ x: 0, y: 0 }], wells, { ...p, H: 10 }, 0.5);
  assert.equal(opt.feasible, false);
});

test("grid, inside, densify", () => {
  const g = grid([0, 10, 0, 5], 11, 6);
  assert.equal(g.length, 66);
  assert.deepEqual(g[0], { x: 0, y: 5 });
  const sq = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  assert.ok(inside({ x: 0.5, y: 0.5 }, sq));
  assert.ok(!inside({ x: 1.5, y: 0.5 }, sq));
  assert.equal(densify(sq, 0.25).length, 16);
});

import { wallCoeffs, wallLeak, wallOutside, wallSteady, wallDrainTime, wallQmin } from "../js/model.js";

// the deck's example: a wall 20 m outside a 157 × 83 m excavation
const pw = { H: 50, k: 5e-6, R: 165, rw: 0.15 };
const wall = { P: 640, Aw: 197 * 123, t: 0.9, kw: 1e-9, Sy: 0.2 };

test("wall leakage: the two resistances in series", () => {
  const { a, b } = wallCoeffs(pw, wall);
  const Q = wallLeak(35, pw, wall), ho = wallOutside(35, pw, wall);
  close(pw.H ** 2 - ho ** 2, Q * a);                         // outside: one large well
  close(ho ** 2 - 35 ** 2, Q * b);                            // the wall: the trench equation
  close(Q, 640 * 1e-9 * (ho ** 2 - 35 ** 2) / (2 * 0.9));
  assert.ok(Q > 4.4e-4 && Q < 4.6e-4);                        // about 0.45 L/s, as on the slide
  close(wallSteady(Q, pw, wall), 35);
});

test("drain-down time matches a numerical integration", () => {
  const Q = 0.02, n = 200000;
  const leak = (h) => wallLeak(h, pw, wall);
  let t = 0;
  for (let i = 0; i < n; i++) {
    const h = 35 + (pw.H - 35) * (i + 0.5) / n;
    t += wall.Sy * wall.Aw * ((pw.H - 35) / n) / (Q - leak(h));
  }
  close(wallDrainTime(Q, pw, wall, 35), t, 1e-6);
  assert.equal(wallDrainTime(wallLeak(35, pw, wall) * 0.99, pw, wall, 35), Infinity);
  // pumping more than the wall passes even at h = 0 (D < 0) and exactly that much (D = 0)
  const big = pw.H ** 2 / (wallCoeffs(pw, wall).a + wallCoeffs(pw, wall).b);
  assert.ok(Number.isFinite(wallDrainTime(big * 1.5, pw, wall, 35)));
  close(wallDrainTime(big, pw, wall, 35), wallDrainTime(big * (1 + 1e-9), pw, wall, 35), 1e-6);
});

test("Q_min with a wall drains in the time allowed, and is the leakage with no time limit", () => {
  const T = 30 * 86400, Q = wallQmin(pw, wall, 35, T);
  close(wallDrainTime(Q, pw, wall, 35), T, 1e-6);
  close(wallQmin(pw, wall, 35, 0), wallLeak(35, pw, wall));
});
