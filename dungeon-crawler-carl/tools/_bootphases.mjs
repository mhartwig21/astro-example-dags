// BOOT PHASE HONESTY PROBE (asset-budget delivery round).
//
// The loading bar is a weighted sum: models 0.86 + audio 0.06 + warm 0.08
// (main3d.ts `setBar`). Those weights are a claim about how the boot SPENDS
// ITS TIME, and the only way to know whether the claim is true is to timestamp
// the phase edges and the bar width together. This watches #loading-phase and
// #loading-fill from before the first paint and prints, per phase: when it
// started, how long it ran, and what share of the bar it was given vs what
// share of the wall clock it actually took.
//
// CAVEAT THAT MUST TRAVEL WITH ANY NUMBER THIS PRINTS: headless runs software
// GL (SwiftShader), where shader compilation — the bulk of the `warm` phase —
// is far slower than on any real GPU. The MODELS phase is network+parse bound
// and transfers honestly; the WARM phase here is an upper bound, not the
// owner's phone. Report both, never one as the other.
//
// PLAYWRIGHT_MODULE lets this run from a worktree whose node_modules lacks
// playwright (read-only import of a sibling install).
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");

const base = process.argv[2] ?? "http://127.0.0.1:5285";
const browser = await chromium.launch({
  headless: true,
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--disable-frame-rate-limit"],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });

async function boot(label) {
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    performance.setResourceTimingBufferSize(4000);
    // Installed before any script of the page runs, so no edge is missed.
    window.__phases = [];
    window.__bar = [];
    window.__done = null;
    const start = () => {
      const phaseEl = document.getElementById("loading-phase");
      const fillEl = document.getElementById("loading-fill");
      const countEl = document.getElementById("loading-count");
      const loadEl = document.getElementById("loading");
      if (!phaseEl || !fillEl || !loadEl) return false;
      // The honest end-of-boot instant is the one the PAGE observes the overlay
      // being dismissed at. Polling it from the driver (waitForFunction) times
      // the compositor instead: under software GL the queued frames flush before
      // the next rAF, which inflated this by >10s and invented a bar stall.
      new MutationObserver(() => {
        if (window.__done === null && loadEl.classList.contains("done")) {
          window.__done = Math.round(performance.now());
        }
      }).observe(loadEl, { attributes: true, attributeFilter: ["class"] });
      new MutationObserver(() => {
        window.__phases.push({ t: Math.round(performance.now()), text: phaseEl.textContent });
      }).observe(phaseEl, { childList: true, characterData: true, subtree: true });
      new MutationObserver(() => {
        window.__bar.push({
          t: Math.round(performance.now()),
          w: parseFloat(fillEl.style.width) || 0,
          count: countEl?.textContent ?? "",
        });
      }).observe(fillEl, { attributes: true, attributeFilter: ["style"] });
      window.__phases.push({ t: Math.round(performance.now()), text: phaseEl.textContent });
      return true;
    };
    if (!start()) document.addEventListener("DOMContentLoaded", start);
    // A 50ms heartbeat. Gaps in it are main-thread BLOCKS (one long task), and
    // their absence means the boot was waiting on something off-thread. Without
    // this you cannot tell "the bar lied about how much work is left" from "the
    // work is real and it is not ours".
    window.__ticks = [];
    setInterval(() => window.__ticks.push(Math.round(performance.now())), 50);
  });
  await page.goto(`${base}/iso.html`, { waitUntil: "commit", timeout: 120000 });
  await page.waitForFunction(() => {
    const el = document.getElementById("loading");
    return el && (el.classList.contains("done") || getComputedStyle(el).display === "none");
  }, null, { timeout: 300000 });
  const r = await page.evaluate(() => {
    const fp = performance.getEntriesByType("paint").find((e) => e.name === "first-contentful-paint");
    // What did the browser fetch BEFORE the first paint? Anything in here that
    // is not the document, its CSS or its module is something to justify.
    const beforeFcp = performance.getEntriesByType("resource")
      .filter((e) => e.responseEnd <= (fp?.startTime ?? 0))
      .map((e) => `${new URL(e.name).pathname} (${Math.round(e.responseEnd)}ms, ${e.transferSize}B)`);
    return {
      fcp: fp ? Math.round(fp.startTime) : null,
      phases: window.__phases, bar: window.__bar, beforeFcp, ticks: window.__ticks,
      done: window.__done ?? Math.round(performance.now()),
      observed: Math.round(performance.now()),
    };
  });
  console.log(`\n=== ${label} ===`);
  console.log(`first-contentful-paint ${r.fcp}ms · loading screen dismissed ${r.done}ms `
    + `(driver only saw it ${r.observed - r.done}ms later — that lag is the compositor, not the boot)`);
  console.log(`resources completed before FCP (${r.beforeFcp.length}):`);
  for (const l of r.beforeFcp) console.log(`    ${l}`);
  // Phase edges, deduped (a MutationObserver can fire twice for one write).
  const edges = [];
  for (const p of r.phases) {
    if (!edges.length || edges[edges.length - 1].text !== p.text) edges.push(p);
  }
  const WEIGHT = { "RECEIVING THE DUNGEON": 0.86, "TUNING THE ANNOUNCER'S MICROPHONE": 0.06, "CALIBRATING THE CAMERAS": 0.08 };
  console.log(`phases (bar weight vs share of the wall clock):`);
  for (let i = 0; i < edges.length; i++) {
    const end = i + 1 < edges.length ? edges[i + 1].t : r.done;
    const dur = end - edges[i].t;
    const w = WEIGHT[edges[i].text];
    console.log(`  ${String(edges[i].text).padEnd(34)} start ${String(edges[i].t).padStart(6)}ms  dur ${String(dur).padStart(6)}ms  `
      + `bar ${w === undefined ? "  n/a" : `${(w * 100).toFixed(0)}%`.padStart(5)}  clock ${((dur / r.done) * 100).toFixed(0).padStart(3)}%`);
  }
  // How long the bar sat at each plateau — "stuck at 86%" is the complaint.
  const bar = r.bar;
  if (bar.length) {
    const stalls = [];
    for (let i = 0; i < bar.length; i++) {
      const end = i + 1 < bar.length ? bar[i + 1].t : r.done;
      if (end - bar[i].t > 900) stalls.push(`${bar[i].w}% for ${end - bar[i].t}ms (${bar[i].count})`);
    }
    console.log(`bar writes ${bar.length}; stalls >0.9s: ${stalls.length ? stalls.join(" · ") : "none"}`);
  }
  const blocks = [];
  for (let i = 1; i < r.ticks.length; i++) {
    const gap = r.ticks[i] - r.ticks[i - 1];
    if (gap > 400) blocks.push(`${r.ticks[i - 1]}ms +${gap}ms`);
  }
  console.log(`main-thread blocks >400ms during boot: ${blocks.length ? blocks.join(" · ") : "none"}`);
  await page.close();
  return r;
}

await boot("COLD CACHE");
await boot("WARM CACHE (same context)");
await browser.close();
