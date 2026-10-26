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
  const c = 1 / (Math.PI * p.k), f = kernel(p, !!p.fastW);
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
  const Aw = influence(wells.map((w) => ({ x: w.x + p.rw, y: w.y })), wells, p);   // at the screen, as pumpSchedule checks
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

// Heads at time p.t under a rate schedule (wells sharing each rate equally). fast uses the W(u)
// table. Returns {h, dry} as heads does.
export function schedHeads(points, wells, p, sched, fast = false, inf = null) {
  const n = wells.length, H2 = p.H * p.H, c = 1 / (Math.PI * p.k), rw2 = p.rw * p.rw, Wf = fast ? wellWFast : wellW;
  if (inf) {                     // another influence (the grid model): superposed the same way
    const v = new Float64Array(points.length);
    sched.forEach((s, i) => {
      if (s.t >= p.t) return;
      const dq = (s.Q - (i ? sched[i - 1].Q : 0)) / n;
      if (!dq) return;
      const A = inf(points, p.t - s.t);
      for (let j = 0; j < v.length; j++) v[j] += dq * A[j];
    });
    const h = new Float64Array(points.length);
    let dry = 0;
    for (let j = 0; j < h.length; j++) { const w = H2 - v[j]; if (w <= 0) { h[j] = 0; dry++; } else h[j] = Math.sqrt(w); }
    return { h, dry };
  }
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
export function pumpSchedule(checkPoints, wells, p, target, Q, tEnd, step = 7 * 86400, m = 4, ahead = 4, inf = null) {
  const n = wells.length, H2 = p.H * p.H, D = H2 - target * target, floor2 = (1e-3 * p.H) ** 2;
  const wpts = wells.map((w) => ({ x: w.x + p.rw, y: w.y }));
  if (!n || !checkPoints.length) return { sched: [{ t: 0, Q }], tDew: Infinity, capped: false };
  const sched = [], memo = { c: new Map(), w: new Map() };
  const A = (key, pts, tau) => {
    const k = Math.round(tau), mm = memo[key];
    if (!mm.has(k)) mm.set(k, inf ? inf(pts, tau) : influence(pts, wells, { ...p, t: tau }));
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
export function deadlineRate(checkPoints, wells, p, target, td, tEnd, inf = null) {
  const o = inf ? optimalWith(checkPoints, wells, p, target, (pts) => inf(pts, td)) : optimalRate(checkPoints, wells, { ...p, t: td }, target);
  if (!o || !isFinite(o.Q)) return null;
  // the constant rate holds if no well comes within the schedule's floor (pumpSchedule: 0.1% of H
  // above the bottom) by td; just inside it, the schedule would cut the rate back and miss td
  if (o.feasible && o.hWellMin > 1e-3 * p.H) return { Q: o.Q, met: true, tDew: td, capped: false, sched: null };
  const A = inf ? inf(checkPoints, td) : influence(checkPoints, wells, { ...p, t: td });
  const few = Array.from(A.keys()).sort((i, j) => A[i] - A[j]).slice(0, 150).map((i) => checkPoints[i]);
  const run = (Q, pts = few) => pumpSchedule(pts, wells, p, target, Q, tEnd, undefined, undefined, undefined, inf);
  const fast = run(Infinity);
  if (!(fast.tDew <= td)) { const f = run(Infinity, checkPoints); if (!(f.tDew <= td)) return { Q: f.sched[0].Q, met: false, tDew: f.tDew, capped: true, sched: f.sched }; }
  let lo = o.Q, hi = fast.sched[0].Q;
  for (let it = 0; it < 40 && hi - lo > 1e-3 * hi; it++) {
    const mid = 0.5 * (lo + hi);
    if (run(mid).tDew <= td) hi = mid; else lo = mid;
  }
  // confirm with every check point; if the few points missed the one that governs, bisect again
  // on all of them, up to the fastest schedule
  let r = run(hi, checkPoints);
  if (r.tDew <= td) return { Q: hi, met: true, tDew: r.tDew, capped: r.capped, sched: r.sched };
  const fa = run(Infinity, checkPoints);
  if (!(fa.tDew <= td)) return { Q: fa.sched[0].Q, met: false, tDew: fa.tDew, capped: true, sched: fa.sched };
  lo = hi; hi = fa.sched[0].Q; r = fa;
  for (let it = 0; it < 40 && hi - lo > 1e-3 * hi; it++) {
    const mid = 0.5 * (lo + hi), m = run(mid, checkPoints);
    if (m.tDew <= td) { hi = mid; r = m; } else lo = mid;
  }
  return { Q: hi, met: true, tDew: r.tDew, capped: r.capped, sched: r.sched };
}

// optimalRate with another influence, A(points) per unit rate per well (the grid model): the
// heads at the well screens come from the same A, at r_w from each well.
export function optimalWith(checkPoints, wells, p, target, A) {
  if (!wells.length || !checkPoints.length) return null;
  if (target >= p.H) return { Q: 0, qEach: 0, hWellMin: p.H, feasible: true };
  let Amin = Infinity;
  for (const a of A(checkPoints)) Amin = Math.min(Amin, a);
  if (!(Amin > 0)) return { Q: Infinity, qEach: Infinity, hWellMin: 0, feasible: false };
  const qEach = (p.H * p.H - target * target) / Amin;
  let hWellMin = Infinity;
  for (const a of A(wells.map((w) => ({ x: w.x + p.rw, y: w.y })))) { const v = p.H * p.H - qEach * a; hWellMin = Math.min(hWellMin, v > 0 ? Math.sqrt(v) : 0); }
  return { Q: qEach * wells.length, qEach, hWellMin, feasible: hWellMin > 0 };
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

// ------------------------------------------------------------------ cutoff wall: a grid model
// With a cutoff wall the aquifer is no longer uniform, so the wells' influence comes from a
// finite-difference model instead of the Theis solution. In u = H² − h² (Dupuit), with storage
// taken at the saturated thickness H as the Theis form here does,
//     (S_y/H) ∂u/∂t = ∇·(k ∇u) + 2q δ(wells),
// which is linear in the rates: the response to every well pumping 1 m³/s is computed once, and
// any pumping schedule is a superposition of it, exactly as with Theis. The grid is uniform over
// the wall and the wells and grows geometrically outward to a fixed head far beyond the
// drawdown's reach (steady flow: fixed at R). The wall, keyed into the low-k base, is a barrier on
// the cell faces between the inside and the outside: its thickness t at k_w in series with the
// rest of the face's soil, scaled so the stair-stepped faces add up to the wall's true length.
// Near a well, the field adds the well's own logarithmic cone below the cell's size (Peaceman),
// so the head at the well screen, and wells going dry, come out as in the analytic model.
//
// opts: {wall: ring of {x, y} (or null for none), kw, t (wall thickness), tMax (s; transient)}.
// Returns {at(points, tau) → Float64Array of u per unit rate per well, leak(tau) → the flow
// through the wall per unit rate per well (m³/s), steady}.
export function gridModel(wells, p, opts) {
  const steady = !(p.Sy > 0 && opts.tMax > 0), wall = opts.wall;
  // the core: the wall and the wells, with a margin
  const xs0 = [...wells.map((w) => w.x), ...(wall || []).map((q) => q.x)], ys0 = [...wells.map((w) => w.y), ...(wall || []).map((q) => q.y)];
  let x0 = Math.min(...xs0), x1 = Math.max(...xs0), y0 = Math.min(...ys0), y1 = Math.max(...ys0);
  const span = Math.max(x1 - x0, y1 - y0, 20), h0 = Math.max(span / 90, 0.5);
  x0 -= 4 * h0; x1 += 4 * h0; y0 -= 4 * h0; y1 += 4 * h0;
  const reachFar = steady ? p.R * 1.05 + span : 3 * 1.5 * Math.sqrt(p.k * p.H * opts.tMax / p.Sy) + span;
  // the core's lines are moved so each well sits at the center of its cell (where the head at its
  // screen is best known), unless another well already holds that cell
  const axis = (a, b, ws) => {
    const n = Math.max(2, Math.ceil((b - a) / h0)), d = (b - a) / n, e = [], held = new Set();
    for (let i = 0; i <= n; i++) e.push(a + d * i);
    for (const v of ws) {
      const k = Math.min(Math.max(Math.floor((v - a) / d), 1), n - 2);
      if (held.has(k) || held.has(k - 1) || held.has(k + 1)) continue;
      e[k] = v - d / 2; e[k + 1] = v + d / 2; held.add(k);
    }
    let w = d, lo = a, hi = b;
    for (let i = 0; i < 60 && (b - lo < reachFar || hi - a < reachFar); i++) { w *= 1.25; lo -= w; hi += w; e.unshift(lo); e.push(hi); }
    return e;
  };
  const ex = axis(x0, x1, wells.map((w) => w.x)), ey = axis(y0, y1, wells.map((w) => w.y)), nx = ex.length - 1, ny = ey.length - 1, N = nx * ny;
  const cx = Float64Array.from({ length: nx }, (_, i) => 0.5 * (ex[i] + ex[i + 1])), cy = Float64Array.from({ length: ny }, (_, j) => 0.5 * (ey[j] + ey[j + 1]));
  const dx = Float64Array.from({ length: nx }, (_, i) => ex[i + 1] - ex[i]), dy = Float64Array.from({ length: ny }, (_, j) => ey[j + 1] - ey[j]);
  const id = (i, j) => j * nx + i;
  // which side of the wall each cell is on
  const side = new Uint8Array(N);
  if (wall) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) side[id(i, j)] = inside({ x: cx[i], y: cy[j] }, wall) ? 1 : 0;
  // face conductances (east and north of each cell), the wall's faces marked
  const cE = new Float64Array(N), cN = new Float64Array(N), wallFaces = [];
  const face = (len, d, a, b) => {
    if (!wall || side[a] === side[b]) return len * p.k / d;
    wallFaces.push([a, b, len]);
    return len / (Math.max(d - opts.t, 0) / p.k + opts.t / opts.kw);
  };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const a = id(i, j);
    if (i + 1 < nx) cE[a] = face(dy[j], cx[i + 1] - cx[i], a, id(i + 1, j));
    if (j + 1 < ny) cN[a] = face(dx[i], cy[j + 1] - cy[j], a, id(i, j + 1));
  }
  if (wall && wallFaces.length) {           // stair-stepped faces → the wall's true length
    let P = 0, Ls = 0;
    wall.forEach((q, i) => { const r = wall[(i + 1) % wall.length]; P += Math.hypot(r.x - q.x, r.y - q.y); });
    wallFaces.forEach((f) => (Ls += f[2]));
    const sc = P / Ls;
    for (const f of wallFaces) {
      const [a, b] = f, hor = b === a + 1;
      if (hor) cE[a] *= sc; else cN[a] *= sc;
      f.push(hor ? cE : cN);
    }
  }
  // fixed head: the outer ring of cells (and, in steady flow, beyond R from the site's center)
  const fixed = new Uint8Array(N), mx = 0.5 * (x0 + x1), my = 0.5 * (y0 + y1);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++)
    if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1 || (steady && Math.hypot(cx[i] - mx, cy[j] - my) > p.R)) fixed[id(i, j)] = 1;
  // the wells' cells and their sources (2q for q = 1 each)
  const locate = (e, v) => { let lo = 0, hi = e.length - 2; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (e[m] <= v) lo = m; else hi = m - 1; } return lo; };
  const src = new Float64Array(N), wcell = wells.map((w) => { const i = locate(ex, w.x), j = locate(ey, w.y); src[id(i, j)] += 2; return { i, j, re: 0.14 * Math.hypot(dx[i], dy[j]) }; });
  // the operator: storage s (per cell, 0 in steady flow) plus the conductances
  const area = new Float64Array(N);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) area[id(i, j)] = dx[i] * dy[j];
  const sumC = new Float64Array(N);
  for (let a = 0; a < N; a++) {
    const i = a % nx;
    if (i + 1 < nx) { sumC[a] += cE[a]; sumC[a + 1] += cE[a]; }
    if (a + nx < N) { sumC[a] += cN[a]; sumC[a + nx] += cN[a]; }
  }
  const matvec = (x, y, s) => {
    for (let a = 0; a < N; a++) {
      if (fixed[a]) { y[a] = x[a]; continue; }
      let v = (s ? s * area[a] : 0) * x[a] + sumC[a] * x[a];
      const i = a % nx;
      if (i + 1 < nx && !fixed[a + 1]) v -= cE[a] * x[a + 1];
      if (i > 0 && !fixed[a - 1]) v -= cE[a - 1] * x[a - 1];
      if (a + nx < N && !fixed[a + nx]) v -= cN[a] * x[a + nx];
      if (a >= nx && !fixed[a - nx]) v -= cN[a - nx] * x[a - nx];
      y[a] = v;
    }
  };
  // preconditioned conjugate gradients (Jacobi), from the guess in x
  const r = new Float64Array(N), z = new Float64Array(N), d = new Float64Array(N), q = new Float64Array(N);
  const solve = (b, x, s) => {
    matvec(x, q, s);
    let bn = 0;
    for (let a = 0; a < N; a++) { r[a] = b[a] - q[a]; bn += b[a] * b[a]; }
    const diag = (a) => (fixed[a] ? 1 : (s ? s * area[a] : 0) + sumC[a]);
    let rz = 0;
    for (let a = 0; a < N; a++) { z[a] = r[a] / diag(a); d[a] = z[a]; rz += r[a] * z[a]; }
    const tol = 1e-20 * bn;
    for (let it = 0; it < 4000; it++) {
      let rr = 0;
      for (let a = 0; a < N; a++) rr += r[a] * r[a];
      if (rr <= tol) break;
      matvec(d, q, s);
      let dq = 0;
      for (let a = 0; a < N; a++) dq += d[a] * q[a];
      const al = rz / dq;
      let rz2 = 0;
      for (let a = 0; a < N; a++) { x[a] += al * d[a]; r[a] -= al * q[a]; z[a] = r[a] / diag(a); rz2 += r[a] * z[a]; }
      const be = rz2 / rz;
      rz = rz2;
      for (let a = 0; a < N; a++) d[a] = z[a] + be * d[a];
    }
  };
  // the response: steady, or stepped through time (backward Euler, steps growing 10% a step)
  const times = [0], snaps = [new Float32Array(N)];
  const u = new Float64Array(N), b = new Float64Array(N);
  if (steady) {
    for (let a = 0; a < N; a++) b[a] = fixed[a] ? 0 : src[a];
    solve(b, u, 0);
    times.push(1); snaps.push(Float32Array.from(u));
  } else {
    let t = 0, dt = 120;
    while (t < opts.tMax) {
      const s = p.Sy / (p.H * dt);
      for (let a = 0; a < N; a++) b[a] = fixed[a] ? 0 : s * area[a] * u[a] + src[a];
      solve(b, u, s);
      t += dt; dt *= 1.1;
      times.push(t); snaps.push(Float32Array.from(u));
    }
  }
  // the field at any time: linear in ln t between the steps, rising from 0 over the first step
  // [step before, step after, weight on the step before, scale]
  const frame = (tau) => {
    if (steady) return [1, 1, 0, 1];
    if (!(tau > 0)) return [0, 0, 0, 0];
    if (tau <= times[1]) return [1, 1, 0, tau / times[1]];
    let k = 1;
    while (k + 1 < times.length && times[k + 1] < tau) k++;
    if (k + 1 >= times.length) return [k, k, 0, 1];
    const g = Math.log(tau / times[k]) / Math.log(times[k + 1] / times[k]);
    return [k, k + 1, 1 - g, 1];
  };
  const value = (U0, U1, g0, idx, wts) => { let v = 0; for (let m = 0; m < idx.length; m++) v += wts[m] * (g0 * U0[idx[m]] + (1 - g0) * U1[idx[m]]); return v; };
  const near = (c, v) => { let lo = 0, hi = c.length - 2; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (c[m] <= v) lo = m; else hi = m - 1; } return lo; };
  // interpolation weights for a set of points (kept per array): bilinear between cell centers,
  // using only centers on the point's own side of the wall
  const wcache = new WeakMap(), R0 = 3 * h0;
  const S = (x, y, cell) => {
    let v = 0;
    wells.forEach((wl, n) => {
      const own = cell === id(wcell[n].i, wcell[n].j), rr = own ? wcell[n].re : Math.max(Math.hypot(x - wl.x, y - wl.y), p.rw);
      if (rr < R0) v += Math.log(R0 / rr) / (Math.PI * p.k);
    });
    return v;
  };
  const weights = (pts) => {
    let w = wcache.get(pts);
    if (w) return w;
    w = pts.map((pt) => {
      const i = near(cx, pt.x), j = near(cy, pt.y);
      const fx = Math.min(Math.max((pt.x - cx[i]) / (cx[i + 1] - cx[i]), 0), 1), fy = Math.min(Math.max((pt.y - cy[j]) / (cy[j + 1] - cy[j]), 0), 1);
      let idx = [id(i, j), id(i + 1, j), id(i, j + 1), id(i + 1, j + 1)], wts = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
      if (wall) {
        const sd = inside(pt, wall) ? 1 : 0, keep = idx.map((a) => side[a] === sd);
        if (keep.some((k) => !k)) {
          let tot = 0;
          wts = wts.map((v, m) => (keep[m] ? v : 0)); wts.forEach((v) => (tot += v));
          if (tot > 1e-9) wts = wts.map((v) => v / tot);
          else { const m = keep.indexOf(true); wts = wts.map((_, mm) => (mm === m ? 1 : 0)); if (m < 0) wts[0] = 1; }
        }
      }
      // near the wells: the logarithmic cone is taken out of the cell values before interpolating
      // and added back at the point itself (a well's own cell stands for the cone at r_e)
      let cone = S(pt.x, pt.y, -1);
      idx.forEach((a, m) => { if (wts[m]) cone -= wts[m] * S(cx[a % nx], cy[Math.floor(a / nx)], a); });
      return { idx, wts, cone };
    });
    wcache.set(pts, w);
    return w;
  };
  const at = (pts, tau) => {
    const W = weights(pts), [k0, k1, g0, sc] = frame(tau), out = new Float64Array(pts.length);
    if (!sc) return out;
    const U0 = snaps[k0], U1 = snaps[k1];
    for (let m = 0; m < pts.length; m++) { const w = W[m]; out[m] = sc * value(U0, U1, g0, w.idx, w.wts) + w.cone; }
    return out;
  };
  // the flow through the wall into the inside (the u flux is twice the water's)
  const leak = (tau) => {
    if (!wall) return 0;
    const [k0, k1, g0, sc] = frame(tau), U0 = snaps[k0], U1 = snaps[k1];
    let s = 0;
    for (const [a, bb, , C] of wallFaces) {
      const ua = g0 * U0[a] + (1 - g0) * U1[a], ub = g0 * U0[bb] + (1 - g0) * U1[bb];
      s += 0.5 * C[a] * (side[a] ? ua - ub : ub - ua);
    }
    return s * sc;
  };
  return { at, leak, steady, cells: N, steps: times.length - 1 };
}
