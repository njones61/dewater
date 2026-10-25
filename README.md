# Dewater

Design a dewatering well system for an excavation in an unconfined aquifer, in the browser.

**Use it:** https://jonesgeo.com/dewater/

1. Find the site and draw the excavation outline on the map, drag a rectangle (and rotate it to
   match the site), or load a GeoJSON polygon.
2. Enter the site as depths below ground (water table, bottom of the aquifer, excavation, and the
   extra depth the water must reach below its bottom), or as elevations; then k, and transient
   flow (the specific yield and the days to dewater) or steady flow (R).
3. Click to place wells, or generate a ring of wells at an offset from the edge. Optionally,
   enclose the site with a slurry cutoff wall keyed into the low-k layer.
4. Enter a total pumping rate and check the contours, or find the minimum design pumping rate,
   Q_min: the smallest total rate that dewaters the excavation.
5. Check cross sections of the water level: east–west, north–south, or along any line you draw.
6. Compute the design curves: Q_min against the number of wells, to choose how many wells to
   use; against k; or against the days to dewater.

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
the wall: the aquifer outside (the enclosure as one large well) and the wall (the trench equation
across its thickness) act as two resistances in series, both linear in h², so the leakage is
closed form. The water inside is taken as level. Q_min is then the smallest rate that draws the
stored water down to the required level within the days allowed, with the leakage coming in (also
closed form), and then holds it. See *How it works* in the app.

Transient flow replaces R with the specific yield S_y and the time pumping t: each well follows
the Theis solution in the same h² form, H² − h² = (q / 2πk) W(u) with u = r² S_y / (4kHt), which
at late time is the steady equation with R = 1.5√(kHt/S_y). It is still linear in q, so the constant
rate that dewaters the excavation by day t is exact. A time bar under the map plays the contours and the section
through time, on one scale. The pumping follows one schedule, adjusted weekly (rate changes add
in time, as in a recovery test): Q until the excavation is dewatered, cut back only where a well
would otherwise go dry, then stepped down to the lowest rate that holds the water at the required
level for the next four weeks. *Find Q_min* gives the smallest starting rate that meets the
deadline, or, when the wells can't, the fastest they can do; *Pumping schedule* plots the rates
and gives the water pumped. Transient is the default: the deadline sets the rate.

This is a screening tool for teaching and preliminary design.

## Development

A static site: `index.html`, `css/`, and `js/`, with Leaflet, Leaflet-Geoman, Turf, and d3 from a
CDN. No build step. Serve the folder (`python3 -m http.server`) and open it. The calculation is in
`js/model.js`, with tests:

    node --test test/model.test.mjs

Written for CE 544 Seepage and Slope Stability at Brigham Young University. It replaces the course's
Colab notebook for the construction dewatering exercise.
