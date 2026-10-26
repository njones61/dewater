// app.js — the map, the panel, and the drawing of results. The calculation is in model.js.
import { heads, schedHeads, pumpSchedule, deadlineRate, optimalRate, optimalWith, gridModel, reach, grid, inside, densify } from "./model.js?v=8";
import { elevations } from "./terrain.js";

/* global L, turf, d3 */

// ------------------------------------------------------------------ map
const map = L.map("map", { zoomControl: true, preferCanvas: false }).setView([39.5, -98.35], 4);
const street = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 20, maxNativeZoom: 19, attribution: "&copy; OpenStreetMap contributors",
});
const imagery = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
  maxZoom: 20, maxNativeZoom: 19, attribution: "Imagery &copy; Esri, Maxar, Earthstar Geographics",
});
imagery.addTo(map);
L.control.layers({ Imagery: imagery, Streets: street }, null, { position: "topright" }).addTo(map);
L.control.scale({ imperial: true, metric: true, position: "bottomleft" }).addTo(map);

// "Fit": zoom to the excavation, the wells, and the area the results cover.
const FitControl = L.Control.extend({
  options: { position: "topleft" },
  onAdd() {
    const bar = L.DomUtil.create("div", "leaflet-bar");
    const a = L.DomUtil.create("a", "fit-btn", bar);
    a.href = "#"; a.title = "Fit the site in view"; a.setAttribute("role", "button"); a.setAttribute("aria-label", "Fit the site in view");
    a.innerHTML = '<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M3 7V3h4M13 3h4v4M17 13v4h-4M7 17H3v-4" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
    L.DomEvent.on(a, "click", (e) => { L.DomEvent.stop(e); fitSite(); });
    L.DomEvent.disableClickPropagation(bar);
    return bar;
  },
});
new FitControl().addTo(map);
function fitSite() {
  let b = null;
  const add = (x) => { b = b ? b.extend(x) : L.latLngBounds(x, x); };
  if (state.excavation) { const eb = state.excavation.getBounds(); add(eb.getSouthWest()); add(eb.getNorthEast()); }
  if (state.wall && map.hasLayer(state.wall)) { const wb = state.wall.getBounds(); add(wb.getSouthWest()); add(wb.getNorthEast()); }
  state.wells.forEach((w) => add(w.marker.getLatLng()));
  if (state.last && state.origin) {
    const [x0, x1, y0, y1] = state.last.box;
    add(toLL({ x: x0, y: y0 })); add(toLL({ x: x1, y: y1 }));
  }
  if (!b) return tip("Nothing to fit yet: draw an excavation or add wells.", 2500);
  map.fitBounds(b, { padding: [24, 24], maxZoom: 19 });
}
map.pm.setGlobalOptions({ snappable: true, allowSelfIntersection: false });
map.pm.setLang("en");

const resultsPane = map.createPane("results");
resultsPane.style.zIndex = 350;               // above the basemap, below the excavation outline
resultsPane.style.pointerEvents = "none";

// ------------------------------------------------------------------ state
const state = {
  excavation: null,       // L.Polygon
  wells: [],              // [{ marker }]
  addMode: false,
  origin: null,           // [lat, lng] of the local x-y frame
  last: null,             // last computed results
};
const fill = L.imageOverlay("data:image/gif;base64,R0lGODlhAQABAAAAACw=", [[0, 0], [0, 0]], { pane: "results", opacity: 0.55 }).addTo(map);
const lines = L.layerGroup([], { pane: "results" }).addTo(map);
const shade = L.layerGroup([], { pane: "results" }).addTo(map);
const marks = L.layerGroup().addTo(map);
const wallLayer = L.layerGroup().addTo(map);

const $ = (id) => document.getElementById(id);
const num = (id) => parseFloat($(id).value);

// ------------------------------------------------------------------ units
// The calculation is in SI. Lengths are entered and shown in one unit for the whole app (meters or
// feet); k and Q each have their own unit, and every flow rate shown uses Q's unit.
const LEN = { m: 1, ft: 0.3048 };
const K_UNITS = { cms: 0.01, ms: 1, mday: 1 / 86400, fts: 0.3048, ftday: 0.3048 / 86400, gpdft2: 0.003785411784 / 86400 / 0.09290304 };
const Q_UNITS = { m3s: 1, m3day: 1 / 86400, lps: 0.001, gpm: 0.003785411784 / 60, cfs: 0.028316846592, ft3day: 0.028316846592 / 86400, mgd: 3785.411784 / 86400 };
const lenUnit = () => document.querySelector('input[name="lenunit"]:checked').value;
const Lf = () => LEN[lenUnit()];                                  // meters per display length unit
const Ln = () => lenUnit();
const Qf = () => Q_UNITS[$("in-Q-unit").value];
const Qn = () => $("in-Q-unit").selectedOptions[0].textContent;
const numL = (id) => num(id) * Lf();                              // a length input, in meters
const fmtL = (v, d) => `${fmt(v / Lf(), d)} ${Ln()}`;
const LEN_INPUTS = ["in-dwt", "in-dbase", "in-dexc", "in-margin", "in-gelev", "in-ewt", "in-ebase", "in-eexc", "in-ereq", "in-R", "in-rw", "in-offset", "in-interval", "in-woff", "in-wthick"];
const trim = (v) => String(+v.toPrecision(6));

function setLenLabels() { document.querySelectorAll(".uL").forEach((e) => (e.textContent = Ln())); }
// Switching a unit converts the values already entered, so the design itself doesn't change.
let lastLen = "m";
document.querySelectorAll('input[name="lenunit"]').forEach((r) => r.addEventListener("change", () => {
  const f = LEN[lastLen] / Lf();
  LEN_INPUTS.forEach((id) => { const v = parseFloat($(id).value); if (Number.isFinite(v)) $(id).value = trim(v * f); });
  lastLen = lenUnit();
  setLenLabels(); updateDerived(); updateExcInfo(); showGroundRange(); drawGround(); schedule();
}));
for (const [id, units] of [["in-k", K_UNITS], ["in-Q", Q_UNITS], ["in-kw", K_UNITS]]) {
  const sel = $(`${id}-unit`);
  sel.dataset.prev = sel.value;
  sel.addEventListener("change", () => {
    const v = parseFloat($(id).value);
    if (Number.isFinite(v)) $(id).value = trim(v * units[sel.dataset.prev] / units[sel.value]);
    if (id === "in-k") ["in-kmin", "in-kmax"].forEach((i2) => { const v2 = parseFloat($(i2).value); if (Number.isFinite(v2)) $(i2).value = trim(v2 * units[sel.dataset.prev] / units[sel.value]); });
    if (id === "in-k") syncCurveInputs();
    sel.dataset.prev = sel.value;
    schedule();
    if (curveRows.length && $("dlg-curve").open) drawCurve();
  });
}

// ------------------------------------------------------------------ local frame (meters)
// An equirectangular frame centered on the site: accurate to a small fraction of a percent over
// the few kilometers a dewatering design covers.
const M_LAT = 110574;
const mLng = (lat) => 111320 * Math.cos(lat * Math.PI / 180);
function setOrigin(latlng) { state.origin = [latlng.lat, latlng.lng]; }
function toXY(ll) {
  const [la0, lo0] = state.origin;
  return { x: (ll.lng - lo0) * mLng(la0), y: (ll.lat - la0) * M_LAT };
}
function toLL(p) {
  const [la0, lo0] = state.origin;
  return L.latLng(la0 + p.y / M_LAT, lo0 + p.x / mLng(la0));
}

// ------------------------------------------------------------------ inputs
// Levels come in either as depths below level ground (the depth to the water table, to the
// bottom of the aquifer, and of the excavation, plus any extra depth the water must reach below
// the excavation bottom) or as elevations (the water table, the top of the low-k layer, the
// excavation bottom, and the required water level, with the ground elevation typed or read from
// terrain). Either way they become one site in depths below the ground elevation, and the model
// uses H, the initial saturated thickness, and the target head, both measured up from the top of
// the low-k layer.
const mode = () => document.querySelector('input[name="mode"]:checked').value;
function params() {
  const p = {
    k: num("in-k") * K_UNITS[$("in-k-unit").value],
    R: numL("in-R"), rw: numL("in-rw"), Rmethod: $("in-R-method").value,
    Q: num("in-Q") * Qf(),
    site: null,
  };
  if (flow() === "transient") { p.t = num("in-tdays") * 86400; p.Sy = num("in-sy"); }
  if (mode() === "depth") {
    const site = { dwt: numL("in-dwt"), dbase: numL("in-dbase"), dexc: numL("in-dexc"), margin: numL("in-margin") || 0, gelev: numL("in-gelev") };
    p.site = site;
    p.H = site.dbase - site.dwt;
    p.target = site.dbase - (site.dexc + site.margin);
  } else {
    const g = numL("in-gelev"), ewt = numL("in-ewt"), ebase = numL("in-ebase"), eexc = numL("in-eexc"), ereq = numL("in-ereq");
    p.site = { dbase: g - ebase, dwt: g - ewt, dexc: g - eexc, margin: eexc - ereq, gelev: g, elev: true };
    p.H = ewt - ebase;
    p.target = ereq - ebase;
  }
  if (p.t !== undefined) p.R = reach(p);
  else if (p.Rmethod !== "entered") p.R = radius(p, p.k);
  return p;
}
// The radius of influence from the empirical formulas (Bear 1979, p. 306), in meters with k in
// m/s. A ring of wells around an excavation is treated as one large well of the excavation's
// equivalent radius, r_e = √(A/π), drawn down by s, the drawdown the excavation needs (H minus
// the target head); R is measured from its center: R = r_e + 3000 s √k (Sichardt) or
// r_e + 575 s √(Hk) (Kusakin). R then depends on the site and k, never on how many wells share
// the pumping.
function excArea() {
  const ring = excRing();
  if (!ring || !state.origin) return 0;
  const r = ring.map(toXY);
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j].x + r[i].x) * (r[j].y - r[i].y);
  return Math.abs(a) / 2;
}
const rEquiv = () => Math.sqrt(excArea() / Math.PI);
function radius(p, k) {
  if (p.t !== undefined) return reach({ ...p, k });
  const s = p.H - p.target;
  if (p.Rmethod === "sichardt") return rEquiv() + 3000 * s * Math.sqrt(k);
  if (p.Rmethod === "kusakin") return rEquiv() + 575 * s * Math.sqrt(p.H * k);
  return p.R;
}
// The minimum design pumping rate, with R for the given k.
function optimalWithR(cp, wells, p, k = p.k) {
  const R = radius(p, k);
  return { ...optimalRate(cp, wells, { ...p, k, R }, p.target), R };
}
function showR() {
  const p = params(), auto = p.Rmethod !== "entered";
  if (p.t !== undefined) return;
  $("in-R").readOnly = auto;
  $("R-note").hidden = !auto;
  if (auto && Number.isFinite(p.R)) $("in-R").value = trim(p.R / Lf());
}
$("in-R-method").addEventListener("change", () => { showR(); schedule(); });

// Steady flow uses a radius of influence; transient flow uses the specific yield and the time
// pumping (Theis); the time bar under the map steps through the days.
const flow = () => document.querySelector('input[name="flow"]:checked').value;
function showFlow() {
  const tr = flow() === "transient";
  syncCurveInputs();
  $("R-method-field").hidden = tr; $("R-field").hidden = tr;
  $("R-note").hidden = tr || $("in-R-method").value === "entered";
  ["tdays-field", "t-note"].forEach((id) => ($(id).hidden = !tr));
  $("sy-field").hidden = !(tr || $("in-wall").checked);
  showAnim();
}
document.querySelectorAll('input[name="flow"]').forEach((r) => r.addEventListener("change", () => { stopAnim(); state.viewT = null; showFlow(); showR(); updateDerived(); schedule(); }));
$("in-tdays").addEventListener("input", () => { stopAnim(); state.viewT = null; });

// The time bar along the bottom of the map: the map and the section at any time up to twice the
// design day, or played through at a steady number of days per second. The bar is linear in time:
// away from the wells the water hardly moves for the first days and then follows ln t, so a log bar
// spent half the playback on nothing. The design (Q_min, the results' days to dewater) stays at the
// design day; only the view moves.
const tEnd = () => Math.max(2 * num("in-tdays") * 86400, 10 * 86400);
const toT = (v) => tEnd() * Math.max(v, 1) / 1000;     // the bar starts one step in, not at t = 0
const toV = (t) => Math.round(1000 * t / tEnd());
let animFrame = null;
function showAnim() {
  const on = flow() === "transient" && !!state.last && num("in-tdays") > 0;
  $("anim-bar").hidden = !on;
  document.querySelector(".mapwrap").classList.toggle("anim", on);
  if (!on) stopAnim();
}
function setView(t) { state.viewT = t; run(); }
function stopAnim() {
  if (animFrame) cancelAnimationFrame(animFrame);
  animFrame = null;
  $("anim-play").textContent = "▶"; $("anim-play").setAttribute("aria-label", "Play");
}
$("anim-play").onclick = () => {
  if (animFrame) return stopAnim();
  let v = +$("anim-t").value;
  if (v >= 1000) v = 0;
  $("anim-play").textContent = "❚❚"; $("anim-play").setAttribute("aria-label", "Pause");
  let last = performance.now();
  const step = (now) => {
    v = Math.min(1000, v + (now - last) / 8);          // the whole span in about 8 s
    last = now;
    $("anim-t").value = v;
    setView(toT(v));
    if (v >= 1000) return stopAnim();
    animFrame = requestAnimationFrame(step);
  };
  animFrame = requestAnimationFrame(step);
};
$("anim-t").addEventListener("input", () => { stopAnim(); setView(toT(+$("anim-t").value)); });
$("anim-design").onclick = () => { stopAnim(); state.viewT = null; run(); };
// The time bar's colors: blue while the water is still above the required level, green from the
// day the excavation is dewatered, red wherever a well is dry (sampled at 200 times along the
// bar). Kept while the bar plays; recomputed when the design changes.
const BAR = { wait: "#1F4E79", dew: "#2fa866", dry: "#b3261e" };
let barMemo = { key: null, r: null };
function barStates(keyParts, tDew, dryAt) {
  const key = JSON.stringify(keyParts);
  if (barMemo.key !== key) {
    const te = tEnd(), M = 200, s = [];
    for (let i = 0; i < M; i++) { const t = te * (i + 0.5) / M; s.push(dryAt(t) ? "dry" : t >= tDew ? "dew" : "wait"); }
    barMemo = { key, r: s };
  }
  return barMemo.r;
}
function paintBar(states) {
  const el = $("anim-t");
  if (!states) return void (el.style.background = "");
  const M = states.length, stops = [];
  states.forEach((st, i) => { if (!i || st !== states[i - 1]) stops.push(`${BAR[st]} ${(100 * i / M).toFixed(2)}%`); if (i === M - 1 || st !== states[i + 1]) stops.push(`${BAR[st]} ${(100 * (i + 1) / M).toFixed(2)}%`); });
  el.style.background = `linear-gradient(to right, ${stops.join(", ")})`;
}
function syncAnim(p) {
  paintBar(state.last && state.last.bar);
  const tDesign = num("in-tdays") * 86400, t = p.t, day = t / 86400;
  if (!animFrame) $("anim-t").value = toV(t);
  $("anim-day").textContent = `Day ${fmtNum(+day.toPrecision(day < 10 ? 2 : 3))}${Math.abs(t - tDesign) > 1e-6 * tDesign ? ` · design day ${fmtNum(tDesign / 86400)}` : " (design)"}`;
  $("anim-design").style.visibility = Math.abs(t - tDesign) <= 1e-6 * tDesign ? "hidden" : "";   // keeps its space: the bar's length never changes
}

function updateDerived() {
  showR();
  const p = params(), s = p.site;
  if (s && s.elev) {
    $("derived").textContent = [p.H, p.target, s.dwt, s.dexc].every(Number.isFinite)
      ? `Saturated thickness H = ${fmtL(p.H, 2)}; target head ${fmtL(p.target, 2)} above the low-k layer. Water table ${fmtL(s.dwt, 2)} below ground; excavation ${fmtL(s.dexc, 2)} deep.` : "";
  } else if (s && [s.dwt, s.dbase, s.dexc].every(Number.isFinite)) {
    $("derived").textContent = `Saturated thickness H = ${fmtL(p.H, 2)}. The water must come down to ${fmtL(s.dexc + s.margin, 2)} below ground: a head of ${fmtL(p.target, 2)} above the low-k layer.`
      + (Number.isFinite(s.gelev) ? ` Water table at elevation ${fmt((s.gelev - s.dwt) / Lf(), 2)}; required level ${fmt((s.gelev - s.dexc - s.margin) / Lf(), 2)}.` : "");
  } else $("derived").textContent = "";
  if (p.t !== undefined && p.t > 0 && p.Sy > 0 && p.k > 0 && p.H > 0)
    $("derived").textContent += ` After ${dayN(p.t)} days the drawdown spreads to about 1.5√(kHt/Sᵧ) = ${fmtL(p.R, 0)} from each well.`;
}
// Switching how the levels are entered carries the site over, so the design stays the same.
function carryLevels() {
  const setL = (id, v) => { if (Number.isFinite(v)) $(id).value = trim(v / Lf()); };
  if (mode() === "elev") {
    const dwt = numL("in-dwt"), dbase = numL("in-dbase"), dexc = numL("in-dexc"), mg = numL("in-margin") || 0;
    // without a ground elevation, the datum is the top of the low-k layer
    let g = numL("in-gelev");
    if (!Number.isFinite(g)) { g = dbase; setL("in-gelev", g); }
    setL("in-ewt", g - dwt); setL("in-ebase", g - dbase); setL("in-eexc", g - dexc); setL("in-ereq", g - dexc - mg);
  } else {
    const g = numL("in-gelev"), ewt = numL("in-ewt"), ebase = numL("in-ebase"), eexc = numL("in-eexc"), ereq = numL("in-ereq");
    setL("in-dwt", g - ewt); setL("in-dbase", g - ebase); setL("in-dexc", g - eexc); setL("in-margin", eexc - ereq);
  }
}
function showMode() {
  $("depth-fields").hidden = mode() !== "depth";
  $("elev-fields").hidden = mode() !== "elev";
  const el = mode() === "elev";
  $("gelev-label").textContent = el ? "Ground elevation" : "Ground elevation, optional";
  $("in-gelev").placeholder = el ? "required" : "blank = depths only";
  // contours in the way the levels are entered
  if (el && $("in-field").value === "wdepth") $("in-field").value = "elev";
  if (!el && $("in-field").value === "elev") $("in-field").value = "wdepth";
}
// Switching to elevations without a ground elevation reads it from the terrain first, so the
// depths carry over as real elevations (the datum falls to the top of the low-k layer only when
// there is no excavation yet or no terrain data).
document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener("change", async () => {
  if (mode() === "elev" && !Number.isFinite(numL("in-gelev")) && state.excavation) await setTerrain(true);
  carryLevels(); showMode(); updateDerived(); schedule();
}));
function checkParams(p) {
  if (!(p.k > 0)) return "Enter a hydraulic conductivity greater than zero.";
  const st = p.site;
  if (st && st.elev) {
    if (!Number.isFinite(st.gelev)) return "Enter the ground elevation, or use terrain.";
    if (![st.dwt, st.dbase, st.dexc, st.margin].every(Number.isFinite)) return "Enter all four elevations.";
    if (!(st.dwt >= 0)) return "The water table must be at or below the ground.";
    if (!(st.dbase > st.dwt)) return "The top of the low-k layer must be below the water table.";
    if (!(st.dexc > 0)) return "The excavation bottom must be below the ground.";
    if (!(st.margin >= 0)) return "The required water level must be at or below the excavation bottom.";
    if (!(st.dexc + st.margin < st.dbase)) return "The required water level must be above the top of the low-k layer.";
    if (!(st.dexc + st.margin > st.dwt)) return "The required level is above the water table: no dewatering is needed.";
  } else if (st) {
    if (!(st.dwt >= 0)) return "Enter a depth to the water table of zero or more.";
    if (!(st.dbase > st.dwt)) return "The bottom of the aquifer must be deeper than the water table.";
    if (!(st.dexc > 0)) return "Enter an excavation depth greater than zero.";
    if (!(st.dexc + st.margin < st.dbase)) return "The excavation, with the extra depth required, must stay above the bottom of the aquifer.";
    if (!(st.dexc + st.margin > st.dwt)) return "The excavation stays above the water table: no dewatering is needed.";
  }
  if (!(p.H > 0)) return "Enter a saturated thickness H greater than zero.";
  if (p.t !== undefined) {
    if (!(p.t > 0)) return "Enter the days to dewater, greater than zero.";
    if (!(p.Sy > 0 && p.Sy <= 1)) return "Enter a specific yield between 0 and 1.";
    if (!(p.rw > 0)) return "Enter a well radius greater than zero.";
  } else {
    if (!(p.R > 0)) return "Enter a radius of influence R greater than zero.";
    if (!(p.rw > 0) || p.rw >= p.R) return "The well radius must be greater than zero and less than R.";
  }
  if (!(p.target >= 0) || p.target >= p.H) return "The target head must be at least zero and less than H.";
  if (!(p.Q >= 0)) return "Enter a pumping rate of zero or more.";
  if (wallOn()) {
    const w = wallParams();
    if (!(numL("in-woff") >= 0)) return "Enter a wall setback of zero or more.";
    if (!(w.t > 0)) return "Enter a wall thickness greater than zero.";
    if (!(w.kw > 0)) return "Enter a wall conductivity greater than zero.";
  }
  return null;
}

// ------------------------------------------------------------------ excavation
const EXC_STYLE = { color: "#E8582C", weight: 3, fillColor: "#E8582C", fillOpacity: 0.08 };

function setExcavation(layer, fit = true) {
  if (state.excavation && state.excavation !== layer) map.removeLayer(state.excavation);
  state.excavation = layer;
  layer.setStyle(EXC_STYLE);
  layer.on("pm:edit pm:dragend pm:rotateend", () => { updateExcInfo(); refreshTerrain(); schedule(); });
  layer.on("pm:remove", () => { state.excavation = null; updateExcInfo(); updateGroundRange(); schedule(); });
  setOrigin(layer.getBounds().getCenter());
  refreshTerrain();
  if (fit) map.fitBounds(layer.getBounds().pad(1.2));
  updateExcInfo();
  schedule();
}
function excRing() {
  if (!state.excavation) return null;
  let ll = state.excavation.getLatLngs();
  while (Array.isArray(ll[0])) ll = ll[0];
  return ll;
}
function excFeature() {
  const ring = excRing();
  if (!ring) return null;
  const c = ring.map((p) => [p.lng, p.lat]);
  c.push(c[0]);
  return turf.polygon([c]);
}
function updateExcInfo() {
  const f = excFeature();
  if (!f) { $("exc-info").textContent = "No excavation yet."; return; }
  const a = turf.area(f), per = turf.length(turf.polygonToLine(f), { units: "meters" });
  $("exc-info").textContent = lenUnit() === "ft"
    ? `Area ${fmt(a * 10.7639, 0)} ft² (${fmt(a / 4046.856, 2)} acres), perimeter ${fmt(per / 0.3048, 0)} ft.`
    : `Area ${fmt(a, 0)} m² (${fmt(a / 10000, 2)} ha), perimeter ${fmt(per, 0)} m.`;
}
// The first polygon in a GeoJSON object, as a ring of [lat, lng] (or null).
function geojsonRing(gj) {
  const feats = gj.type === "FeatureCollection" ? gj.features : gj.type === "Feature" ? [gj] : [{ type: "Feature", geometry: gj }];
  const poly = feats.find((f) => f.geometry && /Polygon/.test(f.geometry.type));
  if (!poly) { alertMsg("That file has no polygon in it."); return null; }
  const coords = poly.geometry.type === "MultiPolygon" ? poly.geometry.coordinates[0][0] : poly.geometry.coordinates[0];
  return coords.slice(0, -1).map(([lng, lat]) => [lat, lng]);
}
function loadGeoJSON(gj) {
  const ring = geojsonRing(gj);
  if (!ring) return;
  const layer = L.polygon(ring);
  layer.addTo(map);
  setExcavation(layer);
}

$("btn-draw").onclick = () => {
  setAddMode(false);
  state.wallDrawing = false;
  map.pm.enableDraw("Polygon", { templineStyle: EXC_STYLE, hintlineStyle: { color: "#E8582C", dashArray: "5,5" }, pathOptions: EXC_STYLE });
  tip("Click the corners of the excavation. Click the first corner to finish.");
};
$("btn-delete-exc").onclick = () => {
  if (!state.excavation) return;
  if (state.excavation.pm.enabled()) state.excavation.pm.disable();
  map.removeLayer(state.excavation);
  state.excavation = null;
  $("btn-edit").textContent = "Edit"; $("btn-rotate").textContent = "Rotate"; tip(null);
  updateExcInfo(); updateGroundRange();
  schedule();
};
$("btn-rect").onclick = () => {
  setAddMode(false);
  state.wallDrawing = false;
  map.pm.enableDraw("Rectangle", { pathOptions: EXC_STYLE });
  tip("Click one corner of the excavation, then the opposite corner. Use Rotate to turn it to match the site.");
};
$("btn-rotate").onclick = () => {
  if (!state.excavation) return;
  const on = state.excavation.pm.rotateEnabled && state.excavation.pm.rotateEnabled();
  if (on) { state.excavation.pm.disableRotate(); $("btn-rotate").textContent = "Rotate"; tip(null); }
  else { state.excavation.pm.enableRotate(); $("btn-rotate").textContent = "Done rotating"; tip("Drag a corner to rotate the excavation."); }
};
map.on("pm:create", (e) => {
  tip(null);
  if ((e.shape === "Polygon" || e.shape === "Rectangle") && state.wallDrawing) { state.wallDrawing = false; setWall(e.layer); }
  else if (e.shape === "Polygon" || e.shape === "Rectangle") setExcavation(e.layer, false);
  else if (e.shape === "Line" && state.secDrawing) {
    state.secDrawing = false;
    const ll = e.layer.getLatLngs();
    map.removeLayer(e.layer);
    setSection(ll[0], ll[ll.length - 1]);
  }
});
$("btn-edit").onclick = () => {
  if (!state.excavation) return;
  const on = state.excavation.pm.enabled();
  if (on) { state.excavation.pm.disable(); $("btn-edit").textContent = "Edit"; tip(null); }
  else { state.excavation.pm.enable({ allowSelfIntersection: false }); $("btn-edit").textContent = "Done editing"; tip("Drag the corners to reshape the excavation."); }
};
$("file-geojson").onchange = (e) => readFile(e.target.files[0], (t) => loadGeoJSON(JSON.parse(t)));
$("btn-example").onclick = async () => {
  const gj = await (await fetch("examples/byu_brewster.geojson")).json();
  loadGeoJSON(gj);
};
$("btn-export-exc").onclick = () => {
  const f = excFeature();
  if (f) download("excavation.geojson", JSON.stringify(turf.featureCollection([f])), "application/geo+json");
};

// ------------------------------------------------------------------ wells
const wellIcon = (dry) => L.divIcon({ className: "", html: `<div class="well-icon${dry ? " dry" : ""}"></div>`, iconSize: [14, 14], iconAnchor: [7, 7] });

function addWell(latlng, run = true) {
  if (!state.origin) setOrigin(latlng);
  const marker = L.marker(latlng, { icon: wellIcon(false), draggable: true, autoPan: true, pmIgnore: true });
  const w = { marker };
  marker.on("drag", () => schedule(60));
  marker.on("dragend", () => schedule());
  marker.on("contextmenu", (e) => { L.DomEvent.preventDefault(e); removeWell(w); });
  marker.addTo(marks);
  state.wells.push(w);
  if (run) { updateWellsInfo(); schedule(); }
}
function removeWell(w) {
  marks.removeLayer(w.marker);
  state.wells = state.wells.filter((x) => x !== w);
  updateWellsInfo();
  schedule();
}
function clearWells() {
  state.wells.forEach((w) => marks.removeLayer(w.marker));
  state.wells = [];
  updateWellsInfo();
  schedule();
}
function updateWellsInfo() {
  const n = state.wells.length;
  $("wells-info").textContent = n ? `${n} well${n > 1 ? "s" : ""}.` : "No wells yet.";
}
function setAddMode(on) {
  state.addMode = on;
  $("btn-add-wells").classList.toggle("on", on);
  $("btn-add-wells").textContent = on ? "Done adding wells" : "Click to add wells";
  map.getContainer().style.cursor = on ? "crosshair" : "";
  tip(on ? "Click the map to place wells." : null);
}
$("btn-add-wells").onclick = () => { map.pm.disableDraw(); setAddMode(!state.addMode); };
$("btn-clear-wells").onclick = clearWells;
map.on("click", (e) => { if (state.addMode) addWell(e.latlng); });

// A ring of n wells, evenly spaced along the outline offset outward from the excavation.
function ringWells(n, offset) {
  const f = excFeature();
  if (!f) return null;
  const buf = offset > 0 ? turf.buffer(f, offset, { units: "meters", steps: 16 }) : f;
  const geom = buf.geometry.type === "MultiPolygon" ? buf.geometry.coordinates[0] : buf.geometry.coordinates;
  const line = turf.lineString(geom[0]);
  const len = turf.length(line, { units: "meters" });
  const out = [];
  for (let i = 0; i < n; i++) {
    const [lng, lat] = turf.along(line, len * i / n, { units: "meters" }).geometry.coordinates;
    out.push(L.latLng(lat, lng));
  }
  return out;
}
$("btn-generate").onclick = () => {
  if (!state.excavation) { alertMsg("Draw or load the excavation first."); return; }
  const n = Math.round(num("in-nwells")), off = numL("in-offset");
  if (!(n >= 1) || !(off >= 0)) { alertMsg("Enter a number of wells and an offset of zero or more."); return; }
  clearWells();
  ringWells(n, off).forEach((ll) => addWell(ll, false));
  updateWellsInfo();
  schedule();
};

// ------------------------------------------------------------------ cutoff wall
// The wall follows the excavation's outline offset outward; it is keyed into the low-k layer
// (model.js has the leakage, the steady level inside, and the drain-down time).
const wallOn = () => $("in-wall").checked && !!state.excavation;
function wallParams() {
  return { t: numL("in-wthick"), kw: num("in-kw") * K_UNITS[$("in-kw-unit").value] };
}
function polyArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j].x + r[i].x) * (r[j].y - r[i].y);
  return Math.abs(a) / 2;
}
const wallSrc = () => document.querySelector('input[name="wallsrc"]:checked').value;
const WALL_STYLE = { color: "#3d4550", weight: 4, opacity: 1, fillOpacity: 0 };
// The wall's outline: a rectangle around the excavation and every well, set out by the setback
// on every side, square-cornered and lined up with the excavation's longest side; or the wall
// drawn or loaded (null if there is none yet).
function offsetRingLL(wellLLs = state.wells.map((w) => w.marker.getLatLng())) {
  const ex = excRing().map(toXY), off = numL("in-woff");
  let ang = 0, best = -1;
  ex.forEach((q, i) => { const r = ex[(i + 1) % ex.length], L2 = (r.x - q.x) ** 2 + (r.y - q.y) ** 2; if (L2 > best) { best = L2; ang = Math.atan2(r.y - q.y, r.x - q.x); } });
  const c = Math.cos(ang), sn = Math.sin(ang);
  const pts = [...ex, ...wellLLs.map(toXY)].map((q) => ({ u: q.x * c + q.y * sn, v: -q.x * sn + q.y * c }));
  const u0 = Math.min(...pts.map((q) => q.u)) - off, u1 = Math.max(...pts.map((q) => q.u)) + off;
  const v0 = Math.min(...pts.map((q) => q.v)) - off, v1 = Math.max(...pts.map((q) => q.v)) + off;
  return [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(([u, v]) => toLL({ x: u * c - v * sn, y: u * sn + v * c }));
}
function wallRingLL(wellLLs) {
  if (wallSrc() === "offset") return offsetRingLL(wellLLs);
  if (!state.wall) return null;
  let ll = state.wall.getLatLngs();
  while (Array.isArray(ll[0])) ll = ll[0];
  return ll;
}
function setWall(layer) {
  if (state.wall && state.wall !== layer) map.removeLayer(state.wall);
  state.wall = layer;
  layer.setStyle(WALL_STYLE);
  layer.bindTooltip("Cutoff wall", { sticky: true });
  layer.on("pm:edit pm:dragend", () => schedule());
  layer.on("pm:remove", () => { state.wall = null; schedule(); });
  schedule();
}
function showWallSrc() {
  const drawn = wallSrc() === "drawn";
  $("wall-drawn").hidden = !drawn;
  $("woff-field").hidden = drawn;
  // the drawn wall shows only while it is the one in use
  if (state.wall) {
    const use = drawn && $("in-wall").checked;
    if (use && !map.hasLayer(state.wall)) state.wall.addTo(map);
    if (!use && map.hasLayer(state.wall)) { if (state.wall.pm.enabled()) state.wall.pm.disable(); map.removeLayer(state.wall); $("btn-wall-edit").textContent = "Edit"; }
  }
}
document.querySelectorAll('input[name="wallsrc"]').forEach((r) => r.addEventListener("change", () => { showWallSrc(); schedule(); }));
$("btn-wall-draw").onclick = () => {
  if (!state.excavation) return alertMsg("Draw or load the excavation first.");
  setAddMode(false);
  state.wallDrawing = true;
  map.pm.enableDraw("Polygon", { templineStyle: WALL_STYLE, hintlineStyle: { color: "#3d4550", dashArray: "5,5" }, pathOptions: WALL_STYLE });
  tip("Click the corners of the wall, around the excavation. Click the first corner to finish.");
};
$("btn-wall-start").onclick = () => {
  if (!state.excavation) return alertMsg("Draw or load the excavation first.");
  setAddMode(false);
  state.wallDrawing = true;
  map.pm.enableDraw("Rectangle", { pathOptions: WALL_STYLE });
  tip("Click one corner of the wall, then the opposite corner, around the excavation and the wells.");
};
$("btn-wall-edit").onclick = () => {
  if (!state.wall) return;
  const on = state.wall.pm.enabled();
  if (on) { state.wall.pm.disable(); $("btn-wall-edit").textContent = "Edit"; tip(null); }
  else { state.wall.pm.enable({ allowSelfIntersection: false }); $("btn-wall-edit").textContent = "Done editing"; tip("Drag the corners to reshape the wall."); }
};
$("btn-wall-delete").onclick = () => {
  if (!state.wall) return;
  if (state.wall.pm.enabled()) state.wall.pm.disable();
  map.removeLayer(state.wall); state.wall = null;
  $("btn-wall-edit").textContent = "Edit"; tip(null);
  schedule();
};
$("file-wall").onchange = (e) => readFile(e.target.files[0], (t) => { const r = geojsonRing(JSON.parse(t)); if (r) setWall(L.polygon(r).addTo(map)); });
$("btn-wall-export").onclick = () => {
  const r = wallRingLL();
  if (!r) return;
  const c = r.map((q) => [q.lng, q.lat]); c.push(c[0]);
  download("cutoff_wall.geojson", JSON.stringify(turf.featureCollection([turf.polygon([c])])), "application/geo+json");
};
function wallGeom(wellLLs) {
  const ringLL = wallRingLL(wellLLs);
  if (!ringLL || ringLL.length < 3) return null;
  const ring = ringLL.map(toXY);
  let P = 0;
  ring.forEach((q, i) => { const r2 = ring[(i + 1) % ring.length]; P += Math.hypot(r2.x - q.x, r2.y - q.y); });
  return { ringLL, ring, P, Aw: polyArea(ring) };
}
// The grid model of the wells inside the wall (model.js gridModel), built once per layout and
// kept: transient flow runs to tMax (the end of the bar plus the four weeks the hold looks
// ahead, unless given), steady flow holds the head at R. Its influence is the one solution
// everywhere while the wall is on.
let gridMemo = new Map();
function gridFor(p, wells, wallRing, tMax) {
  const wp = wallParams(), tr = p.t !== undefined;
  const tm = tr ? (tMax || tEnd() + 35 * 86400) : 0;
  const key = JSON.stringify([wallRing, wells, p.k, p.H, p.Sy, p.rw, wp.kw, wp.t, tr ? tm : p.R]);
  if (!gridMemo.has(key)) {
    if (gridMemo.size > 6) gridMemo.delete(gridMemo.keys().next().value);
    gridMemo.set(key, { key, ...gridModel(wells, { H: p.H, k: p.k, rw: p.rw, Sy: tr ? p.Sy : 0, R: p.R }, { wall: wallRing, kw: wp.kw, t: wp.t, tMax: tm }) });
  }
  return gridMemo.get(key);
}
// The influence for a set of wells: the grid model's with the wall on (the wall drawn, or around
// the excavation and these wells), else null (Theis)
function infFor(p, wellLLs, tMax) {
  if (!wallOn()) return null;
  const g = wallGeom(wellLLs);
  return g ? gridFor(p, wellLLs.map(toXY), g.ring, tMax).at : null;
}
$("in-wall").addEventListener("change", () => { showWallSrc(); showFlow(); schedule(); });

// ------------------------------------------------------------------ analysis
let timer = null;
function schedule(ms = 150) {
  clearTimeout(timer);
  timer = setTimeout(run, ms);
  persist();
}

function analysisBox(pts) {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  let x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const span = Math.max(x1 - x0, y1 - y0, 20), pad = Math.max(0.9 * span, 60);
  return [x0 - pad, x1 + pad, y0 - pad, y1 + pad];
}

// Check points: a grid over the excavation and points along its edge.
function checkPoints(ring) {
  const box = analysisBox(ring);
  const span = Math.max(box[1] - box[0], box[3] - box[2]);
  const xs = ring.map((p) => p.x), ys = ring.map((p) => p.y);
  const nx = 60, b = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const ny = Math.max(10, Math.round(nx * (b[3] - b[2]) / Math.max(b[1] - b[0], 1e-6)));
  const pts = grid(b, nx, Math.min(ny, 200)).filter((p) => inside(p, ring));
  return pts.concat(densify(ring, span / 400));
}

function run() {
  clearResults();
  wallLayer.clearLayers();
  const p = params(), err = checkParams(p);
  if (!err && p.t !== undefined && state.viewT) { p.t = state.viewT; p.R = reach(p); }
  const ringLL = excRing();
  if (err) return setStatus("bad", err);
  if (!ringLL && !state.wells.length) return setStatus("idle", "Draw an excavation and add wells.");
  if (!state.origin) setOrigin((ringLL ? state.excavation.getBounds() : L.latLngBounds(state.wells.map((w) => w.marker.getLatLng()))).getCenter());
  const ring = ringLL ? ringLL.map(toXY) : null;
  const wells = state.wells.map((w) => toXY(w.marker.getLatLng()));
  if (!wells.length) return setStatus("idle", "Add wells: click on the map, or generate a ring.");
  // with a cutoff wall, the wells' influence comes from the grid model (Theis without one)
  let wallG = null, gm = null;
  if (ring && wallOn()) {
    wallG = wallGeom();
    if (!wallG) return setStatus("idle", "Draw or load the cutoff wall, or place it around the site.");
    L.polygon(wallG.ringLL, { color: "#ffffff", weight: 8, opacity: 0.9, fill: false, interactive: false }).addTo(wallLayer);
    if (wallSrc() === "offset") L.polygon(wallG.ringLL, { ...WALL_STYLE, fill: false }).bindTooltip("Cutoff wall", { sticky: true }).addTo(wallLayer);
    else if (state.wall) state.wall.bringToFront();
    if (!ring.every((q) => inside(q, wallG.ring)) || wallG.ring.some((q) => inside(q, ring))) return setStatus("bad", "The cutoff wall must enclose the excavation.");
    gm = gridFor(p, wells, wallG.ring);
  }
  const inf = gm ? gm.at : null;
  const n = wells.length, qEach = p.Q / n;
  const W = wells.map((w) => ({ ...w, q: qEach }));
  const cp = ring ? checkPoints(ring) : null;
  // transient, with an excavation: one pumping schedule (model.js pumpSchedule). Q until the
  // excavation is dewatered, cut back weekly where the wells would otherwise go dry; then stepped
  // down weekly to hold the water at the required level.
  const tr = p.t !== undefined, td = tDesign();
  const plan = tr && ring ? scheduleFor(cp, wells, p, gm) : null, sched = plan && plan.sched, tDew = plan ? plan.tDew : NaN;
  const wpts = wells.map((w) => ({ x: w.x + p.rw, y: w.y }));
  // the one solution: the water level at any points, at time t (the day shown unless given).
  // The map, the excavation check, the wells, the color scale, and the section all read it.
  const headAt = (pts, t = p.t, fast = false) => {
    if (sched) return schedHeads(pts, wells, { ...p, t }, sched, fast, inf).h;
    if (inf) { const A = inf(pts, t); return A.map((a) => Math.sqrt(Math.max(0, p.H * p.H - qEach * a))); }
    return heads(pts, W, { ...p, t }).h;
  };
  const qNow = sched ? rateAt(sched, p.t) : p.Q;

  // the results grid
  const box = analysisBox([...(ring || []), ...wells]);
  const nx = 220, ny = Math.round(nx * (box[3] - box[2]) / (box[1] - box[0]));
  const G = grid(box, nx, ny);
  const h = headAt(G, p.t, true);

  // the excavation: the highest head inside it
  let hmax = null, at = null;
  if (ring) {
    const hc = headAt(cp);
    hmax = -Infinity;
    hc.forEach((v, i) => { if (v > hmax) { hmax = v; at = cp[i]; } });
  }
  // the wells: the head at each well's radius
  const hw = headAt(wpts);
  const dryWells = [];
  hw.forEach((v, i) => { state.wells[i].marker.setIcon(wellIcon(v <= 0)); if (v <= 0) dryWells.push(i); });

  const hEnd = () => headAt(G, td, true);
  const gk = gm ? gm.key : null;
  const bar = tr ? barStates(["w", p.Q, p.k, p.H, p.Sy, p.rw, wells, tDew, tEnd(), gk], tDew, (t) => headAt(wpts, t).some((v) => v <= 0)) : null;
  // the flow through the wall on the day shown (superposed as the heads are)
  const leakNow = gm ? (sched ? sched.reduce((v, s, i) => v + (s.t < p.t ? (s.Q - (i ? sched[i - 1].Q : 0)) / n * gm.leak(p.t - s.t) : 0), 0) : qEach * gm.leak(0)) : null;
  state.last = { p, box, nx, ny, h, ring, wells, hmax, at, hw, qEach, sched, tDew, qNow, capped: plan && plan.capped, headAt, bar,
    wall: wallG ? { ...wallG, w: wallParams() } : null,
    hRange: tr ? spanRange(["w", p.Q, p.k, p.H, p.Sy, p.rw, wells, box, td, tEnd(), gk], hEnd) : null };
  drawResults();
  drawSection();
  showAnim();
  if (tr) syncAnim(p);

  // status and numbers
  const rows = [["Wells", n]];
  if (wallG) {
    const outside = wells.filter((q) => !inside(q, wallG.ring)).length;
    rows.unshift(["Cutoff wall length", fmtL(wallG.P, 0)], ["Area inside the wall", `${fmt(wallG.Aw / Lf() ** 2, 0)} ${Ln()}²`]);
    if (outside) rows.push(["Wells outside the wall", outside]);
  }
  if (sched) {
    rows.push(["Starting rate, Q", fmtQ(p.Q)]);
    if (state.viewT) rows.push([`Rate on day ${dayN(p.t)}`, fmtQ(qNow)]);
  } else rows.push(["Rate per well", fmtQ(qEach)], ["Total rate, Q", fmtQ(p.Q)]);
  const st = p.site;
  const E = (z) => fmt((st.gelev - st.dbase + z) / Lf(), 2);        // a height above the low-k layer as an elevation
  if (ring && st && st.elev) {
    rows.push(["Highest water in the excavation, elevation", E(hmax)]);
    rows.push(["Excavation bottom, elevation", E(st.dbase - st.dexc)]);
    rows.push(["Water below the bottom", `${fmtL(st.dbase - hmax - st.dexc, 2)} (need ${fmt(st.margin / Lf(), 2)})`]);
  } else if (ring && st) {
    rows.push(["Highest water in the excavation", `${fmtL(st.dbase - hmax, 2)} below ground`]);
    if (Number.isFinite(st.gelev)) rows.push(["…as an elevation", fmt((st.gelev - st.dbase + hmax) / Lf(), 2)]);
    rows.push(["Excavation bottom", `${fmtL(st.dexc, 2)} below ground`]);
    rows.push(["Water below the bottom", `${fmtL(st.dbase - hmax - st.dexc, 2)} (need ${fmt(st.margin / Lf(), 2)})`]);
  } else if (ring) {
    rows.push(["Highest head in the excavation", fmtL(hmax, 2)]);
    rows.push(["Target head", fmtL(p.target, 2)]);
    rows.push(["Margin (target − highest)", fmtL(p.target - hmax, 2)]);
  }
  if (sched) {
    rows.push(["Deadline, days to dewater", dayN(td)]);
    if (state.viewT) rows.push(["Day shown", dayN(p.t)]);
    rows.push(["Dewatered on day", tDew < Infinity ? dayN(tDew) : `not by day ${dayN(tEnd())}`]);
    if (plan.capped) rows.push(["Cut back to keep the wells from going dry", "yes"]);
    if (tDew < Infinity) {
      const hold = sched.filter((x) => x.t >= tDew - 1);
      rows.push(["Rate to hold it, first week", fmtQ(hold[0].Q)]);
      rows.push([`Rate to hold it, day ${dayN(tEnd())}`, fmtQ(hold[hold.length - 1].Q)]);
    }
    rows.push([`Water pumped by day ${dayN(tEnd())}`, fmtVol(pumpedBy(sched, tEnd()))]);
  } else if (tr) {
    rows.push(["Days to dewater, t", dayN(p.t)]);
  } else if (p.Rmethod !== "entered") {
    rows.push(["Equivalent radius, √(A/π)", fmtL(rEquiv(), 1)]);
    rows.push(["R from the formula", fmtL(p.R, 0)]);
  }
  if (tr) rows.push(["Spread of the drawdown, 1.5√(kHt/S<sub>y</sub>)", fmtL(p.R, 0)]);
  if (gm) rows.push([tr ? `Leakage through the wall, day ${dayN(p.t)}` : "Leakage through the wall", fmtQ(leakNow)]);
  rows.push(st && st.elev ? ["Lowest water, at a well, elevation", E(Math.min(...hw))] : st ? ["Deepest water, at a well", `${fmtL(st.dbase - Math.min(...hw), 2)} below ground`] : ["Lowest head at a well", fmtL(Math.min(...hw), 2)]);
  $("results").innerHTML = rows.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join("");
  $("btn-sched").hidden = !sched;

  if (sched) return setStatus(...scheduleStatus(p, plan, hmax, td));
  if (dryWells.length) {
    setStatus("bad", `${dryWells.length} well${dryWells.length > 1 ? "s" : ""} pumped dry (shown red): the rate is more than the aquifer can deliver there. ${wallG ? "Add wells or lower Q." : "Add wells, lower Q, or enclose the site with a cutoff wall (step 4)."}`);
  } else if (!ring) {
    setStatus("idle", "Draw or load the excavation to check the design.");
  } else if (state.optQ && Math.abs(p.Q - state.optQ) <= 1e-5 * state.optQ && Math.abs(hmax - p.target) < 1e-3) {
    // still the minimum design pumping rate found (in whatever units it is now shown)
    setStatus("ok", `Minimum design pumping rate: ${fmtQ(state.optQ)}. The highest water in the excavation is exactly at the required level.${state.optNote || ""}`);
  } else if (hmax <= p.target) {
    setStatus("ok", st ? `Dewatered: the water is at least ${fmtL(st.dbase - hmax - st.dexc, 2)} below the excavation bottom everywhere inside it.`
      : "Dewatered: the water is at or below the target head everywhere in the excavation.");
  } else {
    setStatus("warn", `Not dewatered: the water is ${fmtL(hmax - p.target, 2)} above the required level at the marked point.`);
  }
}

// The status line for a transient design: on the design day, whether the schedule meets the
// deadline; on other days, what the pumps are doing then.
function scheduleStatus(p, plan, hmax, td) {
  const { sched, tDew, capped } = plan, q = rateAt(sched, p.t);
  const cut = capped ? ", cut back weekly to keep the wells from going dry" : "";
  const fix = wallOn() ? "Add wells, move them, or allow more days." : "Add wells, move them farther out, allow more days, or enclose the site with a cutoff wall (step 4).";
  if (state.viewT && Math.abs(state.viewT - td) > 1e-6 * td) {
    if (p.t < tDew) return ["warn", `Day ${dayN(p.t)}: drawing down at ${fmtQ(q)}; the water is ${fmtL(hmax - p.target, 2)} above the required level. ${tDew < Infinity ? `Dewatered on day ${dayN(tDew)}.` : `Not dewatered by day ${dayN(tEnd())}.`}`];
    return ["ok", `Day ${dayN(p.t)}: held at the required level, pumping ${fmtQ(q)}. Dewatered on day ${dayN(tDew)}; since then the rate has stepped down weekly.`];
  }
  const isMin = state.optQ && Math.abs(p.Q - state.optQ) <= 1e-5 * state.optQ;
  if (state.fastQ && Math.abs(p.Q - state.fastQ) <= 1e-5 * state.fastQ && tDew > td) {
    return ["bad", `The wells can't dewater by day ${dayN(td)}, even pumping as hard as they can without going dry: the fastest is day ${tDew < Infinity ? dayN(tDew) : `after ${dayN(tEnd())}`}, shown here. ${fix}`];
  }
  if (tDew <= td * (1 + 1e-4)) {
    return ["ok", `${isMin ? `Minimum design pumping rate: start at ${fmtQ(p.Q)}${cut}. ` : ""}Dewatered on day ${dayN(tDew)}${isMin || !capped ? "" : cut}, `
      + `within the ${dayN(td)} days; then the rate steps down to hold it. See the Pumping schedule.`];
  }
  if (tDew < Infinity) return ["warn", `Not dewatered by day ${dayN(td)}: at this rate${cut}, the excavation is dry on day ${dayN(tDew)}. Click Find Q\u2098\u1d62\u2099 for the rate that meets the deadline.`];
  return ["warn", `Not dewatered by day ${dayN(tEnd())} at this rate${cut}. Click Find Q\u2098\u1d62\u2099 for the rate that meets the deadline.`];
}

// In transient flow the colors keep one scale through time: from the static level down to the
// water on the design day (kept while the bar plays). After the design day the water keeps
// falling: deeper water takes the end color, and the contours go on at the same interval.
const tDesign = () => num("in-tdays") * 86400;
let rangeMemo = { key: null, r: null };
function spanRange(keyParts, hEnd, hIn = Infinity) {
  const key = JSON.stringify(keyParts);
  // the 2nd percentile: a few points beside wells pumped dry don't wash out the scale
  if (rangeMemo.key !== key) { const h = Float64Array.from(hEnd()).sort(); rangeMemo = { key, r: [Math.min(h[Math.floor(0.02 * (h.length - 1))], hIn), keyParts[3]] }; }
  return rangeMemo.r;
}


// The pumping schedule for the design (model.js pumpSchedule), kept while the bar plays. The rate
// at time t, the volume pumped by t, and the schedule chart.
let schedMemo = { key: null, r: null };
function scheduleFor(cp, wells, p, gm = null) {
  const key = JSON.stringify([p.Q, p.k, p.H, p.Sy, p.target, p.rw, wells, cp.length, cp[0], tEnd(), gm && gm.key]);
  if (schedMemo.key !== key) schedMemo = { key, r: pumpSchedule(cp, wells, p, p.target, p.Q, tEnd(), undefined, undefined, undefined, gm && gm.at) };
  return schedMemo.r;
}
const rateAt = (sched, t) => { let q = sched[0].Q; for (const s of sched) if (s.t < t) q = s.Q; return q; };
const pumpedBy = (sched, t) => sched.reduce((v, s, i) => v + s.Q * Math.max(0, Math.min(t, i + 1 < sched.length ? sched[i + 1].t : t) - s.t), 0);
const fmtVol = (v) => `${fmt(v / Lf() ** 3, 0)} ${Ln()}³`;

function showSchedule() {
  const L0 = state.last;
  if (!L0 || !L0.sched) return;
  drawSchedule();
  $("dlg-sched").showModal();
}
function drawSchedule() {
  const { sched, tDew, p } = state.last, te = tEnd(), uq = Qf(), unit = Qn(), D = 86400;
  const el = $("sched-chart");
  el.innerHTML = "";
  const W = Math.min(720, window.innerWidth * 0.9), H = 360, m = { l: 70, r: 20, t: 0, b: 46 };
  const pts = [];          // the staircase: each rate from its start to the next
  sched.forEach((s, i) => { const t1 = i + 1 < sched.length ? sched[i + 1].t : te; pts.push([s.t / D, s.Q / uq], [t1 / D, s.Q / uq]); });
  const x = d3.scaleLinear().domain([0, te / D]).range([m.l, W - m.r]);
  // the marked days, each labeled above the plot over its own line, in the line's color; a label
  // that would run into another goes up a row
  const td = tDesign(), marks = [];
  if (tDew < Infinity) marks.push({ t: tDew, text: `Dewatered, day ${dayN(tDew)}`, color: "#b5441f", line: "#E8582C", dash: "6,4" });
  if (Math.abs(td - tDew) > 0.02 * D) marks.push({ t: td, text: `Deadline, day ${dayN(td)}`, color: "#5b6875", line: "#5b6875", dash: "2,3" });
  if (state.viewT && Math.abs(state.viewT - tDew) > 0.01 * D && Math.abs(state.viewT - td) > 0.01 * D) marks.push({ t: state.viewT, text: `Day shown, ${dayN(state.viewT)}`, color: "#1d2733", line: "#1d2733", dash: null });
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.font = `12px ${getComputedStyle(document.body).fontFamily}`;
  const rows = [];
  // each label beside the top of its line: on the left, else on the right, in the lowest row it fits
  const taken = [];        // per row, the [x0, x1] spans already used
  marks.sort((a, b) => a.t - b.t).forEach((mk) => {
    const w = ctx.measureText(mk.text).width, cx = x(mk.t / D);
    const opts = [cx - 5 - w, cx + 5].filter((x0) => x0 >= 4 && x0 + w <= W - 4);
    if (!opts.length) opts.push(Math.max(4, Math.min(W - 4 - w, cx - w / 2)));
    const free = (r, x0) => (taken[r] || []).every(([a, b]) => x0 + w + 8 < a || x0 > b + 8);
    for (let r = 0; ; r++) {
      const x0 = opts.find((v) => free(r, v));
      if (x0 === undefined) continue;
      (taken[r] = taken[r] || []).push([x0, x0 + w]); mk.x0 = x0; mk.row = r; rows[r] = true;
      break;
    }
  });
  m.t = 10 + 18 * rows.length + 6;
  const y = d3.scaleLinear().domain([0, d3.max(pts, (q) => q[1]) * 1.08]).nice().range([H - m.b, m.t]);
  const svg = d3.select(el).append("svg").attr("class", "chart").attr("width", W).attr("height", H);
  svg.append("g").attr("stroke", "#e5eaef").selectAll("line").data(y.ticks(6)).join("line").attr("x1", m.l).attr("x2", W - m.r).attr("y1", (d) => y(d)).attr("y2", (d) => y(d));
  svg.append("g").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(10));
  svg.append("g").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(6));
  // the lines first, then the labels on a white halo, so a line passing a lower label breaks for it
  marks.forEach((mk) => { mk.ly = 10 + 18 * (rows.length - 1 - mk.row) + 12; const xv = x(mk.t / D);
    svg.append("line").attr("x1", xv).attr("x2", xv).attr("y1", mk.ly - 12).attr("y2", H - m.b).attr("stroke", mk.line).attr("stroke-width", mk.dash ? 1.5 : 1).attr("stroke-dasharray", mk.dash); });
  marks.forEach((mk) => svg.append("text").attr("x", mk.x0).attr("y", mk.ly).attr("fill", mk.color)
    .attr("paint-order", "stroke").attr("stroke", "#fff").attr("stroke-width", 5).text(mk.text));
  svg.append("path").datum(pts).attr("fill", "none").attr("stroke", "#1F4E79").attr("stroke-width", 2.5).attr("d", d3.line().x((q) => x(q[0])).y((q) => y(q[1])));
  svg.append("text").attr("class", "axis-title").attr("x", (m.l + W - m.r) / 2).attr("y", H - 8).attr("text-anchor", "middle").text("Days since pumping began");
  svg.append("text").attr("class", "axis-title").attr("transform", `translate(16,${(m.t + H - m.b) / 2}) rotate(-90)`).attr("text-anchor", "middle").text(`Total pumping rate (${unit})`);
  const capped = state.last.capped;
  $("sched-note").innerHTML = `Start at ${fmtQ(p.Q)}${capped ? ", cut back each week where the wells would otherwise go dry" : ""}. `
    + (tDew < Infinity ? `The excavation is dewatered on day ${dayN(tDew)}. Then, once a week, the rate steps down to the lowest that holds the water at the required level for the next four weeks${state.last.wall ? "; with the wall, that is soon little more than the leakage through it" : ""}. `
      : `The excavation is not dewatered by day ${dayN(te)}. `)
    + `Water pumped by day ${dayN(te)}: ${fmtVol(pumpedBy(sched, te))}.`;
}
$("btn-sched").onclick = showSchedule;
$("btn-sched-png").onclick = () => { const sv = $("sched-chart").querySelector("svg"); if (sv) svgToPng(sv, "pumping_schedule.png", "Pumping schedule"); };
$("btn-sched-csv").onclick = () => {
  const { sched } = state.last, u = Qn().replace(/[^A-Za-z0-9]+/g, "_");
  download("pumping_schedule.csv", `start_day,end_day,Q_${u}\n` + sched.map((s, i) => `${trim(s.t / 86400)},${trim((i + 1 < sched.length ? sched[i + 1].t : tEnd()) / 86400)},${trim(s.Q / Qf())}`).join("\n"), "text/csv");
};


// ------------------------------------------------------------------ drawing
function clearResults() {
  $("btn-sched").hidden = true;
  lines.clearLayers();
  shade.clearLayers();
  marks.eachLayer((l) => { if (l.options && l.options.highPoint) marks.removeLayer(l); });
  fill.setUrl("data:image/gif;base64,R0lGODlhAQABAAAAACw=");
  $("legend").hidden = true;
}

// The contoured quantity, its title, its value on the required level (the target contour), and
// whether larger values are drier (colored darker).
function fieldValues(last) {
  const { h, p } = last, st = p.site;
  let kind = $("in-field").value;
  if (!st && (kind === "wdepth" || kind === "elev")) kind = "h";
  if (kind === "elev" && !Number.isFinite(st.gelev)) kind = "wdepth";
  const f = {
    wdepth: [(x) => st.dbase - x, "Depth to water", st && st.dexc + st.margin, true],
    elev: [(x) => st.gelev - st.dbase + x, "Water elevation", st && st.gelev - st.dexc - st.margin, false],
    s: [(x) => p.H - x, "Drawdown", p.H - p.target, true],
    depth: [(x) => p.target - x, "Water below the required level", 0, true],
    h: [(x) => x, "Head above the low-k layer, h", p.target, false],
  }[kind];
  const L = Lf(), v = Float64Array.from(h, (x) => f[0](x) / L);       // in display lengths
  return { v, title: `${f[1]} (${Ln()})`, kind, tgt: f[2] / L, drier: f[3] };
}

function niceLevels(lo, hi) {
  const iv = parseFloat($("in-interval").value);
  if (iv > 0) {
    const out = [];
    for (let t = Math.ceil(lo / iv) * iv; t <= hi + 1e-9 && out.length < 400; t += iv) out.push(+t.toFixed(10));
    return out;
  }
  return d3.ticks(lo, hi, 12);
}

function drawResults() {
  const last = state.last;
  if (!last) return;
  clearResults();
  const { box, nx, ny, p } = last;
  const { v, title, tgt, drier } = fieldValues(last);
  let lo = d3.min(v), hi = d3.max(v);
  let lv = niceLevels(lo, hi);
  if (last.hRange) {
    const e = fieldValues({ ...last, h: Float64Array.from(last.hRange) }).v, vlo = lo, vhi = hi;
    lo = Math.min(e[0], e[1]); hi = Math.max(e[0], e[1]);
    // the design day's interval, over whatever range the water spans now
    const base = niceLevels(lo, hi), iv = base.length > 1 ? base[1] - base[0] : 0;
    lv = iv > 0 ? d3.range(Math.ceil(vlo / iv) * iv, vhi + iv * 1e-6, iv).map((t) => +t.toFixed(10)) : base;
  }
  if (!(hi > lo)) return;
  // the required level always gets its own contour
  const levels = [...new Set([...lv, ...(tgt > Math.min(lo, d3.min(v)) && tgt < Math.max(hi, d3.max(v)) ? [tgt] : [])])].sort((a, b) => a - b);
  // low head (deep drawdown) dark
  // drier (deeper water) at the dark end of the ramp; Reverse flips it
  const ramp = d3[`interpolate${$("in-ramp").value}`] || d3.interpolateYlGnBu;
  const flip = $("in-ramp-rev").checked !== ["Spectral", "RdYlBu"].includes($("in-ramp").value);
  const color = d3.scaleSequential(ramp).domain((drier !== flip) ? [lo, hi] : [hi, lo]).clamp(true);
  const op = parseFloat($("in-opacity").value);

  // color fill: a raster over the analysis box
  const cornerLL = [toLL({ x: box[0], y: box[2] }), toLL({ x: box[1], y: box[3] })];
  if ($("in-fill").checked) {
    const cv = document.createElement("canvas");
    cv.width = nx; cv.height = ny;
    const ctx = cv.getContext("2d"), img = ctx.createImageData(nx, ny);
    for (let i = 0; i < v.length; i++) {
      const c = d3.rgb(color(v[i]));
      img.data[4 * i] = c.r; img.data[4 * i + 1] = c.g; img.data[4 * i + 2] = c.b; img.data[4 * i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    fill.setBounds(L.latLngBounds(cornerLL));
    fill.setUrl(cv.toDataURL());
    fill.setOpacity(op);
  }

  // contour lines, labeled; the grid's own edges are left out
  const toWorld = ([cx, cy]) => toLL({
    x: box[0] + (cx - 0.5) / (nx - 1) * (box[1] - box[0]),
    y: box[3] - (cy - 0.5) / (ny - 1) * (box[3] - box[2]),
  });
  const onEdge = ([cx, cy]) => cx <= 0.5 || cx >= nx - 0.5 || cy <= 0.5 || cy >= ny - 0.5;
  const contours = d3.contours().size([nx, ny]).thresholds(levels)(Array.from(v));
  const exportLines = [];
  for (const c of contours) {
    const major = Math.abs(c.value - tgt) < 1e-9;
    for (const poly of c.coordinates) for (const ringPts of poly) {
      let seg = [];
      const flush = () => {
        if (seg.length > 2) {
          const ll = seg.map(toWorld);
          L.polyline(ll, { pane: "results", color: major ? "#E8582C" : "#1d2733", weight: major ? 2.5 : 1, opacity: 0.85, dashArray: major ? "7,5" : null, interactive: false }).addTo(lines);
          exportLines.push({ value: c.value, coords: ll.map((q) => [q.lng, q.lat]) });
          if (seg.length > 12) {
            L.tooltip({ permanent: true, direction: "center", className: "contour-label", interactive: false })
              .setLatLng(ll[Math.floor(ll.length / 2)]).setContent(c.value.toFixed(levelDigits(levels))).addTo(lines);
          }
        }
        seg = [];
      };
      for (const q of ringPts) { if (onEdge(q)) flush(); else seg.push(q); }
      flush();
    }
  }
  last.exportLines = exportLines;

  // where the head is below the target
  if ($("in-dewatered").checked) {
    const below = Array.from(last.h, (x) => p.target - x);
    const [cz] = d3.contours().size([nx, ny]).thresholds([0])(below);
    if (cz && cz.coordinates.length) {
      const polys = cz.coordinates.map((poly) => poly.map((r) => r.map(toWorld)));
      L.polygon(polys, { pane: "results", color: "#1e7a46", weight: 1.5, dashArray: "6,4", fillColor: "#2fa866", fillOpacity: 0.18, interactive: false }).addTo(shade);
    }
  }

  // the highest point in the excavation
  if (last.at && last.hmax > p.target) {
    L.circleMarker(toLL(last.at), { radius: 7, color: "#b3261e", weight: 3, fill: false, highPoint: true })
      .bindTooltip(p.site && p.site.elev ? `Highest water in the excavation: elevation ${fmt((p.site.gelev - p.site.dbase + last.hmax) / Lf(), 2)}` : p.site ? `Highest water in the excavation: ${fmtL(p.site.dbase - last.hmax, 2)} below ground` : `Highest water in the excavation: h = ${fmtL(last.hmax, 2)}`).addTo(marks);
  }

  // legend
  const key = (svg, t) => `<div class="key"><svg class="sw" width="24" height="14" viewBox="0 0 24 14">${svg}</svg>${t}</div>`;
  const stops = d3.range(0, 1.0001, 0.1).map((t) => color(drier ? lo + t * (hi - lo) : hi - t * (hi - lo)));
  $("legend").innerHTML = `<h4>${title}</h4><div class="bar" style="background:linear-gradient(to right, ${stops.join(",")})"></div>`
    + `<div class="ticks"><span>${fmt(drier ? lo : hi, 1)}</span><span>${fmt(drier ? hi : lo, 1)}</span></div>`
    // every mark on the map, each with its key
    + key(`<rect x="2" y="2" width="20" height="10" fill="rgba(232,88,44,.12)" stroke="#E8582C" stroke-width="2.5"/>`, "Excavation")
    + key(`<circle cx="12" cy="7" r="5" fill="#1F4E79" stroke="#fff" stroke-width="2"/><circle cx="12" cy="7" r="6.2" fill="none" stroke="#1F4E79" stroke-width="1"/>`, "Pumping well")
    + (last.wall ? key(`<line x1="1" y1="7" x2="23" y2="7" stroke="#fff" stroke-width="7"/><line x1="1" y1="7" x2="23" y2="7" stroke="#3d4550" stroke-width="4"/>`, "Cutoff wall") : "")
    + key(`<line x1="1" y1="7" x2="23" y2="7" stroke="#1d2733" stroke-width="1"/>`, `Contours, labeled in ${Ln()}`)
    + key(`<line x1="1" y1="7" x2="23" y2="7" stroke="#E8582C" stroke-width="2.5" stroke-dasharray="7,5"/>`, "Water at the required level (excavation bottom plus any extra depth)")
    + ($("in-dewatered").checked ? `<div class="key"><span class="sw" style="background:rgba(47,168,102,.35);border:1px dashed #1e7a46"></span>Below the required level</div>` : "")
    + (last.hw && last.hw.some((v) => v <= 0) ? key(`<circle cx="12" cy="7" r="5" fill="#b3261e" stroke="#fff" stroke-width="2"/><circle cx="12" cy="7" r="6.2" fill="none" stroke="#b3261e" stroke-width="1"/>`, "Well pumped dry") : "")
    + (state.section ? key(`<line x1="1" y1="7" x2="23" y2="7" stroke="#1d2733" stroke-width="2.5" stroke-dasharray="6,4"/>`, "Cross section line A–A′") : "")
    + (last.at && last.hmax > p.target ? `<div class="key"><span class="sw dot" style="border:2.5px solid #b3261e"></span>Highest water in the excavation</div>` : "")
    + (last.bar ? [["wait", "Time bar: still drawing down"], ["dew", "Time bar: dewatered"], ["dry", "Time bar: a well is dry"]]
      .filter(([k]) => last.bar.includes(k)).map(([k, t]) => `<div class="key"><span class="sw" style="background:${BAR[k]};height:6px;border-radius:3px"></span>${t}</div>`).join("") : "");
  $("legend").hidden = false;
}
const levelDigits = (lv) => (lv.length > 1 && lv[1] - lv[0] < 1 ? 1 : 0);

// The color ramp picker: a button showing the current ramp, opening a menu of ramps drawn as
// color bars. The hidden select keeps the value (saved with the project).
function rampCss(name, rev) {
  const f = d3[`interpolate${name}`];
  const st = d3.range(0, 1.0001, 0.1).map((t) => f(rev ? 1 - t : t));
  return `linear-gradient(to right, ${st.join(",")})`;
}
function buildRampPicker() {
  const sel = $("in-ramp"), btn = $("ramp-btn"), menu = $("ramp-menu");
  menu.innerHTML = "";
  [...sel.options].forEach((o) => {
    const b = document.createElement("button");
    b.type = "button"; b.className = "ramp-item"; b.setAttribute("role", "option");
    b.innerHTML = `<span class="ramp-bar" style="background:${rampCss(o.value, $("in-ramp-rev").checked)}"></span><span>${o.textContent}</span>`;
    b.onclick = () => { sel.value = o.value; menu.hidden = true; syncRampBtn(); drawResults(); persist(); };
    menu.appendChild(b);
  });
  btn.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; };
  document.addEventListener("click", (e) => { if (!menu.contains(e.target)) menu.hidden = true; });
  syncRampBtn();
}
function syncRampBtn() {
  const sel = $("in-ramp");
  $("ramp-btn").innerHTML = `<span class="ramp-bar" style="background:${rampCss(sel.value, $("in-ramp-rev").checked)}"></span><span class="ramp-name">${sel.selectedOptions[0].textContent}</span><span class="caret">▾</span>`;
  [...$("ramp-menu").children].forEach((b, i) => b.classList.toggle("on", i === sel.selectedIndex));
}
$("in-ramp-rev").addEventListener("change", buildRampPicker);
buildRampPicker();

["in-field", "in-interval", "in-fill", "in-dewatered", "in-ramp", "in-ramp-rev"].forEach((id) => $(id).addEventListener("change", () => { drawResults(); persist(); }));
$("in-opacity").addEventListener("input", () => fill.setOpacity(parseFloat($("in-opacity").value)));
["in-k", "in-k-unit", "in-ewt", "in-ebase", "in-eexc", "in-ereq", "in-R", "in-rw", "in-Q", "in-Q-unit", "in-dwt", "in-dbase", "in-dexc", "in-margin", "in-gelev", "in-woff", "in-wthick", "in-kw", "in-kw-unit", "in-sy", "in-tdays"]
  .forEach((id) => $(id).addEventListener("input", () => { updateDerived(); schedule(250); }));

// ------------------------------------------------------------------ terrain
// The ground elevation from open terrain tiles: the average over the excavation (points on a
// grid inside it), or around the wells if there is no excavation yet.
// "Use terrain" on: the ground elevation comes from the terrain (read-only), and the cross section
// draws the actual ground. Off: the ground elevation is typed in (or left blank), and the
// section shows level ground. The calculation treats the ground as level either way.
state.terrain = false;
// The ground under the excavation (or the wells): lowest, highest, and average, in meters.
async function groundStats() {
  const ring = excRing();
  const pts = ring || state.wells.map((w) => w.marker.getLatLng());
  if (!pts.length) return null;
  if (!state.origin) setOrigin(L.latLngBounds(pts).getCenter());
  let sample;
  if (ring) {
    const r = ring.map(toXY), xs = r.map((q) => q.x), ys = r.map((q) => q.y);
    sample = grid([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], 15, 15).filter((q) => inside(q, r)).map(toLL);
    if (!sample.length) sample = ring;
  } else sample = pts;
  const z = await elevations(sample);
  return { mean: z.reduce((a, b) => a + b, 0) / z.length, lo: Math.min(...z), hi: Math.max(...z), ring: !!ring };
}
// The range stays under the ground elevation field, so the levels can be entered against it.
let groundRange = null;
async function updateGroundRange() {
  try { groundRange = await groundStats(); } catch (_) { groundRange = null; }
  showGroundRange();
}
function showGroundRange() {
  const g = groundRange;
  $("ground-range").textContent = g ? `Ground under the ${g.ring ? "excavation" : "wells"} (terrain data): ${fmt(g.lo / Lf(), 1)} to ${fmtL(g.hi, 1)}, average ${fmtL(g.mean, 1)}.` : "";
}
async function readTerrain() {
  if (!excRing() && !state.wells.length) { alertMsg("Draw the excavation first."); return false; }
  try {
    const g = await groundStats();
    groundRange = g; showGroundRange();
    $("in-gelev").value = (g.mean / Lf()).toFixed(1);
    return true;
  } catch (e) {
    tip("Terrain data is unavailable right now. Enter the ground elevation by hand.", 4000);
    return false;
  }
}
async function setTerrain(on) {
  $("in-terrain").checked = on;
  if (on && !(await readTerrain())) on = false;
  $("in-terrain").checked = on;
  state.terrain = on;
  $("in-gelev").readOnly = on;
  updateDerived();
  schedule();
}
$("in-terrain").addEventListener("change", () => setTerrain($("in-terrain").checked));
// with terrain on, a new or reshaped excavation re-reads the ground under it
function refreshTerrain() {
  if (state.terrain) readTerrain().then(() => { updateDerived(); schedule(); });
  else updateGroundRange();
}

// ------------------------------------------------------------------ ground contours
// Dashed contours of the ground from the terrain tiles, for whatever the map shows, so a site's
// elevations can be read before the levels are entered. Drawn only when zoomed in to building
// scale: farther out the lines crowd and every pan loads many tiles.
const groundPane = map.createPane("ground");
groundPane.style.zIndex = 340;                // above the basemap, below the results
groundPane.style.pointerEvents = "none";
const groundLayer = L.layerGroup([], { pane: "ground" }).addTo(map);
const GROUND_ZOOM = 15;
let groundSeq = 0;
async function drawGround() {
  const seq = ++groundSeq;
  const on = $("in-gcont").checked, near = map.getZoom() >= GROUND_ZOOM;
  $("gcont-note").hidden = !on || near;
  if (!on || !near) { groundLayer.clearLayers(); return; }
  const b = map.getBounds(), n = 120;
  const w = b.getWest(), e = b.getEast(), so = b.getSouth(), no = b.getNorth();
  const pts = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) pts.push({ lat: no - (no - so) * i / (n - 1), lng: w + (e - w) * j / (n - 1) });
  let z;
  try { z = await elevations(pts); } catch (_) { if (seq === groundSeq) groundLayer.clearLayers(); return; }
  if (seq !== groundSeq) return;                // a newer view is on its way
  const v = Array.from(z, (x) => x / Lf()), lo = d3.min(v), hi = d3.max(v);
  groundLayer.clearLayers();
  if (!(hi > lo)) return;
  // about 8 to 25 lines across the view; every fifth line heavier and labeled
  const step = [0.5, 1, 2, 5, 10, 20, 50, 100].find((s) => (hi - lo) / s <= 25) || 100;
  const levels = d3.range(Math.ceil(lo / step) * step, hi, step);
  const toLLc = ([cx, cy]) => L.latLng(no - (no - so) * (cy - 0.5) / (n - 1), w + (e - w) * (cx - 0.5) / (n - 1));
  const onEdge = ([cx, cy]) => cx <= 0.5 || cx >= n - 0.5 || cy <= 0.5 || cy >= n - 0.5;
  for (const c of d3.contours().size([n, n]).thresholds(levels)(v)) {
    const major = Math.abs(c.value / (5 * step) - Math.round(c.value / (5 * step))) < 1e-6;
    for (const poly of c.coordinates) for (const ring of poly) {
      let seg = [];
      const flush = () => {
        if (seg.length > 2) {
          const ll = seg.map(toLLc);
          // a pale halo under the dashes, so they read over imagery as well as streets
          L.polyline(ll, { pane: "ground", color: "#fff", weight: major ? 3.6 : 2.6, opacity: 0.55, interactive: false }).addTo(groundLayer);
          L.polyline(ll, { pane: "ground", color: "#6b4e22", weight: major ? 1.8 : 1.2, opacity: 1, dashArray: major ? "8,4" : "4,4", interactive: false }).addTo(groundLayer);
          if (major && seg.length > 10) {
            L.tooltip({ permanent: true, direction: "center", className: "ground-label", interactive: false, pane: "ground" })
              .setLatLng(ll[Math.floor(ll.length / 2)]).setContent(fmt(c.value, step < 1 ? 1 : 0)).addTo(groundLayer);
          }
        }
        seg = [];
      };
      for (const q of ring) { if (onEdge(q)) flush(); else seg.push(q); }
      flush();
    }
  }
}
let groundTimer = null;
const scheduleGround = () => { clearTimeout(groundTimer); groundTimer = setTimeout(drawGround, 250); };
map.on("moveend zoomend", scheduleGround);
$("in-gcont").addEventListener("change", () => { drawGround(); persist(); });

// The ground elevation under the pointer, from the same tiles.
const PointerControl = L.Control.extend({
  options: { position: "bottomleft" },
  onAdd() { const d = L.DomUtil.create("div", "ground-readout"); d.hidden = true; return d; },
});
const pointer = new PointerControl().addTo(map);
let ptrSeq = 0, ptrTimer = null;
map.on("mousemove", (ev) => {
  clearTimeout(ptrTimer);
  ptrTimer = setTimeout(async () => {
    const seq = ++ptrSeq, el = pointer.getContainer();
    if (map.getZoom() < 10) { el.hidden = true; return; }
    try {
      const [z] = await elevations([ev.latlng]);
      if (seq === ptrSeq) { el.textContent = `Ground ${fmtL(z, 1)}`; el.hidden = false; }
    } catch (_) { el.hidden = true; }
  }, 60);
});
map.on("mouseout", () => { clearTimeout(ptrTimer); ptrSeq++; pointer.getContainer().hidden = true; });

// ------------------------------------------------------------------ cross section
const secLayer = L.layerGroup().addTo(map);
state.section = null;          // [LatLng A, LatLng B]
state.secDrawing = false;

function setSection(a, b) {
  state.section = [a, b];
  $("section-panel").hidden = false;
  $("divider").hidden = false;
  map.invalidateSize();
  $("btn-sec-close").hidden = false;
  drawSection();
  if (state.last) drawResults();          // the legend gains the section line's key
  persist();
}
function hideSection() {
  state.section = null;
  secLayer.clearLayers();
  $("section-panel").hidden = true;
  $("divider").hidden = true;
  map.invalidateSize();
  $("btn-sec-close").hidden = true;
  if (state.last) drawResults();
  persist();
}
// A line through the excavation's middle (or the wells'), east–west or north–south, reaching
// past them on both sides.
function centerSection(dir) {
  const pts = [...(excRing() || []), ...state.wells.map((w) => w.marker.getLatLng())];
  if (!pts.length) { alertMsg("Draw an excavation or add wells first."); return; }
  if (!state.origin) setOrigin(L.latLngBounds(pts).getCenter());
  const xy = pts.map(toXY), c = state.excavation ? toXY(state.excavation.getBounds().getCenter()) : toXY(L.latLngBounds(pts).getCenter());
  const xs = xy.map((p) => p.x), ys = xy.map((p) => p.y);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 20);
  const half = 0.5 * span + Math.max(0.9 * span, 60);
  let [a, b] = dir === "ew" ? [{ x: c.x - half, y: c.y }, { x: c.x + half, y: c.y }] : [{ x: c.x, y: c.y + half }, { x: c.x, y: c.y - half }];
  // through the wells exactly: the water drops to a well's level only within its radius, so a line
  // even half a meter off misses a dry well. The line runs through the well nearest the center
  // line on each side (tilting a little when they don't line up), or is shifted across to the one
  // well when one side has none.
  const k = dir === "ew" ? "y" : "x", j = dir === "ew" ? "x" : "y";
  const wl = state.wells.map((w) => toXY(w.marker.getLatLng()));
  const pick = (side) => wl.filter((v) => (side < 0 ? v[j] < c[j] : v[j] > c[j]))
    .reduce((u, v) => (!u || Math.abs(v[k] - c[k]) < Math.abs(u[k] - c[k]) ? v : u), null);
  const w1 = pick(dir === "ew" ? -1 : 1), w2 = pick(dir === "ew" ? 1 : -1);
  if (w1 && w2) {
    const L0 = Math.hypot(w2.x - w1.x, w2.y - w1.y), ex = (w2.x - w1.x) / L0, ey = (w2.y - w1.y) / L0, m0 = { x: (w1.x + w2.x) / 2, y: (w1.y + w2.y) / 2 };
    [a, b] = [{ x: m0.x - ex * half, y: m0.y - ey * half }, { x: m0.x + ex * half, y: m0.y + ey * half }];
  } else if (w1 || w2) { a[k] = b[k] = (w1 || w2)[k]; }
  setSection(toLL(a), toLL(b));
}
$("btn-sec-ew").onclick = () => centerSection("ew");
$("btn-sec-ns").onclick = () => centerSection("ns");
$("btn-sec-draw").onclick = () => {
  setAddMode(false);
  state.secDrawing = true;
  map.pm.enableDraw("Line", { templineStyle: { color: "#1d2733", dashArray: "6,4" }, hintlineStyle: { color: "#1d2733", dashArray: "6,4" } });
  tip("Click the two ends of the section line. Click the last point again to finish.");
};
$("btn-sec-close").onclick = hideSection;
$("btn-sec-x").onclick = hideSection;

function drawSection() {
  secLayer.clearLayers();
  const el = $("section-chart");
  if (!state.section || !state.last || !state.origin) { el.innerHTML = ""; return; }
  const [A, B] = state.section, a = toXY(A), b = toXY(B);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  if (!(len > 0)) return;
  // the line on the map, with its ends labeled
  L.polyline([A, B], { color: "#1d2733", weight: 2.5, dashArray: "8,5", interactive: false }).addTo(secLayer);
  [["A", A], ["A′", B]].forEach(([t, ll]) => L.tooltip({ permanent: true, direction: "center", className: "sec-label", interactive: false }).setLatLng(ll).setContent(t).addTo(secLayer));

  const { p, wells, ring, wall } = state.last;
  const N = 400, ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
  // evenly spaced points, plus points closing in on each well the line passes: the water drops
  // steeply in the last few meters, which even spacing steps over
  const ds = d3.range(N + 1).map((i) => len * i / N);
  wells.forEach((w) => {
    const d = (w.x - a.x) * ux + (w.y - a.y) * uy;
    if (d < 0 || d > len || Math.abs(-(w.x - a.x) * uy + (w.y - a.y) * ux) > 0.04 * len) return;
    ds.push(d);
    [1, 1.5, 2, 3, 5, 8, 13, 20, 35, 60, 100].forEach((f) => ds.push(d - f * p.rw, d + f * p.rw));
  });
  const dd = [...new Set(ds.filter((d) => d >= 0 && d <= len))].sort((u, v) => u - v);
  const pts = dd.map((d) => ({ x: a.x + ux * d, y: a.y + uy * d }));
  const h = state.last.headAt(pts);         // the same solution as the map
  const prof = pts.map((q, i) => ({ d: dd[i], h: h[i], inExc: ring ? inside(q, ring) : false, inWall: wall ? inside(q, wall.ring) : false }));
  state.secData = { prof, st: p.site };
  // wells within a few percent of the line's length of it, at their place along it
  const near = wells.map((w, i) => ({ i, d: (w.x - a.x) * ux + (w.y - a.y) * uy, off: Math.abs(-(w.x - a.x) * uy + (w.y - a.y) * ux) }))
    .filter((w) => w.d >= 0 && w.d <= len && w.off <= Math.max(0.04 * len, 3 * p.rw));
  // the excavation's stretches along the line
  const spans = [];
  prof.forEach((q, i) => {
    if (q.inExc && (i === 0 || !prof[i - 1].inExc)) spans.push([q.d, q.d]);
    if (q.inExc) spans[spans.length - 1][1] = q.d;
  });

  el.innerHTML = "";
  const Wd = el.clientWidth || 800, Ht = Math.max(110, el.clientHeight || 240), m = { l: 56, r: 16, t: 10, b: 34 };
  const x = d3.scaleLinear().domain([0, len]).range([m.l, Wd - m.r]);
  // heights above the low-k layer; with depths, the ground is at z = dbase and the axis reads
  // depth below ground (or elevation, when the ground elevation is given)
  const st = p.site;
  // terrain along the line, in heights above the low-k layer: fetched once per line, then drawn
  let terr = null;
  if (st && Number.isFinite(st.gelev) && state.terrain) {
    const key = `${A.lat},${A.lng},${B.lat},${B.lng}`;
    const c = drawSection.terr;
    if (!c || c.key !== key) {
      drawSection.terr = { key, pending: true };
      const M = 120, sp = d3.range(M + 1).map((i) => toLL({ x: a.x + ux * len * i / M, y: a.y + uy * len * i / M }));
      elevations(sp).then((z) => { drawSection.terr = { key, d: d3.range(M + 1).map((i) => len * i / M), e: Array.from(z) }; drawSection(); })
        .catch(() => { drawSection.terr = { key, failed: true }; });
    } else if (c.e) terr = { d: c.d, z: c.e.map((e) => e - (st.gelev - st.dbase)) };
  }
  const zTop = st ? Math.max(st.dbase, ...(terr ? terr.z : [])) + 0.05 * st.dbase : p.H * 1.08;
  const zBot = terr ? Math.min(0, ...terr.z) : 0;
  const y = d3.scaleLinear().domain([zBot, zTop]).range([Ht - m.b, m.t]);
  const asDepth = !!st;
  const lev = (z) => (asDepth ? (Number.isFinite(st.gelev) ? st.gelev - st.dbase + z : st.dbase - z) : z);
  const unlev = (v) => (asDepth ? (Number.isFinite(st.gelev) ? v - (st.gelev - st.dbase) : st.dbase - v) : v);
  // round ticks in the display unit, placed on the SI scales
  const ticksIn = (a0, a1, n) => d3.ticks(Math.min(a0, a1), Math.max(a0, a1), n);
  const svg = d3.select(el).append("svg").attr("class", "chart").attr("width", Wd).attr("height", Ht);
  // saturated soil under the water level
  // soil: from the terrain down when it is shown, otherwise from the level ground
  const tz = terr ? (d) => { const i = Math.min(terr.d.length - 2, Math.max(0, Math.floor(d / terr.d[terr.d.length - 1] * (terr.d.length - 1))));
    const f = (d - terr.d[i]) / (terr.d[i + 1] - terr.d[i]); return terr.z[i] + f * (terr.z[i + 1] - terr.z[i]); } : null;
  if (terr) svg.append("path").datum(terr.d).attr("fill", "#f1e6cc").attr("d", d3.area().x((d) => x(d)).y0(y(0)).y1((d) => y(tz(d))));
  else if (st) svg.append("rect").attr("x", m.l).attr("width", Wd - m.l - m.r).attr("y", y(st.dbase)).attr("height", y(0) - y(st.dbase)).attr("fill", "#f1e6cc");
  svg.append("path").datum(prof).attr("fill", "#cfe3f1")
    .attr("d", d3.area().x((q) => x(q.d)).y0(y(0)).y1((q) => y(q.h)));
  spans.forEach(([d0, d1]) => {
    if (st) {        // the pit, cut from the ground down to the excavation bottom
      const zb = st.dbase - st.dexc;
      const topAt = (d) => (terr ? Math.max(tz(d), zb) : st.dbase);
      const ds = d3.range(0, 41).map((i) => d0 + (d1 - d0) * i / 40);
      const pit = [[d0, zb], ...ds.map((d) => [d, topAt(d)]), [d1, zb]];
      svg.append("path").attr("d", d3.line().x((q) => x(q[0])).y((q) => y(q[1]))(pit) + "Z")
        .attr("fill", "#ffffff").attr("stroke", "#8a6d3b").attr("stroke-width", 1.5);
      svg.append("text").attr("x", (x(d0) + x(d1)) / 2).attr("y", (y(Math.min(...ds.map(topAt))) + y(zb)) / 2 + 4).attr("text-anchor", "middle").attr("fill", "#8a6d3b")
        .attr("paint-order", "stroke").attr("stroke", "#fff").attr("stroke-width", 4).text("Excavation");
    } else {
      svg.append("rect").attr("x", x(d0)).attr("width", Math.max(1, x(d1) - x(d0))).attr("y", y(zTop)).attr("height", y(0) - y(zTop))
        .attr("fill", "rgba(232,88,44,.10)").attr("stroke", "#E8582C").attr("stroke-dasharray", "4,3");
      svg.append("text").attr("x", (x(d0) + x(d1)) / 2).attr("y", y(p.H * 1.04)).attr("text-anchor", "middle").attr("fill", "#b5441f").text("Excavation");
    }
  });
  svg.append("g").attr("transform", `translate(0,${Ht - m.b})`).call(d3.axisBottom(x).tickValues(ticksIn(0, len / Lf(), 10).map((t) => t * Lf())).tickFormat((d) => fmt(d / Lf(), 0)));
  svg.append("g").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).tickValues(ticksIn(lev(zBot) / Lf(), lev(zTop) / Lf(), 6).map((t) => unlev(t * Lf()))).tickFormat((z) => fmt(lev(z) / Lf(), 0)));
  // labels at the right end, above the line (below it with below = true)
  const hline = (v, col, dash, label, below, width = 1.5) => {
    svg.append("line").attr("x1", m.l).attr("x2", Wd - m.r).attr("y1", y(v)).attr("y2", y(v)).attr("stroke", col).attr("stroke-width", width).attr("stroke-dasharray", dash);
    svg.append("text").attr("x", Wd - m.r - 4).attr("y", y(v) + (below ? 13 : -4)).attr("text-anchor", "end").attr("fill", col)
      .attr("paint-order", "stroke").attr("stroke", "#fff").attr("stroke-width", 4).attr("stroke-linejoin", "round").text(label);
  };
  if (st) {
    if (!terr) hline(st.dbase, "#8a6d3b", "", "Ground");
    const el = (z) => fmt((st.gelev - st.dbase + z) / Lf(), 1);
    hline(p.H, "#5b6875", "6,4", st.elev ? `Water table before pumping, elevation ${el(p.H)}` : `Water table before pumping, ${fmtL(st.dwt, 1)} deep`, !!terr);
    hline(p.target, "#E8582C", "6,4", st.elev ? `Required level, elevation ${el(p.target)}` : `Required level, ${fmtL(st.dexc + st.margin, 1)} deep`);
  } else {
    hline(p.H, "#5b6875", "6,4", `Static level, H = ${fmtL(p.H, 1)}`);
    hline(p.target, "#E8582C", "6,4", `Target, ${fmtL(p.target, 1)}`);
  }
  svg.append("line").attr("x1", m.l).attr("x2", Wd - m.r).attr("y1", y(0)).attr("y2", y(0)).attr("stroke", "#1d2733").attr("stroke-width", 3);
  svg.append("path").datum(prof).attr("fill", "none").attr("stroke", "#1F4E79").attr("stroke-width", 2.5)
    .attr("d", d3.line().x((q) => x(q.d)).y((q) => y(q.h)));
  // the cutoff wall where the line crosses it, from the ground to the low-k layer
  prof.forEach((q, i) => {
    if (!i || q.inWall === prof[i - 1].inWall) return;
    const d = (q.d + prof[i - 1].d) / 2, top = terr ? tz(d) : st ? st.dbase : zTop;
    const wpx = Math.max(5, x(wall.w.t) - x(0));
    svg.append("rect").attr("x", x(d) - wpx / 2).attr("width", wpx).attr("y", y(top)).attr("height", y(0) - y(top))
      .attr("fill", "#8e99a6").attr("stroke", "#1d2733").attr("stroke-width", 1);
  });
  // each well near the line, with the water inside it: the head at the well's own radius, which
  // the line seldom passes through (the drawdown curve plunges in the last meter). A well pumped
  // dry is drawn red and labeled.
  const hw = state.last.hw || [];
  near.forEach((w) => {
    const wt = terr ? tz(w.d) : st ? st.dbase : zTop;          // the casing reaches the ground
    const dry = hw[w.i] <= 0, col = dry ? "#b3261e" : "#1F4E79";
    svg.append("rect").attr("x", x(w.d) - 3).attr("width", 6).attr("y", y(wt)).attr("height", y(0) - y(wt))
      .attr("fill", "#fff").attr("stroke", col).attr("stroke-width", 1.5);
    if (hw[w.i] > 0) svg.append("rect").attr("x", x(w.d) - 2).attr("width", 4).attr("y", y(hw[w.i])).attr("height", y(0) - y(hw[w.i])).attr("fill", "#7fb2d9");
    if (dry) svg.append("text").attr("x", x(w.d)).attr("y", y(0) - 6).attr("text-anchor", "middle").attr("fill", col).attr("font-weight", 600)
      .attr("paint-order", "stroke").attr("stroke", "#fff").attr("stroke-width", 4).text("Dry");
  });
  svg.append("text").attr("class", "axis-title").attr("x", m.l + 4).attr("y", Ht - 4).text("A");
  svg.append("text").attr("class", "axis-title").attr("x", Wd - m.r - 4).attr("y", Ht - 4).attr("text-anchor", "end").text("A′");
  svg.append("text").attr("class", "axis-title").attr("x", (m.l + Wd - m.r) / 2).attr("y", Ht - 4).attr("text-anchor", "middle").text(`Distance along the section (${Ln()})`);
  svg.append("text").attr("class", "axis-title").attr("transform", `translate(14,${(m.t + Ht - m.b) / 2}) rotate(-90)`).attr("text-anchor", "middle").text(`${st ? (Number.isFinite(st.gelev) ? "Elevation" : "Depth below ground") : "Head, h"} (${Ln()})`);
  // the actual ground along the line, from the terrain tiles (read in drawSection's first lines)
  if (terr) {
    svg.append("path").datum(terr.d.map((d, i) => [d, terr.z[i]])).attr("fill", "none").attr("stroke", "#5c4a1f").attr("stroke-width", 2)
      .attr("d", d3.line().x((q) => x(q[0])).y((q) => y(q[1])));
    const k = Math.floor(terr.d.length * 0.1);
    svg.append("text").attr("x", x(terr.d[k])).attr("y", y(terr.z[k]) - 6).attr("fill", "#5c4a1f")
      .attr("paint-order", "stroke").attr("stroke", "#fff").attr("stroke-width", 4).text("Ground (terrain)");
  }

  // the highest water inside the excavation along this line
  const inEx = prof.filter((q) => q.inExc);
  if (inEx.length) {
    const top = inEx.reduce((u, v) => (v.h > u.h ? v : u));
    svg.append("circle").attr("cx", x(top.d)).attr("cy", y(top.h)).attr("r", 4.5).attr("fill", top.h > p.target + 0.005 ? "#b3261e" : "#1e7a46");
    // to the right of the point, on a white backing so it reads over any line
    const right = x(top.d) < (m.l + Wd - m.r) / 2;
    svg.append("text").attr("x", x(top.d) + (right ? 9 : -9)).attr("y", y(top.h) - 7).attr("text-anchor", right ? "start" : "end").attr("fill", "#1d2733")
      .attr("paint-order", "stroke").attr("stroke", "#fff").attr("stroke-width", 4).attr("stroke-linejoin", "round")
      .text(st && st.elev ? `elevation ${fmt((st.gelev - st.dbase + top.h) / Lf(), 2)}` : st ? `${fmtL(st.dbase - top.h, 2)} deep` : `h = ${fmtL(top.h, 2)}`);
  }
  $("section-title").textContent = `Cross section A–A′ (${fmtL(len, 0)})${near.length ? ` · ${near.length} well${near.length > 1 ? "s" : ""} on the line` : ""}`
    + (terr ? " · ground from terrain data; the calculation treats it as level" : "");
}
window.addEventListener("resize", () => drawSection());

// The divider between the map and the section: drag (or arrow keys) to share the height.
{
  const div = $("divider"), pane = $("section-panel"), work = document.querySelector(".workarea");
  const setH = (h) => {
    const max = work.clientHeight - 120 - div.offsetHeight;
    pane.style.height = `${Math.round(Math.min(Math.max(h, 140), max))}px`;
    map.invalidateSize();
    drawSection();
  };
  let y0 = 0, h0 = 0;
  div.addEventListener("pointerdown", (e) => {
    y0 = e.clientY; h0 = pane.offsetHeight;
    div.setPointerCapture(e.pointerId); div.classList.add("dragging");
  });
  div.addEventListener("pointermove", (e) => { if (div.classList.contains("dragging")) setH(h0 - (e.clientY - y0)); });
  const end = (e) => { if (!div.classList.contains("dragging")) return; div.classList.remove("dragging"); div.releasePointerCapture(e.pointerId); try { localStorage.setItem("dewater:secH", pane.style.height); } catch (_) { /* storage unavailable */ } };
  div.addEventListener("pointerup", end);
  div.addEventListener("pointercancel", end);
  div.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); setH(pane.offsetHeight + (e.key === "ArrowUp" ? 24 : -24)); }
  });
  try { const h = localStorage.getItem("dewater:secH"); if (h) pane.style.height = h; } catch (_) { /* storage unavailable */ }
}

// ------------------------------------------------------------------ minimum design pumping rate
$("btn-optimize").onclick = () => {
  stopAnim(); state.viewT = null;
  const p = params(), err = checkParams({ ...p, Q: 0 });
  if (err) return setStatus("bad", err);
  const ring = excRing();
  if (ring && wallOn() && !wallGeom()) return setStatus("idle", "Draw or load the cutoff wall first.");
  if (!ring || !state.wells.length) return setStatus("idle", "Finding Q\u2098\u1d62\u2099 needs an excavation and wells.");
  const r = ring.map(toXY), wells = state.wells.map((w) => toXY(w.marker.getLatLng()));
  state.fastQ = null;
  const inf = () => infFor(p, state.wells.map((w) => w.marker.getLatLng()));      // the grid model with a wall
  if (p.t !== undefined) {
    // transient: the smallest starting rate whose schedule meets the deadline, or, if the wells
    // can't meet it, the fastest schedule they can deliver
    setStatus("idle", "Finding the design for the deadline…");
    setTimeout(() => {
      const d = deadlineRate(checkPoints(r), wells, p, p.target, tDesign(), tEnd(), inf());
      if (!d) return setStatus("bad", "No pumping rate works with these wells.");
      const qv = d.Q / Qf(), mag = 10 ** (Math.floor(Math.log10(qv)) - 5);
      $("in-Q").value = trim(Math.ceil(qv / mag) * mag);
      state.optQ = d.met ? +$("in-Q").value * Qf() : null;
      state.fastQ = d.met ? null : +$("in-Q").value * Qf();
      run(); persist();
    }, 30);
    return;
  }
  const fi = inf(), opt = fi ? optimalWith(checkPoints(r), wells, p, p.target, (pts) => fi(pts, 0)) : optimalWithR(checkPoints(r), wells, p);
  if (!opt || !isFinite(opt.Q)) return setStatus("bad", "No pumping rate works with these wells.");
  state.optNote = "";
  // rounded up at six figures, so the entered rate still meets the target
  const qv = opt.Q / Qf(), mag = 10 ** (Math.floor(Math.log10(qv)) - 5);
  $("in-Q").value = trim(Math.ceil(qv / mag) * mag);
  state.optQ = opt.feasible ? opt.Q : null;
  run(); persist();
  if (!opt.feasible) setStatus("bad", `The minimum design pumping rate would pump a well dry. ${fi ? "Add wells or move them." : "Add wells, move them farther out, or enclose the site with a cutoff wall (step 4)."}`);
};

// ------------------------------------------------------------------ design curves
// Q_min against the number of wells (rings at the offset), or against k for the wells on
// the map. With R entered, Q is exactly proportional to k; with R from Sichardt or Kusakin, R
// grows with √k and Q grows more slowly. The k curve shows both, so the role of R is plain.
let curveRows = [], curveVar = "n";
const kUnitLabel = () => $("in-k-unit").selectedOptions[0].textContent;
function syncCurveInputs() {
  const v = $("in-curve-var").value;
  $("curve-n").hidden = v !== "n"; $("curve-k").hidden = v !== "k"; $("curve-t").hidden = v !== "t";
  document.querySelectorAll(".uK").forEach((e) => (e.textContent = kUnitLabel()));
  const tr = flow() === "transient" && !$("in-wall").checked;
  if (tr) return void ($("curve-hint").textContent = v === "n" ? "The starting rate for the deadline (step 2) against the number of wells, and the fewest wells that can meet it."
    : v === "t" ? "The starting rate, and the water pumped to dewater, against the deadline, for the wells on the map. The shortest deadline the wells can meet is marked."
    : "The starting rate for the deadline (step 2) against k, for the wells on the map: what a wrong guess at k costs.");
  $("curve-hint").textContent = v === "n" ? "Past some n, more wells barely lower Q."
    : v === "t" ? "For the wells on the map (or the cutoff wall), with transient flow: the less time allowed, the more pumping."
    : "For the wells on the map. With R entered, Q is simply proportional to k; choose Sichardt or Kusakin for R to see how R's growth with k changes that.";
}
$("in-curve-var").addEventListener("change", syncCurveInputs);
$("btn-curve").onclick = () => {
  const p = params(), err = checkParams({ ...p, Q: 0 });
  if (err) return setStatus("bad", err);
  if (!state.excavation) return setStatus("idle", "The design curve needs an excavation.");
  const cp = checkPoints(excRing().map(toXY));
  curveVar = $("in-curve-var").value;
  curveRows = []; state.curveDeadline = false; curveRun++; $("btn-curve").textContent = "Compute the design curve";
  const LLs = () => state.wells.map((w) => w.marker.getLatLng());
  if (wallOn() && !wallGeom()) return alertMsg("Draw or load the cutoff wall first.");
  state.curveWall = wallOn();
  if (curveVar === "t") {
    const t0 = num("in-tmin") * 86400, t1 = num("in-tmax") * 86400;
    if (!(t0 > 0 && t1 > t0)) return alertMsg("Enter a range of days, smallest first.");
    if (p.t === undefined) return alertMsg("The design against the deadline needs transient flow (step 2).");
    if (!state.wells.length) return alertMsg("Place or generate the wells first.");
    const wells = state.wells.map((w) => toXY(w.marker.getLatLng()));
    // the fastest the wells can dewater (pumping as hard as they can without going dry) bounds
    // the deadlines; points evenly spaced in days from there, with a few more just past it,
    // where the curve bends most. With a wall, one grid model runs to the longest deadline.
    const btn = $("btn-curve"), id = ++curveRun, tMax = Math.max(2 * t1, 10 * 86400) + 35 * 86400;
    btn.textContent = "Computing\u2026";
    setTimeout(() => {
      if (id !== curveRun) return;
      const fi = infFor(p, LLs(), tMax);
      const fast = pumpSchedule(cp, wells, p, p.target, Infinity, Math.max(2 * t1, 10 * 86400), undefined, undefined, undefined, fi).tDew;
      btn.textContent = "Compute the design curve";
      if (!(fast < t1)) return alertMsg(`These wells can't dewater the excavation by day ${dayN(t1)}, even pumping as hard as they can without going dry.`);
      const a = Math.max(t0, fast * 1.001), xs = Array.from({ length: 16 }, (_, i) => a + (t1 - a) * i / 15);
      if (a < 2 * fast) xs.push(...[1.03, 1.08, 1.15, 1.3].map((f) => a * f).filter((t) => t < xs[1]));
      xs.sort((u, v) => u - v);
      deadlineCurve(cp, p, xs, () => wells, (t) => ({ td: t }), fast, () => fi);
    }, 30);
    return;
  }
  if (p.t !== undefined) {
    // transient: each point is the design for the deadline (model.js deadlineRate)
    const td = tDesign();
    if (curveVar === "n") {
      const n0 = Math.max(1, Math.round(num("in-nmin"))), n1 = Math.round(num("in-nmax")), off = numL("in-offset");
      if (!(n1 > n0)) return alertMsg("Enter a range of numbers of wells, smallest first.");
      const ns = []; for (let n = n0; n <= Math.min(n1, n0 + 300); n++) ns.push(n);
      return deadlineCurve(cp, p, ns, (n) => ringWells(n, off).map(toXY), () => ({ td }), null, (n) => infFor(p, ringWells(n, off)));
    }
    if (!state.wells.length) return alertMsg("Place or generate the wells first.");
    const ku = K_UNITS[$("in-k-unit").value], k0 = num("in-kmin") * ku, k1 = num("in-kmax") * ku;
    if (!(k0 > 0 && k1 > k0)) return alertMsg("Enter a range of k, smallest first.");
    const wells = state.wells.map((w) => toXY(w.marker.getLatLng()));
    return deadlineCurve(cp, p, Array.from({ length: 21 }, (_, i) => k0 * (k1 / k0) ** (i / 20)), () => wells, (k) => ({ td, k }), null, (k) => infFor({ ...p, k }, LLs()));
  }
  if (curveVar === "n") {
    const n0 = Math.max(1, Math.round(num("in-nmin"))), n1 = Math.round(num("in-nmax")), off = numL("in-offset");
    if (!(n1 > n0)) return alertMsg("Enter a range of numbers of wells, smallest first.");
    for (let n = n0; n <= Math.min(n1, n0 + 300); n++) {
      const ll = ringWells(n, off), wells = ll.map(toXY), fi = infFor(p, ll);
      const o = fi ? optimalWith(cp, wells, p, p.target, (pts) => fi(pts, 0)) : optimalWithR(cp, wells, p);
      curveRows.push({ x: n, Q: o.Q, qEach: o.qEach, feasible: o.feasible });
    }
  } else {
    if (!state.wells.length) return alertMsg("Place or generate the wells first.");
    const ku = K_UNITS[$("in-k-unit").value], k0 = num("in-kmin") * ku, k1 = num("in-kmax") * ku;
    if (!(k0 > 0 && k1 > k0)) return alertMsg("Enter a range of k, smallest first.");
    const wells = state.wells.map((w) => toXY(w.marker.getLatLng()));
    const Rfix = state.last ? state.last.p.R : p.R;        // the comparison: R as it stands now
    state.curveRfix = Rfix;
    for (let i = 0; i <= 30; i++) {
      const k = k0 * (k1 / k0) ** (i / 30);
      const R = radius(p, k);
      if (!(R > p.rw)) continue;
      const fi = infFor({ ...p, k, R }, LLs()), ff = infFor({ ...p, k, R: Rfix }, LLs());
      const o = fi ? { ...optimalWith(cp, wells, { ...p, k, R }, p.target, (pts) => fi(pts, 0)), R } : optimalWithR(cp, wells, p, k);
      const of = ff ? optimalWith(cp, wells, { ...p, k, R: Rfix }, p.target, (pts) => ff(pts, 0)) : optimalRate(cp, wells, { ...p, k, R: Rfix }, p.target);
      curveRows.push({ x: k, R: o.R, Q: o.Q, qEach: o.qEach, feasible: o.feasible, Qfixed: of.Q });
    }
  }
  drawCurve();
  $("dlg-curve").showModal();
};
// The transient curves: for each x, the design for the deadline (model.js deadlineRate): the
// starting rate, whether it is cut back to keep the wells wet, the day dewatered, and the water
// pumped until then. Where even the fastest schedule misses the deadline, the row is marked missed.
// A point takes up to a few seconds where the wells limit the rate, so the rows are computed one
// at a time, with the count on the button; clicking again starts over.
let curveRun = 0;
function deadlineCurve(cp, p, xs, wellsOf, caseOf, fast = null, infOf = null) {
  const id = ++curveRun, btn = $("btn-curve"), label = "Compute the design curve";
  curveRows = []; state.curveDeadline = true; state.curveTd = tDesign(); state.curveFast = fast;
  const step = (i) => {
    if (id !== curveRun) return;
    if (i === xs.length) {
      btn.textContent = label;
      // against the deadline: the fastest the wells can do, where the shortest deadlines miss
      $("dlg-curve").showModal();            // open first: the keys are laid out by their text widths
      drawCurve();
      return;
    }
    btn.textContent = `Computing\u2026 ${i + 1} of ${xs.length}`;
    setTimeout(() => {
      if (id !== curveRun) return;
      const x = xs[i], c = caseOf(x), pk = c.k ? { ...p, k: c.k } : p, wells = wellsOf(x);
      const d = deadlineRate(cp, wells, pk, p.target, c.td, Math.max(2 * c.td, 10 * 86400), infOf ? infOf(x) : null);
      if (d) curveRows.push({ x, Q: d.Q, met: d.met, capped: d.capped, tDew: d.tDew, feasible: d.met,
        vol: d.met ? (d.sched ? pumpedBy(d.sched, d.tDew) : d.Q * d.tDew) : NaN });
      step(i + 1);
    }, 0);
  };
  step(0);
}
function drawCurve() {
  if (state.curveDeadline) return drawDeadlineCurve();
  const uq = Qf(), unit = Qn(), byK = curveVar === "k", byT = curveVar === "t", ku = K_UNITS[$("in-k-unit").value];
  const tr = flow() === "transient", auto = byK && !tr && params().Rmethod !== "entered", logX = byK || byT;
  const el = $("curve-chart");
  el.innerHTML = "";
  const W = Math.min(720, window.innerWidth * 0.9), H = 360, m = { l: 70, r: 20, t: 14, b: 46 };
  // against time, the rates that would pump a well dry soar at short times and are left off
  const fin = curveRows.filter((r) => isFinite(r.Q)), feas = fin.filter((r) => r.feasible), dropDry = byT && feas.length >= 2 && feas.length < fin.length;
  const ok = dropDry ? feas : fin;
  const xv = (r) => (byK ? r.x / ku : byT ? r.x / 86400 : r.x);
  const x = (logX ? d3.scaleLog() : d3.scaleLinear()).domain(d3.extent(ok, xv)).range([m.l, W - m.r]);
  const ys = ok.flatMap((r) => (auto ? [r.Q, r.Qfixed] : [r.Q]).map((q) => q / uq));
  const lo = d3.min(ys), hi = d3.max(ys);
  const y = logX ? d3.scaleLog().domain([lo / 1.1, hi * 1.1]).range([H - m.b, m.t])
    : d3.scaleLinear().domain([Math.max(0, lo - 0.1 * (hi - lo || lo)), hi + 0.05 * (hi - lo || lo)]).nice().range([H - m.b, m.t]);
  const svg = d3.select(el).append("svg").attr("class", "chart").attr("width", W).attr("height", H);
  svg.append("g").attr("transform", `translate(0,${H - m.b})`).call(logX ? d3.axisBottom(x).ticks(6, "~g") : d3.axisBottom(x).ticks(10).tickFormat(d3.format("d")));
  svg.append("g").attr("transform", `translate(${m.l},0)`).call(logX ? d3.axisLeft(y).ticks(6, "~g") : d3.axisLeft(y).ticks(8));
  svg.append("g").attr("stroke", "#e5eaef").selectAll("line").data(y.ticks(8)).join("line")
    .attr("x1", m.l).attr("x2", W - m.r).attr("y1", (d) => y(d)).attr("y2", (d) => y(d));
  if (auto) {
    svg.append("path").datum(ok).attr("fill", "none").attr("stroke", "#8a96a3").attr("stroke-width", 2).attr("stroke-dasharray", "6,4")
      .attr("d", d3.line().x((r) => x(xv(r))).y((r) => y(r.Qfixed / uq)));
  }
  svg.append("path").datum(ok).attr("fill", "none").attr("stroke", "#1F4E79").attr("stroke-width", 2.5)
    .attr("d", d3.line().x((r) => x(xv(r))).y((r) => y(r.Q / uq)));
  svg.append("g").selectAll("circle").data(ok).join("circle").attr("cx", (r) => x(xv(r))).attr("cy", (r) => y(r.Q / uq)).attr("r", 3.5)
    .attr("fill", (r) => (r.feasible ? "#1F4E79" : "#b3261e"))
    .append("title").text((r) => `${byK ? `k = ${fmtNum(xv(r))} ${kUnitLabel()}${tr ? "" : `, R = ${fmtL(r.R, 0)}`}` : byT ? `${fmtNum(xv(r))} days` : `${r.x} wells`}: Q = ${fmtNum(r.Q / uq)} ${unit}${r.feasible ? "" : " (a well runs dry)"}`);
  // legend: the two R curves, and the red points when any are plotted
  const keys = auto ? [["#1F4E79", "", `R from ${params().Rmethod === "sichardt" ? "Sichardt" : "Kusakin"} (grows with √k)`], ["#8a96a3", "6,4", `R fixed at ${fmtL(state.curveRfix, 0)}`]] : [];
  if (ok.some((r) => !r.feasible)) keys.push(["#b3261e", null, "A well runs dry"]);
  if (keys.length) {
    // Q falls with n and t, so their curves start top left: their key goes top right
    const lg = svg.append("g").attr("transform", `translate(${auto ? m.l + 12 : W - m.r - 135},${m.t + 8})`);
    keys.forEach(([c, dash, t], i) => {
      if (dash === null) lg.append("circle").attr("cx", 13).attr("cy", i * 18).attr("r", 3.5).attr("fill", c);
      else lg.append("line").attr("x1", 0).attr("x2", 26).attr("y1", i * 18).attr("y2", i * 18).attr("stroke", c).attr("stroke-width", 2.5).attr("stroke-dasharray", dash);
      lg.append("text").attr("x", 32).attr("y", i * 18 + 4).text(t);
    });
  }
  svg.append("text").attr("class", "axis-title").attr("x", (m.l + W - m.r) / 2).attr("y", H - 8).attr("text-anchor", "middle").text(byK ? `Hydraulic conductivity, k (${kUnitLabel()})` : byT ? "Days to dewater, t" : "Number of wells, n");
  svg.append("text").attr("class", "axis-title").attr("transform", `translate(16,${(m.t + H - m.b) / 2}) rotate(-90)`).attr("text-anchor", "middle").call((t) => { t.append("tspan").text("Q"); t.append("tspan").attr("baseline-shift", "sub").attr("font-size", "75%").text("min"); t.append("tspan").text(` (${unit})`); });
  $("curve-title").innerHTML = `Design curve: Q<sub>min</sub> vs. ${byK ? "hydraulic conductivity" : byT ? "days to dewater" : "number of wells"}`;
  const bad = curveRows.filter((r) => !r.feasible).map((r) => (logX ? fmtNum(xv(r)) : r.x));
  $("curve-note").innerHTML = (state.curveWall ? "With the cutoff wall around the site (each point its own grid model of the wells and the wall). " : "")
    + (byT ? `The ${state.wells.length} wells on the map, equal rates, transient flow: Q<sub>min</sub> dewaters the excavation by day t; after that a lower rate holds it.`
    : (byK ? `The ${state.wells.length} wells on the map, equal rates.${tr ? ` Transient flow, day ${fmtNum(num("in-tdays"))}: Q grows more slowly than k, because the drawdown spreads farther in more permeable ground.` : auto ? "" : " R is entered, so Q is proportional to k."}` : `Rings at ${fmt(parseFloat($("in-offset").value), 1)} ${Ln()} from the edge, equal rates.`))
    + (dropDry ? ` Before day ${bad[bad.length - 1]}, Q<sub>min</sub> would pump a well dry (${bad.length} of ${curveRows.length} times); those are left off the plot.`
      : bad.length ? ` Red points: Q<sub>min</sub> would pump a well dry (${byK ? `${bad.length} of ${curveRows.length} values of k, from ${bad[0]} to ${bad[bad.length - 1]} ${kUnitLabel()}` : byT ? `${bad.length} of ${curveRows.length} times, from day ${bad[0]} to day ${bad[bad.length - 1]}` : `n = ${bad.join(", ")}`}).` : "");
}
// The transient curves: the starting rate of the deadline design, each point colored by whether the
// rate stays constant until dewatered or is cut back to keep the wells wet. Against the deadline, the
// water pumped to dewater on a second axis; a gray line marks the fewest wells, or the shortest
// deadline, that the wells can meet. Every mark has its key above the plot.
const CUT = "#c26a00", VOL = "#3a7d44";
function drawDeadlineCurve() {
  const uq = Qf(), unit = Qn(), byK = curveVar === "k", byT = curveVar === "t", ku = K_UNITS[$("in-k-unit").value], logX = byK;
  const el = $("curve-chart");
  el.innerHTML = "";
  const W = Math.min(720, window.innerWidth * 0.9), H = 380, m = { l: 70, r: byT ? 70 : 20, t: 0, b: 46 };
  const ok = curveRows.filter((r) => r.met && isFinite(r.Q)), miss = curveRows.filter((r) => !r.met);
  const xv = (r) => (byK ? r.x / ku : byT ? r.x / 86400 : r.x);
  const xName = byK ? "hydraulic conductivity" : byT ? "deadline" : "number of wells";
  $("curve-title").innerHTML = `Design curve: starting rate vs. ${xName}`;
  const tdN = dayN(state.curveTd), nw = state.wells.length;
  const setup = byT ? `The ${nw} wells on the map` : byK ? `The ${nw} wells on the map, dewatering by day ${tdN}` : `Rings at ${fmt(parseFloat($("in-offset").value), 1)} ${Ln()} from the edge, dewatering by day ${tdN}`;
  const explain = ` Each point is the design for the deadline: the smallest starting rate that dewaters the excavation in time, cut back weekly where a well would otherwise go dry. After that a lower rate holds the water down.`;
  const missNote = byT ? (state.curveFast ? ` The wells can't dewater in less than ${dayN(state.curveFast)} days, even pumping as hard as they can without going dry.` : "") : !miss.length ? ""
    : byK ? ` For ${miss.length} of ${curveRows.length} values of k (${fmtNum(xv(miss[0]))} to ${fmtNum(xv(miss[miss.length - 1]))} ${kUnitLabel()}) the wells can't meet the deadline at any rate; they are left off.`
    : ` With ${miss.length > 2 && miss[miss.length - 1].x - miss[0].x === miss.length - 1 ? `${miss[0].x} to ${miss[miss.length - 1].x}` : miss.map((r) => r.x).join(", ")} wells the deadline can't be met at any rate; they are left off.`;
  $("curve-note").innerHTML = setup + (state.curveWall ? ", inside the cutoff wall" : "") + "." + explain + missNote;
  if (!ok.length) { el.textContent = "No point on the curve meets the deadline."; return; }
  const first = d3.min(ok, xv), band = byT ? !!state.curveFast : miss.some((r) => xv(r) < first);
  const keys = [];
  if (band) keys.push(["#eef1f4", "box", "Can't meet the deadline"]);
  if (ok.some((r) => !r.capped)) keys.push(["#1F4E79", null, "Constant rate until dewatered"]);
  if (ok.some((r) => r.capped)) keys.push([CUT, null, "Cut back weekly so no well runs dry"]);
  if (byT) keys.push([VOL, "6,4", "Water pumped to dewater (right axis)"]);
  // the keys first, in as many rows as they need across the plot's width; the plot starts below them
  const svg = d3.select(el).append("svg").attr("class", "chart").attr("width", W).attr("height", H);
  const lg = svg.append("g");
  let kx = m.l, ky = 14;
  keys.forEach(([c, dash, t]) => {
    const g = lg.append("g"), tx = g.append("text").attr("x", dash === null ? 14 : 28).attr("y", 4).text(t);
    const w = (dash === null ? 14 : 28) + tx.node().getComputedTextLength();
    if (kx > m.l && kx + w > W - m.r) { kx = m.l; ky += 20; }
    g.attr("transform", `translate(${kx},${ky})`);
    if (dash === "box") g.append("rect").attr("x", 0).attr("y", -6).attr("width", 22).attr("height", 12).attr("fill", c).attr("stroke", "#c5ccd3");
    else if (dash === null) g.append("circle").attr("cx", 6).attr("cy", 0).attr("r", 3.5).attr("fill", c);
    else g.append("line").attr("x1", 0).attr("x2", 22).attr("y1", 0).attr("y2", 0).attr("stroke", c).attr("stroke-width", 2).attr("stroke-dasharray", dash);
    kx += w + 22;
  });
  m.t = ky + 22;
  const x = (logX ? d3.scaleLog() : d3.scaleLinear()).domain(byT ? [0, d3.max(curveRows, xv)] : d3.extent(curveRows, xv)).range([m.l, W - m.r]);
  if (byT) x.nice();
  const ys = ok.map((r) => r.Q / uq), lo = d3.min(ys), hi = d3.max(ys);
  const y = logX ? d3.scaleLog().domain([lo / 1.1, hi * 1.1]).range([H - m.b, m.t])
    : d3.scaleLinear().domain([byT ? 0 : Math.max(0, lo - 0.1 * (hi - lo || lo)), hi + 0.05 * (hi - lo || lo)]).nice().range([H - m.b, m.t]);
  svg.append("g").attr("transform", `translate(0,${H - m.b})`).call(logX ? d3.axisBottom(x).ticks(6, "~g") : d3.axisBottom(x).ticks(10).tickFormat(d3.format("d")));
  svg.append("g").attr("transform", `translate(${m.l},0)`).call(logX ? d3.axisLeft(y).ticks(6, "~g") : d3.axisLeft(y).ticks(8));
  svg.append("g").attr("stroke", "#e5eaef").selectAll("line").data(y.ticks(8)).join("line")
    .attr("x1", m.l).attr("x2", W - m.r).attr("y1", (d) => y(d)).attr("y2", (d) => y(d));
  // shaded: the range where the deadline can't be met
  const edge = byT && state.curveFast ? state.curveFast / 86400 : first;
  if (band) svg.insert("rect", ":first-child").attr("x", m.l).attr("y", m.t).attr("width", x(edge) - m.l).attr("height", H - m.b - m.t).attr("fill", "#eef1f4");
  // the limit the wells set: the fewest wells, or the shortest deadline, they can meet
  const lim = byT ? (state.curveFast ? state.curveFast / 86400 : null) : !byK && miss.length && miss[0].x < ok[0].x ? ok[0].x : null;
  if (lim !== null && lim >= x.domain()[0]) {
    svg.append("line").attr("x1", x(lim)).attr("x2", x(lim)).attr("y1", m.t).attr("y2", H - m.b).attr("stroke", "#8a96a3").attr("stroke-width", 1.5).attr("stroke-dasharray", "4,3");
    svg.append("text").attr("x", x(lim) + 5).attr("y", H - m.b - 8).text(byT ? `Fastest possible: day ${fmtNum(+lim.toPrecision(3))}` : `Fewest wells: ${lim}`);
  }
  if (byT) {
    const vf = Lf() ** 3, vs = ok.map((r) => r.vol / vf).filter((v) => v > 0);
    const yv = d3.scaleLinear().domain([0, d3.max(vs) * 1.05]).nice().range([H - m.b, m.t]);
    svg.append("g").attr("transform", `translate(${W - m.r},0)`).call(d3.axisRight(yv).ticks(6, "~s"));
    svg.append("path").datum(ok.filter((r) => r.vol > 0)).attr("fill", "none").attr("stroke", VOL).attr("stroke-width", 2).attr("stroke-dasharray", "6,4")
      .attr("d", d3.line().x((r) => x(xv(r))).y((r) => yv(r.vol / vf)));
    svg.append("text").attr("class", "axis-title").attr("transform", `translate(${W - 12},${(m.t + H - m.b) / 2}) rotate(90)`).attr("text-anchor", "middle").text(`Water pumped to dewater (${Ln()}³)`);
  }
  svg.append("path").datum(ok).attr("fill", "none").attr("stroke", "#1F4E79").attr("stroke-width", 2.5)
    .attr("d", d3.line().x((r) => x(xv(r))).y((r) => y(r.Q / uq)));
  svg.append("g").selectAll("circle").data(ok).join("circle").attr("cx", (r) => x(xv(r))).attr("cy", (r) => y(r.Q / uq)).attr("r", 3.5)
    .attr("fill", (r) => (r.capped ? CUT : "#1F4E79"))
    .append("title").text((r) => `${byK ? `k = ${fmtNum(xv(r))} ${kUnitLabel()}` : byT ? `Day ${fmtNum(xv(r))}` : `${r.x} wells`}: start at ${fmtNum(r.Q / uq)} ${unit}${r.capped ? ", cut back weekly" : ", constant until dewatered"}; dewatered on day ${dayN(r.tDew)}; ${fmtVol(r.vol)} pumped to dewater`);
  svg.append("text").attr("class", "axis-title").attr("x", (m.l + W - m.r) / 2).attr("y", H - 8).attr("text-anchor", "middle").text(byK ? `Hydraulic conductivity, k (${kUnitLabel()})` : byT ? "Deadline, days to dewater" : "Number of wells, n");
  svg.append("text").attr("class", "axis-title").attr("transform", `translate(16,${(m.t + H - m.b) / 2}) rotate(-90)`).attr("text-anchor", "middle").text(`Starting rate, Q (${unit})`);
}
$("btn-curve-csv").onclick = () => {
  const u = Qn().replace("³", "3").replace("/", "_per_"), ku = K_UNITS[$("in-k-unit").value], kn = kUnitLabel().replace("/", "_per_");
  const vu = `${Ln()}3`;
  const xcol = curveVar === "t" ? (r) => trim(r.x / 86400) : curveVar === "k" ? (r) => trim(r.x / ku) : (r) => r.x;
  if (state.curveDeadline) return download("design_curve.csv", `${curveVar === "t" ? "deadline_days" : curveVar === "k" ? `k_${kn}` : "wells"},start_Q_${u},met,cut_back,dewatered_day,water_pumped_to_dewater_${vu}\n`
    + curveRows.map((r) => `${xcol(r)},${trim(r.Q / Qf())},${r.met},${r.capped},${r.tDew < Infinity ? trim(r.tDew / 86400) : ""},${r.met ? trim(r.vol / Lf() ** 3) : ""}`).join("\n"), "text/csv");
  const csv = curveVar === "t" ? `days,Q_min_${u},feasible\n` + curveRows.map((r) => `${trim(r.x / 86400)},${trim(r.Q / Qf())},${r.feasible}`).join("\n")
    : curveVar === "k"
    ? `k_${kn},R_${Ln()},Q_min_${u},Q_min_R_fixed_${u},feasible\n` + curveRows.map((r) => `${trim(r.x / ku)},${trim(r.R / Lf())},${trim(r.Q / Qf())},${trim(r.Qfixed / Qf())},${r.feasible}`).join("\n")
    : `wells,Q_min_${u},q_per_well_${u},feasible\n` + curveRows.map((r) => `${r.x},${trim(r.Q / Qf())},${trim(r.qEach / Qf())},${r.feasible}`).join("\n");
  download("design_curve.csv", csv, "text/csv");
};

// ------------------------------------------------------------------ exports, save, load
$("btn-export-wells").onclick = () => {
  if (!state.last) return;
  const { wells, qEach, hw } = state.last;
  const L = Lf(), u = Qn().replace("³", "3").replace("/", "_per_");
  const csv = `well,lat,lng,x_${Ln()},y_${Ln()},q_${u},head_at_well_${Ln()}\n` + wells.map((w, i) => {
    const ll = state.wells[i].marker.getLatLng();
    return `${i + 1},${ll.lat.toFixed(7)},${ll.lng.toFixed(7)},${(w.x / L).toFixed(2)},${(w.y / L).toFixed(2)},${trim(qEach / Qf())},${(hw[i] / L).toFixed(3)}`;
  }).join("\n");
  download("wells.csv", csv, "text/csv");
};
$("btn-export-contours").onclick = () => {
  if (!state.last || !state.last.exportLines) return;
  const field = $("in-field").selectedOptions[0].textContent;
  const fc = { type: "FeatureCollection", features: state.last.exportLines.map((l) => ({ type: "Feature", properties: { field, value: l.value }, geometry: { type: "LineString", coordinates: l.coords } })) };
  download("contours.geojson", JSON.stringify(fc), "application/geo+json");
};

const INPUTS = ["in-R-method", "in-curve-var", "in-kmin", "in-kmax", "in-k", "in-k-unit", "in-ewt", "in-ebase", "in-eexc", "in-ereq", "in-R", "in-rw", "in-dwt", "in-dbase", "in-dexc", "in-margin", "in-gelev", "in-Q", "in-Q-unit", "in-offset", "in-nwells", "in-field", "in-interval", "in-nmin", "in-nmax", "in-ramp", "in-woff", "in-wthick", "in-kw", "in-kw-unit", "in-sy", "in-tdays", "in-tmin", "in-tmax"];
function project() {
  const f = excFeature();
  return {
    app: "dewater", version: 1,
    excavation: f ? f.geometry : null,
    wells: state.wells.map((w) => { const ll = w.marker.getLatLng(); return [ll.lat, ll.lng]; }),
    inputs: Object.fromEntries(INPUTS.map((id) => [id, $(id).value])),
    mode: mode(),
    lenUnit: lenUnit(),
    terrain: state.terrain,
    groundContours: $("in-gcont").checked,
    flow: flow(),
    wall: $("in-wall").checked,
    wallSrc: wallSrc(),
    wallRing: state.wall ? (() => { let ll = state.wall.getLatLngs(); while (Array.isArray(ll[0])) ll = ll[0]; return ll.map((q) => [q.lat, q.lng]); })() : null,
    view: { center: map.getCenter(), zoom: map.getZoom() },
    section: state.section ? state.section.map((q) => [q.lat, q.lng]) : null,
  };
}
function restore(pr, fit = true) {
  if (!pr || pr.app !== "dewater") { alertMsg("That isn't a Dewater project file."); return; }
  // units first, without converting: the saved values are in the saved units
  const lu = document.querySelector(`input[name="lenunit"][value="${pr.lenUnit || "m"}"]`);
  if (lu) { lu.checked = true; lastLen = lu.value; setLenLabels(); }
  // projects saved before the unit keys: k and Q units were stored as factors
  const legacy = { "in-k-unit": { "0.01": "cms", "1": "ms", "1.1574074074074074e-5": "mday", "3.5277777777777777e-6": "ftday" }, "in-Q-unit": { "1": "m3s", "0.001": "lps", "6.30902e-5": "gpm" } };
  Object.entries(pr.inputs || {}).forEach(([id, v]) => { if ($(id)) $(id).value = (legacy[id] && legacy[id][v]) || v; });
  ["in-k-unit", "in-Q-unit", "in-kw-unit"].forEach((id) => ($(id).dataset.prev = $(id).value));
  $("in-wall").checked = !!pr.wall;
  const ws = document.querySelector(`input[name="wallsrc"][value="${pr.wallSrc || "offset"}"]`);
  if (ws) ws.checked = true;
  if (state.wall) { map.removeLayer(state.wall); state.wall = null; }
  if (pr.wallRing) setWall(L.polygon(pr.wallRing));
  showWallSrc();
  const fl = document.querySelector(`input[name="flow"][value="${pr.flow || "steady"}"]`);
  if (fl) fl.checked = true;
  showFlow();
  // projects saved with heads above the low-k layer (H and the target head, with a ground height
  // in later versions) open as elevations with the datum at the low-k layer
  let md = pr.mode || "head";
  if (md === "head") {
    const v = pr.inputs || {}, H = v["in-H"], t = v["in-target"];
    $("in-gelev").value = v["in-zg"] ?? H; $("in-ewt").value = H; $("in-ebase").value = 0;
    $("in-eexc").value = v["in-zb"] ?? t; $("in-ereq").value = t;
    md = "elev";
  }
  const r = document.querySelector(`input[name="mode"][value="${md}"]`);
  if (r) { r.checked = true; showMode(); updateDerived(); }
  if (state.excavation) { map.removeLayer(state.excavation); state.excavation = null; }
  clearWells();
  if (pr.excavation) {
    const layer = L.polygon(pr.excavation.coordinates[0].slice(0, -1).map(([lng, lat]) => [lat, lng])).addTo(map);
    setExcavation(layer, fit);
  }
  (pr.wells || []).forEach(([lat, lng]) => addWell(L.latLng(lat, lng), false));
  updateWellsInfo();
  if (!fit && pr.view) map.setView(pr.view.center, pr.view.zoom);
  if (pr.section) setSection(L.latLng(...pr.section[0]), L.latLng(...pr.section[1]));
  syncCurveInputs(); showR(); buildRampPicker();
  $("in-gcont").checked = !!pr.groundContours; drawGround();
  if (pr.terrain) { state.terrain = true; $("in-terrain").checked = true; $("in-gelev").readOnly = true; schedule(); }
  schedule();
}
$("btn-save").onclick = () => download("dewater_project.json", JSON.stringify(project(), null, 1), "application/json");
$("file-project").onchange = (e) => readFile(e.target.files[0], (t) => restore(JSON.parse(t)));

// the last session comes back on reload (this browser only)
function persist() { try { localStorage.setItem("dewater:last", JSON.stringify(project())); } catch (e) { /* storage unavailable */ } }

// ------------------------------------------------------------------ search
$("search").onsubmit = async (e) => {
  e.preventDefault();
  const q = $("search-q").value.trim();
  if (!q) return;
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`, { headers: { Accept: "application/json" } });
    const [hit] = await r.json();
    if (!hit) return tip("No place found.", 2500);
    const [s, n, w, ea] = hit.boundingbox.map(Number);
    map.fitBounds([[s, w], [n, ea]], { maxZoom: 18 });
  } catch (err) { tip("Search is unavailable right now.", 2500); }
};

// ------------------------------------------------------------------ small helpers
function setStatus(kind, text) { const el = $("status"); el.className = `status ${kind}`; el.textContent = text; if (kind !== "ok" && kind !== "warn" && kind !== "bad") $("results").innerHTML = ""; }
let tipTimer = null;
function tip(text, ms) {
  clearTimeout(tipTimer);
  $("maptip").hidden = !text;
  if (text) $("maptip").textContent = text;
  if (text && ms) tipTimer = setTimeout(() => ($("maptip").hidden = true), ms);
}
function alertMsg(t) { tip(t, 3500); }
function fmt(v, d) {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) < 0.5 * 10 ** -d) v = 0;           // no "-0.00"
  return v.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d });
}
const dayN = (t) => fmtNum(+(t / 86400).toPrecision(t < 10 * 86400 ? 2 : 3));
function fmtDays(t) { const d = t / 86400; return `${fmt(d, d < 10 ? 1 : 0)} day${fmt(d, d < 10 ? 1 : 0) === "1" ? "" : "s"}`; }
function fmtNum(v) { return Number.isFinite(v) ? +v.toPrecision(4) : "—"; }
function fmtQ(q) { return `${fmtNum(q / Qf())} ${Qn()}`; }
// A chart's SVG as a PNG at twice its size, on white, with the page's chart fonts.
function svgToPng(svg, name, title) {
  const w = +svg.getAttribute("width"), h = +svg.getAttribute("height"), pad = title ? 28 : 0, sc = 2;
  const clone = svg.cloneNode(true);
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
  style.textContent = "text{font-family:system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;font-size:12px;fill:#5b6875}.axis-title{font-size:12.5px;fill:#1d2733}";
  clone.insertBefore(style, clone.firstChild);
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" }));
  const img = new Image();
  img.onload = () => {
    const c = document.createElement("canvas");
    c.width = w * sc; c.height = (h + pad) * sc;
    const ctx = c.getContext("2d");
    ctx.scale(sc, sc);
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h + pad);
    if (title) { ctx.fillStyle = "#143A5C"; ctx.font = "600 14px system-ui, sans-serif"; ctx.fillText(title, 12, 19); }
    ctx.drawImage(img, 0, pad, w, h);
    URL.revokeObjectURL(url);
    c.toBlob((b) => { const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); });
  };
  img.src = url;
}
$("btn-curve-png").onclick = () => { const sv = $("curve-chart").querySelector("svg"); if (sv) svgToPng(sv, "design_curve.png", $("curve-title").textContent.replace("Design curve: ", "")); };
$("btn-sec-png").onclick = () => { const sv = $("section-chart").querySelector("svg"); if (sv) svgToPng(sv, "cross_section.png", $("section-title").textContent); };
$("btn-sec-csv").onclick = () => {
  const c = state.secData;
  if (!c) return;
  const L = Lf(), u = Ln();
  const rows = c.prof.map((q) => [ (q.d / L).toFixed(2), (q.h / L).toFixed(3), c.st ? ((c.st.dbase - q.h) / L).toFixed(3) : "", c.st && Number.isFinite(c.st.gelev) ? ((c.st.gelev - c.st.dbase + q.h) / L).toFixed(3) : "", q.inExc ? 1 : 0 ].join(","));
  download("cross_section.csv", `distance_${u},head_${u},depth_to_water_${u},water_elevation_${u},in_excavation\n` + rows.join("\n"), "text/csv");
};

function download(name, text, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function readFile(file, cb) { if (!file) return; const r = new FileReader(); r.onload = () => { try { cb(r.result); } catch (e) { alertMsg("Couldn't read that file."); } }; r.readAsText(file); }

document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => b.closest("dialog").close()));
$("btn-help").onclick = () => $("dlg-help").showModal();
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { setAddMode(false); state.secDrawing = false; map.pm.disableDraw(); tip(null); } });

// ------------------------------------------------------------------ start
try {
  const saved = JSON.parse(localStorage.getItem("dewater:last") || "null");
  if (saved && (saved.excavation || (saved.wells || []).length)) restore(saved, false);
} catch (e) { /* first visit, or storage unavailable */ }
showFlow();
updateExcInfo();
updateWellsInfo();
updateDerived();
syncCurveInputs();
