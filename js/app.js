// app.js — the map, the panel, and the drawing of results. The calculation is in model.js.
import { heads, optimalRate, grid, inside, densify } from "./model.js";
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
const LEN_INPUTS = ["in-dwt", "in-dbase", "in-dexc", "in-margin", "in-gelev", "in-ewt", "in-ebase", "in-eexc", "in-ereq", "in-R", "in-rw", "in-offset", "in-interval"];
const trim = (v) => String(+v.toPrecision(6));

function setLenLabels() { document.querySelectorAll(".uL").forEach((e) => (e.textContent = Ln())); }
// Switching a unit converts the values already entered, so the design itself doesn't change.
let lastLen = "m";
document.querySelectorAll('input[name="lenunit"]').forEach((r) => r.addEventListener("change", () => {
  const f = LEN[lastLen] / Lf();
  LEN_INPUTS.forEach((id) => { const v = parseFloat($(id).value); if (Number.isFinite(v)) $(id).value = trim(v * f); });
  lastLen = lenUnit();
  setLenLabels(); updateDerived(); updateExcInfo(); schedule();
}));
for (const [id, units] of [["in-k", K_UNITS], ["in-Q", Q_UNITS]]) {
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
  if (p.Rmethod !== "entered") p.R = radius(p, p.k);
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
  const s = p.H - p.target;
  if (p.Rmethod === "sichardt") return rEquiv() + 3000 * s * Math.sqrt(k);
  if (p.Rmethod === "kusakin") return rEquiv() + 575 * s * Math.sqrt(p.H * k);
  return p.R;
}
// The least rate, with R for the given k.
function optimalWithR(cp, wells, p, k = p.k) {
  const R = radius(p, k);
  return { ...optimalRate(cp, wells, { ...p, k, R }, p.target), R };
}
function showR() {
  const p = params(), auto = p.Rmethod !== "entered";
  $("in-R").readOnly = auto;
  $("R-note").hidden = !auto;
  if (auto && Number.isFinite(p.R)) $("in-R").value = trim(p.R / Lf());
}
$("in-R-method").addEventListener("change", () => { showR(); schedule(); });

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
  if (!(p.R > 0)) return "Enter a radius of influence R greater than zero.";
  if (!(p.rw > 0) || p.rw >= p.R) return "The well radius must be greater than zero and less than R.";
  if (!(p.target >= 0) || p.target >= p.H) return "The target head must be at least zero and less than H.";
  if (!(p.Q >= 0)) return "Enter a pumping rate of zero or more.";
  return null;
}

// ------------------------------------------------------------------ excavation
const EXC_STYLE = { color: "#E8582C", weight: 3, fillColor: "#E8582C", fillOpacity: 0.08 };

function setExcavation(layer, fit = true) {
  if (state.excavation && state.excavation !== layer) map.removeLayer(state.excavation);
  state.excavation = layer;
  layer.setStyle(EXC_STYLE);
  layer.on("pm:edit pm:dragend pm:rotateend", () => { updateExcInfo(); refreshTerrain(); schedule(); });
  layer.on("pm:remove", () => { state.excavation = null; updateExcInfo(); schedule(); });
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
function loadGeoJSON(gj) {
  const feats = gj.type === "FeatureCollection" ? gj.features : gj.type === "Feature" ? [gj] : [{ type: "Feature", geometry: gj }];
  const poly = feats.find((f) => f.geometry && /Polygon/.test(f.geometry.type));
  if (!poly) { alertMsg("That file has no polygon in it."); return; }
  let coords = poly.geometry.type === "MultiPolygon" ? poly.geometry.coordinates[0][0] : poly.geometry.coordinates[0];
  const layer = L.polygon(coords.slice(0, -1).map(([lng, lat]) => [lat, lng]));
  layer.addTo(map);
  setExcavation(layer);
}

$("btn-draw").onclick = () => {
  setAddMode(false);
  map.pm.enableDraw("Polygon", { templineStyle: EXC_STYLE, hintlineStyle: { color: "#E8582C", dashArray: "5,5" }, pathOptions: EXC_STYLE });
  tip("Click the corners of the excavation. Click the first corner to finish.");
};
$("btn-delete-exc").onclick = () => {
  if (!state.excavation) return;
  if (state.excavation.pm.enabled()) state.excavation.pm.disable();
  map.removeLayer(state.excavation);
  state.excavation = null;
  $("btn-edit").textContent = "Edit"; $("btn-rotate").textContent = "Rotate"; tip(null);
  updateExcInfo();
  schedule();
};
$("btn-rect").onclick = () => {
  setAddMode(false);
  map.pm.enableDraw("Rectangle", { pathOptions: EXC_STYLE });
  tip("Drag a box for the excavation. Use Rotate to turn it to match the site.");
};
$("btn-rotate").onclick = () => {
  if (!state.excavation) return;
  const on = state.excavation.pm.rotateEnabled && state.excavation.pm.rotateEnabled();
  if (on) { state.excavation.pm.disableRotate(); $("btn-rotate").textContent = "Rotate"; tip(null); }
  else { state.excavation.pm.enableRotate(); $("btn-rotate").textContent = "Done rotating"; tip("Drag a corner to rotate the excavation."); }
};
map.on("pm:create", (e) => {
  tip(null);
  if (e.shape === "Polygon" || e.shape === "Rectangle") setExcavation(e.layer, false);
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
  const p = params(), err = checkParams(p);
  const ringLL = excRing();
  if (err) return setStatus("bad", err);
  if (!ringLL && !state.wells.length) return setStatus("idle", "Draw an excavation and add wells.");
  if (!state.origin) setOrigin((ringLL ? state.excavation.getBounds() : L.latLngBounds(state.wells.map((w) => w.marker.getLatLng()))).getCenter());
  const ring = ringLL ? ringLL.map(toXY) : null;
  const wells = state.wells.map((w) => toXY(w.marker.getLatLng()));
  if (!wells.length) return setStatus("idle", "Add wells: click on the map, or generate a ring.");
  const n = wells.length, qEach = p.Q / n;
  const W = wells.map((w) => ({ ...w, q: qEach }));

  // the results grid
  const box = analysisBox([...(ring || []), ...wells]);
  const nx = 220, ny = Math.round(nx * (box[3] - box[2]) / (box[1] - box[0]));
  const G = grid(box, nx, ny);
  const { h } = heads(G, W, p);

  // the excavation: the highest head inside it
  let hmax = null, at = null;
  if (ring) {
    const cp = checkPoints(ring);
    const hc = heads(cp, W, p).h;
    hmax = -Infinity;
    hc.forEach((v, i) => { if (v > hmax) { hmax = v; at = cp[i]; } });
  }
  // the wells: the head at each well's radius
  const hw = heads(wells.map((w) => ({ x: w.x + p.rw, y: w.y })), W, p).h;
  const dryWells = [];
  hw.forEach((v, i) => { state.wells[i].marker.setIcon(wellIcon(v <= 0)); if (v <= 0) dryWells.push(i); });

  state.last = { p, box, nx, ny, h, ring, wells, hmax, at, hw, qEach };
  drawResults();
  drawSection();

  // status and numbers
  const rows = [
    ["Wells", n],
    ["Rate per well", fmtQ(qEach)],
    ["Total rate, Q", fmtQ(p.Q)],
  ];
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
  if (p.Rmethod !== "entered") {
    rows.push(["Equivalent radius, √(A/π)", fmtL(rEquiv(), 1)]);
    rows.push(["R from the formula", fmtL(p.R, 0)]);
  }
  rows.push(st && st.elev ? ["Lowest water, at a well, elevation", E(Math.min(...hw))] : st ? ["Deepest water, at a well", `${fmtL(st.dbase - Math.min(...hw), 2)} below ground`] : ["Lowest head at a well", fmtL(Math.min(...hw), 2)]);
  $("results").innerHTML = rows.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join("");
  if (dryWells.length) {
    setStatus("bad", `${dryWells.length} well${dryWells.length > 1 ? "s" : ""} pumped dry (shown red): the rate is more than the aquifer can deliver there. Add wells or lower Q.`);
  } else if (!ring) {
    setStatus("idle", "Draw or load the excavation to check the design.");
  } else if (state.optQ && Math.abs(p.Q - state.optQ) <= 1e-5 * state.optQ && Math.abs(hmax - p.target) < 1e-3) {
    // still the least rate found (in whatever units it is now shown)
    setStatus("ok", `Least Q: ${fmtQ(state.optQ)}. The highest water in the excavation is exactly at the required level.${state.optNote || ""}`);
  } else if (hmax <= p.target) {
    setStatus("ok", st ? `Dewatered: the water is at least ${fmtL(st.dbase - hmax - st.dexc, 2)} below the excavation bottom everywhere inside it.`
      : `Dewatered: the water is at or below the target head everywhere in the excavation.`);
  } else {
    setStatus("warn", `Not dewatered: the water is ${fmtL(hmax - p.target, 2)} above the required level at the marked point.`);
  }
}

// ------------------------------------------------------------------ drawing
function clearResults() {
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
  const lo = d3.min(v), hi = d3.max(v);
  if (!(hi > lo)) return;
  // the required level always gets its own contour
  const levels = [...new Set([...niceLevels(lo, hi), ...(tgt > lo && tgt < hi ? [tgt] : [])])].sort((a, b) => a - b);
  // low head (deep drawdown) dark
  // drier (deeper water) at the dark end of the ramp; Reverse flips it
  const ramp = d3[`interpolate${$("in-ramp").value}`] || d3.interpolateYlGnBu;
  const flip = $("in-ramp-rev").checked !== ["Spectral", "RdYlBu"].includes($("in-ramp").value);
  const color = d3.scaleSequential(ramp).domain((drier !== flip) ? [lo, hi] : [hi, lo]);
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
          L.polyline(ll, { pane: "results", color: major ? "#E8582C" : "#1d2733", weight: major ? 2.5 : 1, opacity: 0.85, interactive: false }).addTo(lines);
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
  const stops = d3.range(0, 1.0001, 0.1).map((t) => color(drier ? lo + t * (hi - lo) : hi - t * (hi - lo)));
  $("legend").innerHTML = `<h4>${title}</h4><div class="bar" style="background:linear-gradient(to right, ${stops.join(",")})"></div>`
    + `<div class="ticks"><span>${fmt(drier ? lo : hi, 1)}</span><span>${fmt(drier ? hi : lo, 1)}</span></div>`
    + `<div class="key"><span class="sw" style="background:#E8582C;height:3px"></span>Required level</div>`
    + ($("in-dewatered").checked ? `<div class="key"><span class="sw" style="background:rgba(47,168,102,.35);border:1px dashed #1e7a46"></span>Below the required level</div>` : "");
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
["in-k", "in-k-unit", "in-ewt", "in-ebase", "in-eexc", "in-ereq", "in-R", "in-rw", "in-Q", "in-Q-unit", "in-dwt", "in-dbase", "in-dexc", "in-margin", "in-gelev"]
  .forEach((id) => $(id).addEventListener("input", () => { updateDerived(); schedule(250); }));

// ------------------------------------------------------------------ terrain
// The ground elevation from open terrain tiles: the average over the excavation (points on a
// grid inside it), or around the wells if there is no excavation yet.
// "Use terrain" on: the ground elevation comes from the terrain (read-only), and the cross section
// draws the actual ground. Off: the ground elevation is typed in (or left blank), and the
// section shows level ground. The calculation treats the ground as level either way.
state.terrain = false;
async function readTerrain() {
  const ring = excRing();
  const pts = ring || state.wells.map((w) => w.marker.getLatLng());
  if (!pts.length) { alertMsg("Draw the excavation first."); return false; }
  if (!state.origin) setOrigin(L.latLngBounds(pts).getCenter());
  let sample;
  if (ring) {
    const r = ring.map(toXY), xs = r.map((q) => q.x), ys = r.map((q) => q.y);
    sample = grid([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)], 15, 15).filter((q) => inside(q, r)).map(toLL);
    if (!sample.length) sample = ring;
  } else sample = pts;
  try {
    const z = await elevations(sample);
    const mean = z.reduce((a, b) => a + b, 0) / z.length, lo = Math.min(...z), hi = Math.max(...z);
    $("in-gelev").value = (mean / Lf()).toFixed(1);
    tip(`Ground over the excavation: ${fmt(lo / Lf(), 1)} to ${fmtL(hi, 1)}, average ${fmtL(mean, 1)}.`, 5000);
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
function refreshTerrain() { if (state.terrain) readTerrain().then(() => { updateDerived(); schedule(); }); }

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
  persist();
}
function hideSection() {
  state.section = null;
  secLayer.clearLayers();
  $("section-panel").hidden = true;
  $("divider").hidden = true;
  map.invalidateSize();
  $("btn-sec-close").hidden = true;
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
  const [a, b] = dir === "ew" ? [{ x: c.x - half, y: c.y }, { x: c.x + half, y: c.y }] : [{ x: c.x, y: c.y + half }, { x: c.x, y: c.y - half }];
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

  const { p, wells, qEach, ring } = state.last;
  const W = wells.map((w) => ({ ...w, q: qEach }));
  const N = 400, ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
  const pts = d3.range(N + 1).map((i) => ({ x: a.x + ux * len * i / N, y: a.y + uy * len * i / N }));
  const { h } = heads(pts, W, p);
  const prof = pts.map((q, i) => ({ d: len * i / N, h: h[i], inExc: ring ? inside(q, ring) : false }));
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
  near.forEach((w) => {
    const wt = terr ? tz(w.d) : st ? st.dbase : zTop;          // the casing reaches the ground
    svg.append("rect").attr("x", x(w.d) - 3).attr("width", 6).attr("y", y(wt)).attr("height", y(0) - y(wt))
      .attr("fill", "#fff").attr("stroke", "#1F4E79").attr("stroke-width", 1.5);
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
    svg.append("circle").attr("cx", x(top.d)).attr("cy", y(top.h)).attr("r", 4.5).attr("fill", top.h > p.target ? "#b3261e" : "#1e7a46");
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

// ------------------------------------------------------------------ least Q
$("btn-optimize").onclick = () => {
  const p = params(), err = checkParams({ ...p, Q: 0 });
  if (err) return setStatus("bad", err);
  const ring = excRing();
  if (!ring || !state.wells.length) return setStatus("idle", "The least Q needs an excavation and wells.");
  const r = ring.map(toXY), wells = state.wells.map((w) => toXY(w.marker.getLatLng()));
  const opt = optimalWithR(checkPoints(r), wells, p);
  if (!opt || !isFinite(opt.Q)) return setStatus("bad", "No pumping rate works with these wells.");
  state.optNote = "";
  // rounded up at six figures, so the entered rate still meets the target
  const qv = opt.Q / Qf(), mag = 10 ** (Math.floor(Math.log10(qv)) - 5);
  $("in-Q").value = trim(Math.ceil(qv / mag) * mag);
  state.optQ = opt.feasible ? opt.Q : null;
  run();
  if (!opt.feasible) setStatus("bad", "The least rate that dewaters the excavation would pump a well dry. Add wells, or move them farther out.");
};

// ------------------------------------------------------------------ design curves
// Least total Q against the number of wells (rings at the offset), or against k for the wells on
// the map. With R entered, Q is exactly proportional to k; with R from Sichardt or Kusakin, R
// grows with √k and Q grows more slowly. The k curve shows both, so the role of R is plain.
let curveRows = [], curveVar = "n";
const kUnitLabel = () => $("in-k-unit").selectedOptions[0].textContent;
function syncCurveInputs() {
  const v = $("in-curve-var").value;
  $("curve-n").hidden = v !== "n"; $("curve-k").hidden = v !== "k";
  document.querySelectorAll(".uK").forEach((e) => (e.textContent = kUnitLabel()));
  $("curve-hint").textContent = v === "n" ? "Past some n, more wells barely lower Q."
    : "For the wells on the map. With R entered, Q is simply proportional to k; choose Sichardt or Kusakin for R to see how R's growth with k changes that.";
}
$("in-curve-var").addEventListener("change", syncCurveInputs);
$("btn-curve").onclick = () => {
  const p = params(), err = checkParams({ ...p, Q: 0 });
  if (err) return setStatus("bad", err);
  if (!state.excavation) return setStatus("idle", "The design curve needs an excavation.");
  const cp = checkPoints(excRing().map(toXY));
  curveVar = $("in-curve-var").value;
  curveRows = [];
  if (curveVar === "n") {
    const n0 = Math.max(1, Math.round(num("in-nmin"))), n1 = Math.round(num("in-nmax")), off = numL("in-offset");
    if (!(n1 > n0)) return alertMsg("Enter a range of numbers of wells, smallest first.");
    for (let n = n0; n <= Math.min(n1, n0 + 300); n++) {
      const wells = ringWells(n, off).map(toXY);
      const o = optimalWithR(cp, wells, p);
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
      const o = optimalWithR(cp, wells, p, k);
      if (!(o.R > p.rw)) continue;
      const of = optimalRate(cp, wells, { ...p, k, R: Rfix }, p.target);
      curveRows.push({ x: k, R: o.R, Q: o.Q, qEach: o.qEach, feasible: o.feasible, Qfixed: of.Q });
    }
  }
  drawCurve();
  $("dlg-curve").showModal();
};
function drawCurve() {
  const uq = Qf(), unit = Qn(), byK = curveVar === "k", ku = K_UNITS[$("in-k-unit").value];
  const auto = byK && params().Rmethod !== "entered";
  const el = $("curve-chart");
  el.innerHTML = "";
  const W = Math.min(720, window.innerWidth * 0.9), H = 360, m = { l: 70, r: 20, t: 14, b: 46 };
  const ok = curveRows.filter((r) => isFinite(r.Q));
  const xv = (r) => (byK ? r.x / ku : r.x);
  const x = (byK ? d3.scaleLog() : d3.scaleLinear()).domain(d3.extent(ok, xv)).range([m.l, W - m.r]);
  const ys = ok.flatMap((r) => (auto ? [r.Q, r.Qfixed] : [r.Q]).map((q) => q / uq));
  const lo = d3.min(ys), hi = d3.max(ys);
  const y = byK ? d3.scaleLog().domain([lo / 1.1, hi * 1.1]).range([H - m.b, m.t])
    : d3.scaleLinear().domain([Math.max(0, lo - 0.1 * (hi - lo || lo)), hi + 0.05 * (hi - lo || lo)]).nice().range([H - m.b, m.t]);
  const svg = d3.select(el).append("svg").attr("class", "chart").attr("width", W).attr("height", H);
  svg.append("g").attr("transform", `translate(0,${H - m.b})`).call(byK ? d3.axisBottom(x).ticks(6, "~g") : d3.axisBottom(x).ticks(10).tickFormat(d3.format("d")));
  svg.append("g").attr("transform", `translate(${m.l},0)`).call(byK ? d3.axisLeft(y).ticks(6, "~g") : d3.axisLeft(y).ticks(8));
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
    .append("title").text((r) => `${byK ? `k = ${fmtNum(xv(r))} ${kUnitLabel()}, R = ${fmtL(r.R, 0)}` : `${r.x} wells`}: Q = ${fmtNum(r.Q / uq)} ${unit}${r.feasible ? "" : " (a well runs dry)"}`);
  if (auto) {
    const lg = svg.append("g").attr("transform", `translate(${m.l + 12},${m.t + 8})`);
    [["#1F4E79", "", `R from ${params().Rmethod === "sichardt" ? "Sichardt" : "Kusakin"} (grows with √k)`], ["#8a96a3", "6,4", `R fixed at ${fmtL(state.curveRfix, 0)}`]].forEach(([c, dash, t], i) => {
      lg.append("line").attr("x1", 0).attr("x2", 26).attr("y1", i * 18).attr("y2", i * 18).attr("stroke", c).attr("stroke-width", 2.5).attr("stroke-dasharray", dash);
      lg.append("text").attr("x", 32).attr("y", i * 18 + 4).text(t);
    });
  }
  svg.append("text").attr("class", "axis-title").attr("x", (m.l + W - m.r) / 2).attr("y", H - 8).attr("text-anchor", "middle").text(byK ? `Hydraulic conductivity, k (${kUnitLabel()})` : "Number of wells, n");
  svg.append("text").attr("class", "axis-title").attr("transform", `translate(16,${(m.t + H - m.b) / 2}) rotate(-90)`).attr("text-anchor", "middle").text(`Least total Q (${unit})`);
  $("curve-title").textContent = `Design curve: least total Q against ${byK ? "hydraulic conductivity" : "number of wells"}`;
  const bad = curveRows.filter((r) => !r.feasible).map((r) => (byK ? fmtNum(xv(r)) : r.x));
  $("curve-note").textContent = (byK ? `The ${state.wells.length} wells on the map, equal rates.${auto ? "" : " R is entered, so Q is proportional to k."}` : `Rings at ${$("in-offset").value} ${Ln()} from the edge, equal rates.`)
    + (bad.length ? ` Red points: the least rate would pump a well dry (${byK ? `${bad.length} of ${curveRows.length} values of k, from ${bad[0]} to ${bad[bad.length - 1]} ${kUnitLabel()}` : `n = ${bad.join(", ")}`}).` : "");
}
$("btn-curve-csv").onclick = () => {
  const u = Qn().replace("³", "3").replace("/", "_per_"), ku = K_UNITS[$("in-k-unit").value], kn = kUnitLabel().replace("/", "_per_");
  const csv = curveVar === "k"
    ? `k_${kn},R_${Ln()},total_Q_${u},total_Q_R_fixed_${u},feasible\n` + curveRows.map((r) => `${trim(r.x / ku)},${trim(r.R / Lf())},${trim(r.Q / Qf())},${trim(r.Qfixed / Qf())},${r.feasible}`).join("\n")
    : `wells,total_Q_${u},q_per_well_${u},feasible\n` + curveRows.map((r) => `${r.x},${trim(r.Q / Qf())},${trim(r.qEach / Qf())},${r.feasible}`).join("\n");
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

const INPUTS = ["in-R-method", "in-curve-var", "in-kmin", "in-kmax", "in-k", "in-k-unit", "in-ewt", "in-ebase", "in-eexc", "in-ereq", "in-R", "in-rw", "in-dwt", "in-dbase", "in-dexc", "in-margin", "in-gelev", "in-Q", "in-Q-unit", "in-offset", "in-nwells", "in-field", "in-interval", "in-nmin", "in-nmax", "in-ramp"];
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
  ["in-k-unit", "in-Q-unit"].forEach((id) => ($(id).dataset.prev = $(id).value));
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
updateExcInfo();
updateWellsInfo();
updateDerived();
syncCurveInputs();
