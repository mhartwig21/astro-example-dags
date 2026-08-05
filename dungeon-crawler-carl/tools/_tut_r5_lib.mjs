// TUTORIAL r5 verification harness — same instrument as the r4 critique
// (tools/_crit_r4_lib.mjs, copied verbatim but for the shots directory), so the
// round is measured by the tool that failed it. COLD contexts, raster proof.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

export const SHOTS = new URL("./_tut_r5_shots/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
mkdirSync(SHOTS, { recursive: true });

export const fails = [], notes = [], transcript = [];
export function check(name, cond, detail = "") {
  const line = `${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`;
  (cond ? notes : fails).push(line);
  console.log(line);
  return cond;
}
export function log(s) { transcript.push(s); console.log(`  · ${s}`); }
export function dump(file) {
  writeFileSync(`${SHOTS}${file}`, [...transcript, "", ...fails, "", ...notes].join("\n"), "utf8");
}

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let off = 8, w = 0, h = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); colorType = data[9]; }
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const px = Buffer.allocUnsafe(h * stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const rawB = raw[src + x];
      const a = x >= channels ? px[dst + x - channels] : 0;
      const b = y > 0 ? px[dst - stride + x] : 0;
      const c = y > 0 && x >= channels ? px[dst - stride + x - channels] : 0;
      let v;
      if (filter === 0) v = rawB;
      else if (filter === 1) v = rawB + a;
      else if (filter === 2) v = rawB + b;
      else if (filter === 3) v = rawB + ((a + b) >> 1);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = rawB + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      px[dst + x] = v & 0xff;
    }
  }
  return { w, h, channels, px };
}
export function boxStats(file, box) {
  const { w, channels, px } = decodePng(readFileSync(file));
  const X0 = Math.max(0, Math.floor(box.x)), Y0 = Math.max(0, Math.floor(box.y));
  const X1 = Math.floor(box.x + box.width), Y1 = Math.floor(box.y + box.height);
  let n = 0, sum = 0, sum2 = 0, warmN = 0;
  for (let y = Y0; y < Y1; y++) {
    for (let x = X0; x < X1; x++) {
      const o = (y * w + x) * channels;
      const r = px[o], g = px[o + 1] ?? r, b = px[o + 2] ?? r;
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += l; sum2 += l * l; n++;
      if (r - b > 30 && r > 90) warmN++;
    }
  }
  const mean = sum / n;
  return { mean, std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), warmFrac: warmN / n, n };
}
export async function rasterCheck(page, sel, name, minWarm = 0.01) {
  const box = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, sel);
  const file = `${SHOTS}${name}.png`;
  await page.screenshot({ path: file });
  if (!box || box.width < 4 || box.height < 4) {
    check(`${name}: ${sel} has a real box`, false, JSON.stringify(box));
    return null;
  }
  const st = boxStats(file, box);
  check(`${name}: ${sel} PAINTED (std ${st.std.toFixed(1)}, warm ${(st.warmFrac * 100).toFixed(1)}%)`,
    st.std > 8 && st.warmFrac > minWarm);
  return { box, st, file };
}

export const gotoOpts = { waitUntil: "load", timeout: 90000 };
export async function boot(page, url) {
  await page.goto(url, gotoOpts);
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 180000 });
  await page.waitForFunction(() => {
    const el = document.getElementById("loading");
    if (!el || el.classList.contains("done")) return true;
    const cs = getComputedStyle(el);
    return cs.display === "none" || parseFloat(cs.opacity) === 0;
  }, { timeout: 180000 }).catch(() => {});
  // ...and wait until it stops eating clicks, not merely until it is faded.
  await page.waitForFunction(() => {
    const el = document.getElementById("loading");
    if (!el) return true;
    const cs = getComputedStyle(el);
    return cs.display === "none" || cs.visibility === "hidden" || cs.pointerEvents === "none"
      || parseFloat(cs.opacity) === 0;
  }, { timeout: 180000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

/** Click that falls back to a DOM click if an overlay is still hit-testing. */
export async function clickSafe(page, sel) {
  try { await page.click(sel, { timeout: 8000 }); }
  catch { await page.evaluate((s) => document.querySelector(s)?.click(), sel); }
}

/** Spy: every card ADD and REMOVE (so I can measure visible dwell), every beat,
 *  and a running snapshot of ledger-vs-sim-latch at each event. */
export const spyInit = () => {
  window.__cards = [];
  window.__beats = [];
  window.__ledgerLog = [];
  const ctx = () => {
    const s = window.__dcc?.state;
    if (!s) return {};
    const p = s.players?.[0];
    let near = 999;
    for (const m of s.monsters ?? []) {
      if (m.hp > 0 && p) {
        const d = Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y);
        if (d < near) near = d;
      }
    }
    let ledger = [];
    try { ledger = JSON.parse(localStorage.getItem("dcc:tips:v1") ?? "[]"); } catch {}
    return {
      floor: s.floor, elapsed: Math.round(s.elapsed), lvl: p?.level,
      hp: p ? Math.round((p.hp / p.maxHp) * 100) : -1,
      near: Math.round(near * 10) / 10, status: s.status,
      sr: !!s.safeRoom, modal: document.body.classList.contains("modal"),
      hype: Math.round(p?.hype ?? -1), viewers: Math.round(p?.viewers ?? -1),
      fav: p?.favorites ?? -1, flask: p?.flaskCharges ?? -1,
      slots: (p?.abilities?.slots ?? []).map((a) => a ?? "").join("|"),
      ult: p?.abilities?.ultimate ?? null,
      latch: [...(p?.tipsSeen ?? [])], ledger,
    };
  };
  window.__ctx = ctx;
  const arm = () => {
    const layer = document.getElementById("tutorial");
    const dlg = document.getElementById("dialogue");
    if (!layer || !dlg) { setTimeout(arm, 50); return; }
    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType === 1 && n.classList?.contains("tut")) {
            const r = n.getBoundingClientRect();
            window.__cards.push({
              t: n.textContent ?? "", at: performance.now(), ctx: ctx(),
              box: { x: r.x, y: r.y, w: r.width, h: r.height }, gone: 0,
            });
          }
        }
        for (const n of m.removedNodes) {
          if (n.nodeType === 1 && n.classList?.contains("tut")) {
            const last = [...window.__cards].reverse().find((c) => !c.gone);
            if (last) last.gone = performance.now();
          }
        }
      }
    }).observe(layer, { childList: true });
    let wasOpen = false;
    setInterval(() => {
      const open = dlg.style.display === "flex" && dlg.classList.contains("show");
      if (open && !wasOpen) {
        window.__beats.push({
          who: document.getElementById("dlg-name")?.textContent ?? "",
          kicker: document.getElementById("dlg-kicker")?.textContent ?? "",
          text: document.getElementById("dlg-text")?.textContent ?? "",
          choices: [...dlg.querySelectorAll(".dlg-choice")].map((b) => b.textContent),
          at: performance.now(), ctx: ctx(),
        });
      }
      wasOpen = open;
    }, 120);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", arm);
  else arm();
};

export const cards = (p) => p.evaluate(() => window.__cards ?? []);
export const beats = (p) => p.evaluate(() => window.__beats ?? []);
export const ledger = (p) => p.evaluate(() => { try { return JSON.parse(localStorage.getItem("dcc:tips:v1") ?? "[]"); } catch { return []; } });
export const latch = (p) => p.evaluate(() => [...(window.__dcc?.state?.players?.[0]?.tipsSeen ?? [])]);
export const snap = (p) => p.evaluate(() => window.__ctx?.() ?? {});
export const dlgVisible = (p) => p.evaluate(() => {
  const el = document.getElementById("dialogue");
  return !!el && el.style.display === "flex" && el.classList.contains("show");
});
export const dlgText = (p) => p.evaluate(() => ({
  who: document.getElementById("dlg-name")?.textContent,
  role: document.getElementById("dlg-role")?.textContent,
  kicker: document.getElementById("dlg-kicker")?.textContent,
  text: document.getElementById("dlg-text")?.textContent,
  choices: [...document.querySelectorAll("#dialogue .dlg-choice")].map((b) => b.textContent),
}));

/** A COLD profile is a claim I verify, never assume. */
export async function assertCold(page, tag) {
  const st = await page.evaluate(() => ({
    keys: Object.keys(localStorage),
    tips: localStorage.getItem("dcc:tips:v1"),
    save: localStorage.getItem("dcc:save:v1"),
    hist: localStorage.getItem("dcc:history:v1"),
  }));
  check(`${tag}: profile is genuinely COLD (no tips ledger, no save, no history)`,
    !st.tips && !st.save && !st.hist, `keys=[${st.keys.join(",")}]`);
  return st;
}

export const track404 = (page, sink) => page.on("response", (r) => { if (r.status() === 404) sink.push(r.url()); });
