# Dewater

Design a dewatering well system for an excavation in an unconfined aquifer, in the browser.

**Use it:** https://jonesgeo.com/dewater/

1. Find the site and draw the excavation outline on the map, drag a rectangle (and rotate it to
   match the site), or load a GeoJSON polygon.
2. Enter the site as depths below ground (water table, bottom of the aquifer, excavation, and the
   extra depth the water must reach below its bottom), or as elevations; then k, and transient
   flow (the specific yield and the days to dewater) or steady flow (R).
3. Click to place wells, or generate a ring of wells at an offset from the edge.
4. Optionally, enclose the site with a cutoff wall (a slurry trench) keyed into the low-k layer.
5. Enter a total pumping rate and check the contours, or find the minimum design pumping rate,
   Q_min: the smallest total rate that dewaters the excavation.
6. Check cross sections of the water level: east–west, north–south, or along any line you draw.
7. Compute the design curves: Q_min against the number of wells, to choose how many wells to
   use; against k; or against the days to dewater. In transient flow each point is the design
   for the deadline (Q_min at the start, cut back where needed), and the curves mark the fewest
   wells and the shortest deadline the wells can meet.

The ground elevation can be read from open terrain data (AWS Terrain Tiles; USGS 3DEP in the
US), averaged over the excavation, and the cross section then shows the actual ground profile.
The calculation still treats the ground and the initial water table as level.

Lengths are in meters or feet; k and Q each have their own unit list, and every flow rate shown
uses Q's unit. Changing a unit converts the values already entered.

Projects save to a small JSON file (the outline, the wells, and the inputs) and open again later.
Wells export as CSV, contours as GeoJSON.

## The calculation

Steady flow to fully penetrating wells in an unconfined aquifer on an impermeable base, with the
Dupuit assumptions. The wells add in H² − h²:

    h = √( H² − Σ (qᵢ / πk) ln(R / rᵢ) )

With the total rate Q shared equally by n wells, the minimum design pumping rate that brings every point in the
excavation down to the target head is exact: Q_min = n (H² − h_target²) / min A, where
A = Σ ln(R/rᵢ)/(πk) at each checked point. Points are checked on a grid over the excavation and
along its edge. A design fails if that rate would pump a well dry.

With a cutoff wall keyed into an impermeable low-k layer, water reaches the inside only through
the wall, and the aquifer is no longer uniform. The wells' influence then comes from a
finite-difference model in the same h² form, (S_y/H) ∂u/∂t = ∇·(k∇u) + 2q, u = H² − h²: a grid fine
over the wall and the wells, growing outward to a fixed head, with the wall as a barrier on the
cell faces it crosses (its thickness at k_w, the trench equation across it). Each well sits at a
cell center, and the head at its screen adds its own cone below the cell's size, so wells can go
dry inside the wall too. The equation is linear in the rates, so the response is worked out once
per layout and any pumping schedule superposes it, as with Theis; the schedule, Find Q_min, and the
design curves are the same. With no wall the grid reproduces Theis to within a percent or two.
Placed around the site, the wall is a rectangle set out by a setback from the excavation and the wells.
See *How it works* in the app.

Transient flow replaces R with the specific yield S_y and the time pumping t: each well follows
the Theis solution in the same h² form, H² − h² = (q / 2πk) W(u) with u = r² S_y / (4kHt), which
at late time is the steady equation with R = 1.5√(kHt/S_y). It is still linear in q, so the constant
rate that dewaters the excavation by day t is exact. A time bar under the map plays the contours and the section
through time, on one scale. The pumping follows one schedule, adjusted weekly (rate changes add
in time, as in a recovery test): Q until the excavation is dewatered, cut back only where a well
would otherwise go dry, then stepped down to the lowest rate that holds the water at the required
level for the next four weeks. *Find Q_min* gives the smallest pumping rate at the start that meets the
deadline, or, when the wells can't, the fastest they can do; *Pumping schedule* plots the rates
and gives the water pumped. Transient is the default: the deadline sets the rate.

The design takes the water table to drain as soon as the heads fall. In layered soil (kh several
times kv) it drains late, catching up in about 4 Sy H / kv (Neuman's delayed yield). Given the
anisotropy kh/kv, the app reports that time. A sweep of 108 radius-and-depth models of a ring of
wells (thickness 10 to 60 m, kh 1e-6 to 1e-4 m/s, Sy 0.1 and 0.25, kh/kv 1 and 10, rings of 25 to
200 m) put the extra pumping on one curve against the deadline over that time; the app takes its
worst case as a margin (about 9% at 1/2, 14% at 1/3, 40% at 0.1), warns when it reaches 10%, and
gives a suggested pump capacity, Q_min plus the margin. It does not change the design.

This is a screening tool for teaching and preliminary design.

## Development

A static site: `index.html`, `css/`, and `js/`, with Leaflet, Leaflet-Geoman, Turf, and d3 from a
CDN. No build step. Serve the folder (`python3 -m http.server`) and open it. The calculation is in
`js/model.js`, with tests:

    node --test test/model.test.mjs

Written for CE 544 Seepage and Slope Stability at Brigham Young University. It replaces the course's
Colab notebook for the construction dewatering exercise.
