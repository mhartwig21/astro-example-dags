// DOES A GESTURE-FREE COLD BOOT DOWNLOAD THE MENU MUSIC BED?
//
// MusicDeck defers a bed's download only while `!unlocked && ctx.state !==
// "running"` (src/audio/deck.ts:256). So the question is really "is the
// AudioContext running before a gesture?", and THAT is decided by the browser's
// autoplay policy — which a headless harness sets differently from a real one.
//
// RESULT (asset-budget closing round, ASSET-BUDGET.md 2c): headless Chromium
// reports the context `running` AT CONSTRUCTION under all three policy values,
// so the deferral path never executes here and the 838KB menu bed is fetched at
// ~6s. That is the harness, not a regression — but it means this saving CANNOT
// be observed end-to-end on this box. It is asserted from the code path and
// test/audioStream.test.ts; only a real phone closes it.
//
// This instruments the AudioContext itself rather than trusting the app's
// ?debug hook, because the hook is off on a plain boot.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const base = process.argv[2] ?? "http://127.0.0.1:5285";

async function leg(label, policy) {
  const browser = await chromium.launch({
    headless: true,
    args: ["--use-angle=d3d11", "--enable-gpu", "--disable-frame-rate-limit",
      ...(policy ? [`--autoplay-policy=${policy}`] : [])],
    // Playwright's own default is --autoplay-policy=no-user-gesture-required;
    // it must be dropped or it wins over ours.
    ignoreDefaultArgs: policy ? ["--autoplay-policy=no-user-gesture-required"] : [],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    performance.setResourceTimingBufferSize(6000);
    window.__ctxs = [];
    for (const key of ["AudioContext", "webkitAudioContext"]) {
      const Orig = window[key];
      if (!Orig) continue;
      window[key] = class extends Orig {
        constructor(...a) { super(...a); window.__ctxs.push(this); window.__ctxAtBirth = this.state; }
      };
    }
  });
  await page.goto(`${base}/iso.html`, { waitUntil: "commit", timeout: 180000 });
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 300000 });
  await page.waitForFunction(() => {
    const el = document.getElementById("loading");
    return !el || el.classList.contains("done") || getComputedStyle(el).display === "none";
  }, null, { timeout: 300000 }).catch(() => {});
  await page.waitForTimeout(20000); // well past the t=16.5s the pre-fix code fetched at
  const r = await page.evaluate(() => {
    const rows = performance.getEntriesByType("resource")
      .filter((e) => /\.(ogg|wav|mp3|m4a)$/.test(new URL(e.name).pathname))
      .map((e) => ({ p: new URL(e.name).pathname, t: Math.round(e.responseEnd), b: e.transferSize }));
    return {
      n: rows.length, bytes: rows.reduce((s, x) => s + x.b, 0),
      music: rows.filter((x) => !x.p.includes("/sfx/")),
      atBirth: window.__ctxAtBirth ?? "no context created",
      now: (window.__ctxs ?? []).map((c) => c.state).join(","),
    };
  });
  console.log(`\n=== ${label} ===`);
  console.log(`audio files ${r.n}  bytes ${r.bytes}  AudioContext at construction: ${r.atBirth}  now: ${r.now}`);
  console.log(`  music beds fetched: ${r.music.map((m) => `${m.p} ${m.b}B @${m.t}ms`).join(" | ") || "NONE (deferral took)"}`);
  await page.close(); await ctx.close(); await browser.close();
}

// One browser at a time — the dev box crashes at ~6 (HANDOFF.md 5).
await leg("A. playwright default (no-user-gesture-required)", null);
await leg("B. user-gesture-required", "user-gesture-required");
await leg("C. document-user-activation-required", "document-user-activation-required");
