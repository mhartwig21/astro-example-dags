// COLOR AUDIT — the appearance score, made objective.
//
// Two numbers earlier critics used against this build, computed the same way
// every time so a round can be scored instead of argued about:
//
//   hueBins   how many of 36 ten-degree hue bins hold a MEANINGFUL share of the
//             frame's chromatic pixels (>= 0.75% each). A comparable AAA frame
//             lands 6-9. This build has measured 2-3: colour was a TINT over one
//             hue, not a design.
//   deadBlack fraction of the PLAYFIELD under luma 0.06. Earlier reads: 46-58%.
//
// A BIN COUNT ALONE LIES, which the first run of this tool proved: the baseline
// frames score 5-7 live bins and every one of them is adjacent — [340 350 0 10
// 20 30] is ONE 60-degree arc of orange wearing six bins. So the headline is
// hueClusters (connected runs of live bins, wrapping at 360) and hueArc90 (the
// tightest arc holding 90% of the chroma weight). One cluster in a 60-degree arc
// is a tint no matter how many bins it touches; a designed frame has a warm pole
// AND a cool pole, i.e. >= 2 clusters spread over a wide arc.
//
// DARKNESS is reported twice because the two readings mean different things and
// a single one invites arguing: blackPct is sRGB-encoded luma < 0.06 (byte ~15 —
// pixels that are BLACK to the eye) and crushedPct is scene-linear luma < 0.06
// (byte ~68 — everything sitting in the bottom stop, where detail dies).
//
// Chromatic pixels only, on purpose: a hue angle read off a near-grey pixel is
// noise (chroma 1/255 can swing hue 180 degrees), so bins are weighted by
// chroma and pixels under `--minchroma` never vote. Luma is Rec.709 on the
// sRGB-decoded value, so "dead black" means dark to the EYE, not dark in a
// gamma-encoded byte.
//
// The HUD is EXCLUDED. It is a gold-on-black overlay a sibling track owns; left
// in, it donates its own hue bin and its black plates to the black score, and
// the world would be graded for someone else's pixels. The mask below is the
// iso.html screen-zone map: a top band, a bottom band, and the two bottom
// corners (live feed, minimap). Pass --nomask to score the raw frame.
//
// Usage: node tools/coloraudit.mjs shot.png [more.png ...] [--minchroma 0.06]
//        node tools/coloraudit.mjs dir/            (every .png in the dir)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { join } from "node:path";

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0) throw new Error(`unsupported PNG (depth ${bitDepth}, interlace ${interlace})`);
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  if (!ch) throw new Error(`unsupported color type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const px = Buffer.allocUnsafe(h * stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const rb = raw[src + x];
      const a = x >= ch ? px[dst + x - ch] : 0;
      const b = y > 0 ? px[dst - stride + x] : 0;
      const c = y > 0 && x >= ch ? px[dst - stride + x - ch] : 0;
      let v;
      if (filter === 0) v = rb;
      else if (filter === 1) v = rb + a;
      else if (filter === 2) v = rb + b;
      else if (filter === 3) v = rb + ((a + b) >> 1);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = rb + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      px[dst + x] = v & 0xff;
    }
  }
  return { w, h, ch, px };
}

const srgbToLin = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  srgbToLin[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** True when (x,y) is HUD, in image pixels. Fractions of the frame so it holds
 *  at any capture resolution. Mirrors the iso.html screen-zone map. */
function isHud(x, y, w, h) {
  const fx = x / w, fy = y / h;
  if (fy < 0.135) return true;                       // top bar: floor/collapse, System chips, level
  if (fy > 0.875) return true;                       // hotbar strip
  if (fy > 0.76 && (fx < 0.29 || fx > 0.85)) return true; // live feed / minimap
  return false;
}

function audit(file, opts) {
  const { w, h, ch, px } = decodePng(readFileSync(file));
  const bins = new Float64Array(36);
  const binPx = new Int32Array(36);
  let dead = 0, black = 0, counted = 0, chromatic = 0;
  let sumLuma = 0;
  const lumaHist = new Int32Array(64);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!opts.nomask && isHud(x, y, w, h)) continue;
      const i = (y * w + x) * ch;
      const r8 = px[i], g8 = px[i + 1], b8 = px[i + 2];
      const r = srgbToLin[r8], g = srgbToLin[g8], b = srgbToLin[b8];
      const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      counted++; sumLuma += luma;
      lumaHist[Math.min(63, Math.floor(Math.sqrt(luma) * 64))]++;
      if (luma < 0.06) dead++;
      if (0.2126 * r8 + 0.7152 * g8 + 0.0722 * b8 < 0.06 * 255) black++;
      // chroma in sRGB-encoded space: what the eye reads as "coloured"
      const mx = Math.max(r8, g8, b8) / 255, mn = Math.min(r8, g8, b8) / 255;
      const chroma = mx - mn;
      if (chroma < opts.minchroma || mx < 0.05) continue;
      chromatic++;
      // hue angle, degrees
      let hue;
      const d = mx - mn;
      const rn = r8 / 255, gn = g8 / 255, bn = b8 / 255;
      if (mx === rn) hue = ((gn - bn) / d) % 6;
      else if (mx === gn) hue = (bn - rn) / d + 2;
      else hue = (rn - gn) / d + 4;
      hue = ((hue * 60) % 360 + 360) % 360;
      const bi = Math.floor(hue / 10) % 36;
      bins[bi] += chroma;   // weight by how coloured it is
      binPx[bi]++;
    }
  }
  const total = bins.reduce((a, b) => a + b, 0) || 1;
  const share = Array.from(bins, (v) => v / total);
  const MIN_SHARE = 0.0075;
  const live = share.map((s, i) => ({ i, s })).filter((e) => e.s >= MIN_SHARE);
  const top = [...share.map((s, i) => ({ i, s }))].sort((a, b) => b.s - a.s).slice(0, 6);

  // CLUSTERS: connected runs of live bins on the hue circle (wrapping).
  const isLive = new Array(36).fill(false);
  for (const e of live) isLive[e.i] = true;
  let clusters = 0;
  if (live.length === 36) clusters = 1;
  else for (let i = 0; i < 36; i++) if (isLive[i] && !isLive[(i + 35) % 36]) clusters++;

  // ARC90: the tightest contiguous arc of bins holding >= 90% of chroma weight.
  let arc90 = 360;
  for (let start = 0; start < 36; start++) {
    let acc = 0;
    for (let len = 1; len <= 36; len++) {
      acc += share[(start + len - 1) % 36];
      if (acc >= 0.9) { arc90 = Math.min(arc90, len * 10); break; }
    }
  }
  return {
    file,
    px: counted,
    hueBins: live.length,
    hueClusters: clusters,
    hueArc90: arc90,
    blackPct: +(100 * black / counted).toFixed(1),
    deadBlackPct: +(100 * dead / counted).toFixed(1),
    chromaticPct: +(100 * chromatic / counted).toFixed(1),
    meanLuma: +(sumLuma / counted).toFixed(4),
    topHues: top.filter((t) => t.s > 0.001).map((t) => `${t.i * 10}-${t.i * 10 + 10}deg:${(t.s * 100).toFixed(1)}%`),
    liveBins: live.map((e) => e.i * 10),
  };
}

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const opts = { minchroma: Number(flag("--minchroma", 0.06)), nomask: args.includes("--nomask") };
let files = args.filter((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--minchroma");
files = files.flatMap((f) => (statSync(f).isDirectory()
  ? readdirSync(f).filter((n) => n.endsWith(".png")).map((n) => join(f, n))
  : [f]));

const rows = files.map((f) => audit(f, opts));
for (const r of rows) {
  console.log(`\n${r.file}`);
  console.log(`  hueBins        ${String(r.hueBins).padStart(3)} / 36   clusters ${r.hueClusters}   arc90 ${r.hueArc90}deg   bins@10deg: [${r.liveBins.join(", ")}]`);
  console.log(`  black         ${String(r.blackPct).padStart(5)} %    (sRGB luma < 0.06 — black to the eye)`);
  console.log(`  crushed       ${String(r.deadBlackPct).padStart(5)} %    (linear luma < 0.06 — bottom stop)`);
  console.log(`  chromatic     ${String(r.chromaticPct).padStart(5)} %    meanLuma ${r.meanLuma}`);
  console.log(`  top hues       ${r.topHues.join("  ")}`);
}
if (rows.length > 1) {
  const avg = (k) => +(rows.reduce((a, r) => a + r[k], 0) / rows.length).toFixed(2);
  console.log(`\nMEAN over ${rows.length} frames: hueBins ${avg("hueBins")} clusters ${avg("hueClusters")} arc90 ${avg("hueArc90")}deg  black ${avg("blackPct")}%  crushed ${avg("deadBlackPct")}%  chromatic ${avg("chromaticPct")}%  luma ${avg("meanLuma")}`);
}
if (args.includes("--json")) console.log("\nJSON " + JSON.stringify(rows));
