# Dewater

Design a dewatering well system for an excavation in an unconfined aquifer, in the browser.

**Use it:** https://jonesgeo.com/dewater/

1. Find the site and draw the excavation outline on the map, drag a rectangle (and rotate it to
   match the site), or load a GeoJSON polygon.
2. Enter the site as depths below ground (water table, bottom of the aquifer, excavation, and the
   extra depth the water must reach below its bottom), or as H and the target head; then k and R.
3. Click to place wells, or generate a ring of wells at an offset from the edge.
4. Enter a total pumping rate and check the contours, or find the least rate that dewaters the
   excavation.
5. Check cross sections of the water level: east–west, north–south, or along any line you draw.
6. Compute the design curve, the least total rate against the number of wells, to choose how many
   wells to use.

The ground elevation can be read from open terrain data (AWS Terrain Tiles; USGS 3DEP in the
US), averaged over the excavation, and the cross section then shows the actual ground profile.
The calculation still treats the ground and the initial water table as level.

Projects save to a small JSON file (the outline, the wells, and the inputs) and open again later.
Wells export as CSV, contours as GeoJSON.

## The calculation

Steady flow to fully penetrating wells in an unconfined aquifer on an impermeable base, with the
Dupuit assumptions. The wells add in H² − h²:

    h = √( H² − Σ (qᵢ / πk) ln(R / rᵢ) )

With the total rate Q shared equally by n wells, the least Q that brings every point in the
excavation down to the target head is exact: Q = n (H² − h_target²) / min A, where
A = Σ ln(R/rᵢ)/(πk) at each checked point. Points are checked on a grid over the excavation and
along its edge. A design fails if that rate would pump a well dry. See *How it works* in the app.

This is a screening tool for teaching and preliminary design.

## Development

A static site: `index.html`, `css/`, and `js/`, with Leaflet, Leaflet-Geoman, Turf, and d3 from a
CDN. No build step. Serve the folder (`python3 -m http.server`) and open it. The calculation is in
`js/model.js`, with tests:

    node --test test/model.test.mjs

Written for CE 544 Seepage and Slope Stability at Brigham Young University. It replaces the course's
Colab notebook for the construction dewatering exercise.
