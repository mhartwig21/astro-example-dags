// Cache/load-order probe for the asset-budget delivery round.
// Boot 1 = cold cache; boot 2 = same browser context, warm cache. Prints the
// request census (count/bytes/status/cache-control) and the boot timings so
// "immutable actually removes the requests" is measured, not assumed.
// PLAYWRIGHT_MODULE lets this run from a worktree whose node_modules has no
// playwright (read-only import of a sibling install; nothing is written there).
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");

const base = process.argv[2] ?? "http://127.0.0.1:5285";
const url = `${base}/iso.html`;

const browser = await chromium.launch({
  headless: true,
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--disable-frame-rate-limit"],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });

async function boot(label) {
  const page = await ctx.newPage();
  // The default Resource Timing buffer is 250 entries — a boot that fetches 380
  // files silently truncates to exactly 250 and every total below it is a lie.
  await page.addInitScript(() => performance.setResourceTimingBufferSize(4000));
  const bad = [];
  page.on("response", (r) => { if (r.status() >= 400) bad.push(`${r.status()} ${r.url()}`); });
  const t0 = Date.now();
  await page.goto(url, { waitUntil: "commit", timeout: 120000 });
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 300000 });
  const settled = Date.now() - t0;
  await page.waitForFunction(() => {
    const el = document.getElementById("loading");
    return !el || getComputedStyle(el).display === "none" || el.classList.contains("done");
  }, null, { timeout: 300000 }).catch(() => {});
  const loadingDone = Date.now() - t0;
  // Resource Timing is the honest census: transferSize 0 = the browser never
  // went to the network (a `page.on("response")` listener fires for cache hits
  // too, which is how a "cache works!" measurement talks itself into nonsense).
  const census = await page.evaluate(() => {
    const fp = performance.getEntriesByType("paint").find((e) => e.name === "first-contentful-paint");
    const rows = performance.getEntriesByType("resource")
      .filter((e) => e.name.startsWith(location.origin))
      .map((e) => ({ path: new URL(e.name).pathname, transfer: e.transferSize, decoded: e.decodedBodySize }));
    const doc = performance.getEntriesByType("navigation")[0];
    return { fcp: fp ? Math.round(fp.startTime) : null, rows, docTransfer: doc?.transferSize ?? 0 };
  });
  const byDir = {};
  for (const r of census.rows) {
    const k = r.path.split("/")[1]?.split(".")[0] || "(root)";
    byDir[k] = byDir[k] ?? { n: 0, net: 0, bytes: 0, decoded: 0 };
    byDir[k].n++; byDir[k].bytes += r.transfer; byDir[k].decoded += r.decoded;
    if (r.transfer > 0) byDir[k].net++;
  }
  const net = census.rows.filter((r) => r.transfer > 0).length;
  const bytes = census.rows.reduce((a, r) => a + r.transfer, 0) + census.docTransfer;
  console.log(`\n=== ${label} ===`);
  console.log(`subresources=${census.rows.length} of which HIT THE NETWORK=${net} · transferred=${(bytes / 1e6).toFixed(2)}MB`);
  console.log(`fcp=${census.fcp}ms assetsSettled=${settled}ms loadingScreenDone=${loadingDone}ms`);
  for (const [k, v] of Object.entries(byDir).sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${k.padEnd(14)} ${String(v.n).padStart(4)} used  ${String(v.net).padStart(4)} fetched  ${(v.bytes / 1e6).toFixed(2)}MB wire  ${(v.decoded / 1e6).toFixed(2)}MB decoded`);
  }
  console.log(`  4xx/5xx: ${bad.length}${bad.length ? " -> " + bad.slice(0, 12).join(", ") : ""}`);
  await page.close();
  return { used: census.rows.length, net, bytes, settled, loadingDone, fcp: census.fcp };
}

const cold = await boot("COLD CACHE");
const warm = await boot("WARM CACHE (same context)");
console.log(`\nwarm/cold: network requests ${warm.net}/${cold.net} · transferred ${(warm.bytes / 1e6).toFixed(2)}/${(cold.bytes / 1e6).toFixed(2)}MB · fcp ${warm.fcp}/${cold.fcp}ms · settled ${warm.settled}/${cold.settled}ms`);
await browser.close();
