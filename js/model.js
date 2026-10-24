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
export function kernel(p) {
  if (transient(p)) {
    const c = p.Sy / (4 * p.k * p.H * p.t), rw = p.rw;
    return (r) => { const rr = Math.max(r, rw); return 0.5 * wellW(rr * rr * c); };
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
export function heads(points, wells, p) {
  const h = new Float64Array(points.length);
  const c = 1 / (Math.PI * p.k), H2 = p.H * p.H, f = kernel(p);
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
