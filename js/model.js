// model.js — the dewatering calculation, with no map or page code, so it can be tested on its own.
//
// Steady flow to fully penetrating wells in an unconfined aquifer on an impermeable base, with the
// Dupuit assumptions. One well pumping q gives
//
//     H² − h² = q/(πk) · ln(R/r)
//
// and, because the governing equation is linear in h², several wells add in H² − h²:
//
//     h = √( H² − Σ qᵢ/(πk) · ln(R/rᵢ) )
//
// H is the initial saturated thickness (heads are measured from the top of the impermeable base),
// k the hydraulic conductivity, R the radius of influence, and rᵢ the distance from well i.
// Distances are clamped to [r_w, R]: a well has no effect beyond R, and the head at a well is the
// head at its screen radius r_w. All quantities are SI (m, m/s, m³/s).
//
// Transient pumping (p.t, the time pumping in s, and p.Sy, the specific yield, both given): the
// Theis solution in the same h² form, with the transmissivity kH,
//
//     H² − h² = q/(2πk) · W(u),   u = r² S_y / (4 k H t)
//
// so ln(R/r) is replaced by W(u)/2. At late time W(u)/2 → ln(1.5√(kHt/S_y)/r) (Cooper–Jacob): the
// steady equation with R growing with time. Still linear in q, so wells add the same way.

export const GPM_PER_M3S = 15850.32;
export const LPS_PER_M3S = 1000;

// The exponential integral E₁(u) = W(u), the Theis well function: the series below u = 1, a
// continued fraction above (Press et al., Numerical Recipes, expint).
export function wellW(u) {
  if (!(u > 0)) return Infinity;
  if (u > 700) return 0;
  if (u < 1) {
    let s = -0.5772156649015329 - Math.log(u), term = 1;
    for (let n = 1; n < 60; n++) {
      term *= -u / n;
      const d = -term / n;
      s += d;
      if (Math.abs(d) < 1e-16 * Math.abs(s)) break;
    }
    return s;
  }
  let b = u + 1, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 200; i++) {
    const a = -i * i;
    b += 2;
    d = 1 / (a * d + b);
    c = b + a / c;
    const del = c * d;
    h *= del;
    if (Math.abs(del - 1) < 1e-15) break;
  }
  return h * Math.exp(-u);
}

// The kernel of one well at distance r, per unit rate in units of 1/(πk): ln(R/r) in steady flow
// (r clamped to [r_w, R]), W(u)/2 in transient flow (r no less than r_w).
export const transient = (p) => p.t > 0 && p.Sy > 0;
export function kernel(p, fast = false) {
  if (transient(p)) {
    const c = p.Sy / (4 * p.k * p.H * p.t), rw = p.rw, Wf = fast ? wellWFast : wellW;
    return (r) => { const rr = Math.max(r, rw); return 0.5 * Wf(rr * rr * c); };
  }
  const R = p.R, rw = p.rw;
  return (r) => Math.log(R / Math.min(Math.max(r, rw), R));
}

// The radius the cone of depression reaches after pumping for t (Cooper–Jacob), where the late-time
// Theis drawdown falls to zero: 1.5√(kHt/S_y). The steady R that matches pumping for that long.
export const reach = (p) => 1.5 * Math.sqrt(p.k * p.H * p.t / p.Sy);

// The influence of each well at each point, kernel/(πk), per unit pumping rate:
// A[j] = Σᵢ ln(R/rᵢⱼ)/(πk) when every well pumps 1 m³/s (W(u)/2 in place of ln(R/r) in
// transient flow). With equal rates q per well, H² − h² = q · A[j]. Points and wells are arrays of
// {x, y} in meters.
export function influence(points, wells, p) {
  const A = new Float64Array(points.length);
  const c = 1 / (Math.PI * p.k), f = kernel(p);
  for (let j = 0; j < points.length; j++) {
    const { x, y } = points[j];
    let s = 0;
    for (const w of wells) s += f(Math.hypot(x - w.x, y - w.y));
    A[j] = s * c;
  }
  return A;
}

// Heads with each well pumping its own rate w.q (m³/s). Returns {h, dry}: h is 0 where the
// aquifer would be pumped dry (H² − Σ < 0), and dry counts those points.
export function heads(points, wells, p, fast = false) {
  const h = new Float64Array(points.length);
  const c = 1 / (Math.PI * p.k), H2 = p.H * p.H, f = kernel(p, fast);
  let dry = 0;
  for (let j = 0; j < points.length; j++) {
    const { x, y } = points[j];
    let s = 0;
    for (const w of wells) s += w.q * f(Math.hypot(x - w.x, y - w.y));
    const v = H2 - s * c;
    if (v <= 0) { h[j] = 0; dry++; } else h[j] = Math.sqrt(v);
  }
  return { h, dry };
}

// The smallest total pumping rate, shared equally by n wells, that brings the water down to the
// target head at every check point. With equal rates, h at point j is √(H² − (Q/n)·A[j]), so the
// highest head is at the point of least influence, and the answer is exact:
//
//     Q = n (H² − h_target²) / min_j A[j]
//
// The design fails if that rate pumps a well dry: the head at the well screen must stay above 0.
// Returns {Q, qEach, hWellMin, feasible}.
export function optimalRate(checkPoints, wells, p, target) {
  if (!wells.length || !checkPoints.length) return null;
  if (target >= p.H) return { Q: 0, qEach: 0, hWellMin: p.H, feasible: true };
  const A = influence(checkPoints, wells, p);
  let Amin = Infinity;
  for (const a of A) Amin = Math.min(Amin, a);
  if (!(Amin > 0)) return { Q: Infinity, qEach: Infinity, hWellMin: 0, feasible: false };
  const qEach = (p.H * p.H - target * target) / Amin;
  const Aw = influence(wells.map((w) => ({ x: w.x, y: w.y })), wells, p);
  let hWellMin = Infinity;
  for (const a of Aw) {
    const v = p.H * p.H - qEach * a;
    hWellMin = Math.min(hWellMin, v > 0 ? Math.sqrt(v) : 0);
  }
  return { Q: qEach * wells.length, qEach, hWellMin, feasible: hWellMin > 0 };
}

// Transient flow: the time (s) for wells pumping equal rates, Q in total, to bring the water down
// to the target head at every check point. The water only falls with time (no boundaries), so
// the time is found by bisection on log t, up to tMax; Infinity if Q never gets there by then.
export function timeToDewater(checkPoints, wells, p, target, Q, tMax = 3650 * 86400) {
  if (!wells.length || !checkPoints.length) return Infinity;
  if (target >= p.H) return 0;
  const W = wells.map((w) => ({ x: w.x, y: w.y, q: Q / wells.length }));
  const wet = (t) => { const { h } = heads(checkPoints, W, { ...p, t }); let m = -Infinity; for (const v of h) m = Math.max(m, v); return m > target; };
  if (wet(tMax)) return Infinity;
  let lo = 1, hi = tMax;
  if (!wet(lo)) return lo;
  for (let i = 0; i < 40 && hi / lo > 1 + 1e-4; i++) {
    const mid = Math.sqrt(lo * hi);
    if (wet(mid)) lo = mid; else hi = mid;
  }
  return hi;
}

// ------------------------------------------------------------------ holding the water down
// Once the excavation is dewatered, the wells need only enough to keep it so. The rate is stepped
// down at fixed intervals; each step is the lowest rate that keeps the water at or below the
// target everywhere in the excavation until the next step. Rate changes add in time (superposition,
// as for recovery): with a schedule of total rates Q₀ from t = 0, Q₁ from t₁, …, shared equally,
//
//     H² − h² = Σᵢ (Qᵢ − Qᵢ₋₁)/n · A(t − tᵢ)
//
// where A(τ) is the influence of the wells after pumping for τ (influence above). sched is an array
// of {t, Q}, t in s from the start of pumping, the first at t = 0.

// W(u) from a table on log u: for the contour grid, where the exact series would be called tens of
// millions of times per frame. Relative error below 1e-6.
const WT_LO = -14, WT_HI = Math.log10(700), WT_N = 6000, WT = new Float64Array(WT_N + 1);
for (let i = 0; i <= WT_N; i++) WT[i] = wellW(10 ** (WT_LO + (WT_HI - WT_LO) * i / WT_N));
function wellWFast(u) {
  if (u >= 700) return 0;
  const f = (Math.log10(u) - WT_LO) / (WT_HI - WT_LO) * WT_N;
  if (f < 0) return wellW(u);
  const i = Math.floor(f), g = f - i;
  return WT[i] + g * (WT[i + 1] - WT[i]);
}

// Many equal sinks (the leakage along a cutoff wall) seen from many points, through time: the
// distances don't change, only W(u)'s time factor does. So each point's sinks are counted once
// into log-spaced bins of r² (with the mean ln r² of each bin), and the heads at any time sum the
// bins instead of the sinks: W varies smoothly across a bin, a ratio of 1.1 or so in r.
export function sinkBins(points, sinks, rw, nb = 48) {
  let r2max = rw * rw;
  const n = points.length, cnt = new Float32Array(n * nb), mlr = new Float32Array(n * nb);
  for (const q of points) for (const s of sinks) r2max = Math.max(r2max, (q.x - s.x) ** 2 + (q.y - s.y) ** 2);
  const lo = Math.log(rw * rw), span = Math.log(r2max) - lo + 1e-9;
  for (let j = 0; j < n; j++) {
    const { x, y } = points[j], o = j * nb;
    for (const s of sinks) {
      const lr = Math.log(Math.max((x - s.x) ** 2 + (y - s.y) ** 2, rw * rw)), b = Math.min(nb - 1, Math.floor((lr - lo) / span * nb));
      cnt[o + b]++; mlr[o + b] += lr;
    }
    for (let b = 0; b < nb; b++) if (cnt[o + b]) mlr[o + b] /= cnt[o + b];
  }
  return { n, nb, cnt, mlr };
}
// Heads at time p.t (transient) from sinkBins, each sink taking q. As heads, with the W(u) table.
export function binnedHeads(bins, q, p) {
  const { n, nb, cnt, mlr } = bins, h = new Float64Array(n), H2 = p.H * p.H, c = p.Sy / (4 * p.k * p.H * p.t), f = q / (Math.PI * p.k);
  let dry = 0;
  for (let j = 0; j < n; j++) {
    let s = 0;
    for (let b = j * nb, e = b + nb; b < e; b++) if (cnt[b]) s += cnt[b] * 0.5 * wellWFast(Math.exp(mlr[b]) * c);
    const v = H2 - s * f;
    if (v <= 0) { h[j] = 0; dry++; } else h[j] = Math.sqrt(v);
  }
  return { h, dry };
}

// Heads at time p.t under a rate schedule (wells sharing each rate equally). fast uses the W(u)
// table. Returns {h, dry} as heads does.
export function schedHeads(points, wells, p, sched, fast = false) {
  const n = wells.length, H2 = p.H * p.H, c = 1 / (Math.PI * p.k), rw2 = p.rw * p.rw, Wf = fast ? wellWFast : wellW;
  const steps = [];
  sched.forEach((s, i) => {
    if (s.t >= p.t) return;
    const dQ = s.Q - (i ? sched[i - 1].Q : 0);
    if (dQ) steps.push({ dq: dQ / n, a: p.Sy / (4 * p.k * p.H * (p.t - s.t)) });
  });
  const h = new Float64Array(points.length);
  let dry = 0;
  for (let j = 0; j < points.length; j++) {
    const { x, y } = points[j];
    let s = 0;
    for (const w of wells) {
      const r2 = Math.max((x - w.x) ** 2 + (y - w.y) ** 2, rw2);
      for (const st of steps) s += st.dq * 0.5 * Wf(r2 * st.a);
    }
    const v = H2 - s * c;
    if (v <= 0) { h[j] = 0; dry++; } else h[j] = Math.sqrt(v);
  }
  return { h, dry };
}

// The pumping schedule, in two phases, with a step every `step` seconds (checked m times a step):
//
//   drawdown: pump Q, cut back only as far as needed to keep every well from going dry (the head
//     at the well's radius above 0.1% of H). A rate more than the wells can take becomes "as hard as
//     they can go", falling week by week as the cone deepens.
//   hold: once the water is at or below the target everywhere in the excavation (tDew), step down
//     to the lowest rate that, kept for the next `ahead` steps, holds it there, and
//     never more than the wells can take. With only the next step in view the rate swings up and
//     down (a deep cut lets the water climb back the week after); four weeks ahead gives steps that
//     settle and then ease down.
//
// Returns {sched, tDew, capped}: sched as for schedHeads (consecutive equal rates merged), tDew
// the time the excavation is dewatered (Infinity if not by tEnd), and whether the wells limited the
// drawdown rate.
export function pumpSchedule(checkPoints, wells, p, target, Q, tEnd, step = 7 * 86400, m = 4, ahead = 4) {
  const n = wells.length, H2 = p.H * p.H, D = H2 - target * target, floor2 = (1e-3 * p.H) ** 2;
  const wpts = wells.map((w) => ({ x: w.x + p.rw, y: w.y }));
  if (!n || !checkPoints.length) return { sched: [{ t: 0, Q }], tDew: Infinity, capped: false };
  const sched = [], memo = { c: new Map(), w: new Map() };
  const A = (key, pts, tau) => {
    const k = Math.round(tau), mm = memo[key];
    if (!mm.has(k)) mm.set(k, influence(pts, wells, { ...p, t: tau }));
    return mm.get(k);
  };
  // Σ ΔQᵢ/n · A(τ − tᵢ): H² − h² at each point at time τ, under the schedule so far
  const past = (key, pts, tau) => {
    const out = new Float64Array(pts.length);
    sched.forEach((s, i) => {
      if (s.t >= tau) return;
      const d = (s.Q - (i ? sched[i - 1].Q : 0)) / n, Ai = A(key, pts, tau - s.t);
      for (let j = 0; j < out.length; j++) out[j] += d * Ai[j];
    });
    return out;
  };
  const prevQ = () => (sched.length ? sched[sched.length - 1].Q : 0);
  const push = (t, q) => { if (!sched.length || q !== prevQ()) sched.push({ t, Q: q }); };
  // the most the wells can take from t1 to t2 without one going dry, with the rate changed at t1
  const wellMax = (t1, t2) => {
    const prev = prevQ();
    let qm = Infinity;
    for (let k = 1, tau = t1; tau < t2; k++) {
      tau = Math.min(t1 + step * k / m, t2);
      const pw = past("w", wpts, tau), Aw = A("w", wpts, tau - t1);
      for (let j = 0; j < wpts.length; j++) qm = Math.min(qm, prev + n * (H2 - floor2 - pw[j]) / Aw[j]);
    }
    return Math.max(0, qm);
  };
  const dewatered = (tau) => { const v = past("c", checkPoints, tau); for (const x of v) if (x < D) return false; return true; };

  // drawdown
  let tDew = Infinity, capped = false;
  // the first time in (t1, t2] the excavation is dewatered under the schedule so far, or Infinity
  const dewIn = (t1, t2) => {
    let lo = t1;
    for (let k = 1; k <= 2 * m; k++) {
      const tau = t1 + (t2 - t1) * k / (2 * m);
      if (!dewatered(tau)) { lo = tau; continue; }
      let hi = tau;
      for (let it = 0; it < 30 && hi - lo > 60; it++) { const mid = (lo + hi) / 2; if (dewatered(mid)) hi = mid; else lo = mid; }
      return hi;
    }
    return Infinity;
  };
  for (let t1 = 0; t1 < tEnd - 1; t1 += step) {
    const t2 = Math.min(t1 + step, tEnd);
    // try Q; the wells need only last until the excavation is dewatered, when the rate drops
    const before = sched.length, last = prevQ();
    push(t1, Q);
    let td = dewIn(t1, t2);
    sched.length = before;
    if (before && sched[before - 1].Q !== last) sched[before - 1].Q = last;
    // capped, the rate is the most the wells take until the excavation is dewatered at that rate:
    // a lower rate dewaters later and must last longer, so iterate to agreement
    let h = Math.min(t2, td), q = Q;
    for (let it = 0; it < 40; it++) {
      q = Math.min(Q, wellMax(t1, h));
      if (q === Q) break;
      push(t1, q);
      td = dewIn(t1, t2);
      sched.length = before;
      if (before && sched[before - 1].Q !== last) sched[before - 1].Q = last;
      if (td <= h * (1 + 1e-6) || h >= t2) break;
      h = Math.min(t2, td);
    }
    if (q < Q) capped = true;
    push(t1, q);
    if (q < Q) td = dewIn(t1, t2);
    if (td < Infinity) { tDew = td; break; }
  }
  if (!(tDew < tEnd)) return { sched, tDew, capped };

  // hold
  for (let t1 = tDew; t1 < tEnd - 1; t1 += step) {
    const prev = prevQ(), tH = t1 + ahead * step;        // past tEnd too, or the last steps fall away
    let dq = -Infinity;                                  // the change in the rate per well needed at t1
    for (let k = 1, tau = t1; tau < tH; k++) {           // m times a step, and always at tH
      tau = Math.min(t1 + step * k / m, tH);
      const pc = past("c", checkPoints, tau), Aj = A("c", checkPoints, tau - t1);
      for (let j = 0; j < pc.length; j++) if (Aj[j] > 0) dq = Math.max(dq, (D - pc[j]) / Aj[j]);
    }
    const hold = Math.max(0, prev + dq * n);
    push(t1, Math.min(hold, wellMax(t1, Math.min(t1 + step, tEnd))));
  }
  return { sched, tDew, capped };
}

// The design for a deadline td: the smallest starting rate whose schedule (pumpSchedule) dewaters
// the excavation by td. Where the wells can deliver it, that is the constant-rate Q_min (exact);
// where they can't, the rate is cut back weekly and the start must be higher, found by bisection.
// If even pumping as hard as the wells can go misses td, the result is that fastest schedule.
// The search checks the points of the excavation where the water is highest (smallest influence
// at td), then confirms with every check point. Returns {Q, met, tDew, capped, sched}: sched is
// the schedule found, or null for the constant rate (Q until td).
export function deadlineRate(checkPoints, wells, p, target, td, tEnd) {
  const o = optimalRate(checkPoints, wells, { ...p, t: td }, target);
  if (!o || !isFinite(o.Q)) return null;
  if (o.feasible) return { Q: o.Q, met: true, tDew: td, capped: false, sched: null };
  const A = influence(checkPoints, wells, { ...p, t: td });
  const few = Array.from(A.keys()).sort((i, j) => A[i] - A[j]).slice(0, 150).map((i) => checkPoints[i]);
  const run = (Q, pts = few) => pumpSchedule(pts, wells, p, target, Q, tEnd);
  const fast = run(Infinity);
  if (!(fast.tDew <= td)) { const f = run(Infinity, checkPoints); if (!(f.tDew <= td)) return { Q: f.sched[0].Q, met: false, tDew: f.tDew, capped: true, sched: f.sched }; }
  let lo = o.Q, hi = fast.sched[0].Q;
  for (let it = 0; it < 40 && hi - lo > 1e-3 * hi; it++) {
    const mid = 0.5 * (lo + hi);
    if (run(mid).tDew <= td) hi = mid; else lo = mid;
  }
  for (let it = 0; it < 20; it++) {                 // confirm with every check point
    const r = run(hi, checkPoints);
    if (r.tDew <= td) return { Q: hi, met: true, tDew: r.tDew, capped: r.capped, sched: r.sched };
    hi *= 1.002;
  }
  return { Q: hi, met: true, tDew: td, capped: true, sched: null };
}

// A regular grid of points over a box, nx by ny, row by row from the top (y1) down, so it can be
// handed to a contouring routine as a raster.
export function grid(box, nx, ny) {
  const [x0, x1, y0, y1] = box, pts = [];
  for (let i = 0; i < ny; i++) {
    const y = y1 - (y1 - y0) * i / (ny - 1);
    for (let j = 0; j < nx; j++) pts.push({ x: x0 + (x1 - x0) * j / (nx - 1), y });
  }
  return pts;
}

// Point in polygon (ray casting) for a ring of {x, y}.
export function inside(pt, ring) {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.y > pt.y) !== (b.y > pt.y) && pt.x < (b.x - a.x) * (pt.y - a.y) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}

// Points along a ring at most `step` apart (its vertices included): the excavation's edge, where
// the water is usually highest, is always checked, however coarse the grid.
export function densify(ring, step) {
  const out = [];
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let k = 0; k < n; k++) out.push({ x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n });
  }
  return out;
}

// ------------------------------------------------------------------ cutoff wall
// A slurry cutoff wall around the site, keyed into the low-k layer, which is taken as
// impermeable: water reaches the inside only through the wall. Two resistances in series, both
// linear in h² (Dupuit):
//
//   outside, the enclosure as one large well of radius r_W = √(A_w/π):
//       H² − h_o² = Q · ln(R/r_W)/(πk)          (a = ln(R/r_W)/(πk))
//   across the wall, thickness t and conductivity k_w, length P (the trench equation):
//       h_o² − h_i² = Q · 2t/(P k_w)            (b = 2t/(P k_w))
//
// so the leakage with the water inside at h_i is Q = (H² − h_i²)/(a + b), and h_o follows.
// Inside, the aquifer is so much more permeable than the wall that the water is taken as level.
// w = {P, Aw, t, kw, Sy}: wall length (m), area inside (m²), thickness (m), conductivity (m/s),
// and the specific yield of the aquifer inside.
// In transient flow the aquifer outside uses W(u)/2 at r_W for the time pumping in place of
// ln(R/r_W).
export function wallCoeffs(p, w) {
  const rW = Math.sqrt(w.Aw / Math.PI);
  const a = transient(p) ? 0.5 * wellW(rW * rW * p.Sy / (4 * p.k * p.H * p.t)) / (Math.PI * p.k)
    : p.R > rW ? Math.log(p.R / rW) / (Math.PI * p.k) : 0;
  const b = 2 * w.t / (w.P * w.kw);
  return { a, b, rW };
}

// The leakage (m³/s) with the water inside at h_i.
export function wallLeak(hIn, p, w) {
  const { a, b } = wallCoeffs(p, w);
  return (p.H * p.H - hIn * hIn) / (a + b);
}

// The head at the wall's outside face with the water inside at h_i.
export function wallOutside(hIn, p, w) {
  const { a } = wallCoeffs(p, w);
  return Math.sqrt(Math.max(p.H * p.H - wallLeak(hIn, p, w) * a, 0));
}

// The steady water level inside when the wells pump Q in total: the leakage equals Q, so
// h_i² = H² − Q(a + b). Pumping more than the wall can pass at h_i = 0 empties the inside.
export function wallSteady(Q, p, w) {
  const { a, b } = wallCoeffs(p, w);
  const v = p.H * p.H - Q * (a + b);
  return v > 0 ? Math.sqrt(v) : 0;
}

// Time (s) to draw the water inside down from H to h_to, pumping Q, with the leakage coming in:
//     S_y A_w dh/dt = −Q + (H² − h²)/c,  c = a + b
// so t = S_y A_w ∫ c dh / (h² − D) from h_to to H, D = H² − cQ. Infinite if Q can't get there
// (Q ≤ the leakage at h_to).
export function wallDrainTime(Q, p, w, hTo) {
  const { a, b } = wallCoeffs(p, w), c = a + b, H = p.H;
  if (!(hTo < H)) return 0;
  const D = H * H - c * Q;
  if (!(hTo * hTo > D)) return Infinity;
  let I;
  if (D < 0) { const m = Math.sqrt(-D); I = (Math.atan(H / m) - Math.atan(hTo / m)) / m; }
  else if (D === 0) I = 1 / hTo - 1 / H;
  else { const d = Math.sqrt(D); I = (Math.log((H - d) / (H + d)) - Math.log((hTo - d) / (hTo + d))) / (2 * d); }
  return w.Sy * w.Aw * c * I;
}

// The water level inside the wall after pumping Q for time t (s), from the drain-down above:
// the h at which the drain time from H equals t (bisection).
export function wallLevelAt(Q, p, w, t) {
  let lo = wallSteady(Q, p, w), hi = p.H;
  if (!(t > 0)) return hi;
  for (let i = 0; i < 80; i++) {
    const mid = 0.5 * (lo + hi);
    if (wallDrainTime(Q, p, w, mid) > t) lo = mid; else hi = mid;
  }
  return hi;
}

// The minimum design pumping rate with a cutoff wall: the smallest Q that draws the water inside
// down to h_to within time T (s), and then holds it there. With no time limit (T not > 0) it is
// the leakage at h_to.
export function wallQmin(p, w, hTo, T) {
  if (transient(p) && T > 0) return wallDeadlineRate(p, w, hTo, T);
  const hold = wallLeak(hTo, p, w);
  if (!(T > 0)) return hold;
  let lo = hold, hi = Math.max(hold, 1e-9) * 2;
  while (wallDrainTime(hi, p, w, hTo) > T) { lo = hi; hi *= 2; }
  for (let i = 0; i < 100; i++) {
    const mid = 0.5 * (lo + hi);
    if (wallDrainTime(mid, p, w, hTo) > T) lo = mid; else hi = mid;
  }
  return hi;
}

// The pumping schedule with a cutoff wall, in transient flow. The water inside, taken as level,
// follows S_y A_w dh/dt = −Q + (H² − h²)/(a(t) + b), with the outside resistance a(t) growing as
// the drawdown spreads (stepped by the midpoint rule, 4000 steps to tEnd).
//   drawdown: pump Q until the water inside reaches the target (tDew);
//   hold: then, once a week, the leakage at the target, the lowest rate that holds it there for
//     the week (the leakage only falls as a(t) grows).
// Returns {sched, tDew, capped: false, levelAt(t)}: sched as for pumpSchedule.
export function wallSchedule(p, w, target, Q, tEnd, step = 7 * 86400) {
  const H2 = p.H * p.H, b = wallCoeffs(p, w).b, SA = w.Sy * w.Aw, N = 4000, dt = tEnd / N;
  const a = (t) => wallCoeffs({ ...p, t: Math.max(t, 1) }, w).a;
  const leak = (h, t) => (H2 - h * h) / (a(t) + b);
  const sched = [{ t: 0, Q }], ts = [0], hs = [p.H];
  let h = p.H, t = 0, q = Q, tDew = Infinity, next = Infinity;
  const f = (hh, tt) => (-q + leak(hh, tt)) / SA;
  while (t < tEnd - 1e-6) {
    if (t >= next - 1e-6) { q = leak(target, t); if (q !== sched[sched.length - 1].Q) sched.push({ t, Q: q }); next += step; }
    const d = Math.min(dt, tEnd - t, next - t);
    const hn = Math.max(0, h + d * f(h + 0.5 * d * f(h, t), t + 0.5 * d));
    if (tDew === Infinity && hn <= target) {         // dewatered within this step: hold from there
      const tc = t + d * (h - target) / (h - hn);
      ts.push(tc); hs.push(target);
      t = tc; h = target; tDew = tc; next = tc;
      continue;
    }
    t += d; h = hn; ts.push(t); hs.push(h);
  }
  const levelAt = (tt) => {
    if (tt <= 0) return p.H;
    let lo = 0, hi = ts.length - 1;
    if (tt >= ts[hi]) return hs[hi];
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ts[m] <= tt) lo = m; else hi = m; }
    return hs[lo] + (hs[hi] - hs[lo]) * (tt - ts[lo]) / (ts[hi] - ts[lo]);
  };
  return { sched, tDew, capped: false, levelAt };
}

// The smallest starting rate whose wall schedule dewaters by td (bisection on Q): at least the
// leakage at the target on day td.
export function wallDeadlineRate(p, w, target, td) {
  const H2 = p.H * p.H, b = wallCoeffs(p, w).b, ok = (Q) => wallSchedule(p, w, target, Q, td * 1.001).tDew <= td;
  let lo = (H2 - target * target) / (wallCoeffs({ ...p, t: td }, w).a + b), hi = 2 * lo;
  while (!ok(hi)) { lo = hi; hi *= 2; }
  for (let i = 0; i < 50 && hi - lo > 1e-6 * hi; i++) { const m = 0.5 * (lo + hi); if (ok(m)) hi = m; else lo = m; }
  return hi;
}
