// terrain.js — ground elevations from the open Terrarium terrain tiles (AWS Open Data, built
// from USGS 3DEP/NED in the US and SRTM and other sources elsewhere). Each PNG pixel encodes an
// elevation in meters as R·256 + G + B/256 − 32768. Zoom 15 pixels are about 4.8 m at the
// equator (3.7 m at 40° latitude); the source data is coarser than that outside the US.

const Z = 15, SIZE = 256;
const URL = (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`;
const cache = new Map();

function tile(x, y) {
  const key = `${x}/${y}`;
  if (!cache.has(key)) {
    cache.set(key, new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = c.height = SIZE;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        resolve(ctx.getImageData(0, 0, SIZE, SIZE).data);
      };
      img.onerror = () => { cache.delete(key); reject(new Error("terrain tile unavailable")); };
      img.src = URL(Z, x, y);
    }));
  }
  return cache.get(key);
}

// Web Mercator pixel coordinates at zoom Z
function pixel(lat, lng) {
  const n = 2 ** Z, s = Math.sin(lat * Math.PI / 180);
  return [(lng + 180) / 360 * n * SIZE, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n * SIZE];
}

// Elevation (m) at each {lat, lng}, bilinear between pixel centers.
export async function elevations(points) {
  const out = new Float64Array(points.length);
  await Promise.all(points.map(async ({ lat, lng }, i) => {
    const [px, py] = pixel(lat, lng);
    const x0 = Math.floor(px - 0.5), y0 = Math.floor(py - 0.5), fx = px - 0.5 - x0, fy = py - 0.5 - y0;
    const at = async (gx, gy) => {
      const d = await tile(Math.floor(gx / SIZE), Math.floor(gy / SIZE));
      const k = 4 * ((gy % SIZE) * SIZE + (gx % SIZE));
      return d[k] * 256 + d[k + 1] + d[k + 2] / 256 - 32768;
    };
    const [a, b, c, e] = await Promise.all([at(x0, y0), at(x0 + 1, y0), at(x0, y0 + 1), at(x0 + 1, y0 + 1)]);
    out[i] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + e * fx) * fy;
  }));
  return out;
}
