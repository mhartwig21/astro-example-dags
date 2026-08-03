// WHAT DOES A REAL PLAYER ON THE WEAK PATH ACTUALLY GET?
//
// Every number in quality.ts is measured with a mode PINNED. Nobody pins a
// mode. `guessQuality` starts an unidentified desktop at MEDIUM and the runtime
// tuner is supposed to move it — its threshold is `downMs: 34`, and the file
// argues the threshold is fine because "MEDIUM now delivers 41.2 fps in that
// same worst scene". If MEDIUM's window MEAN never reaches 34 ms, the tuner
// cannot fire, and LOW — the mode that exists to rescue this machine — is
// reachable only by a player who opens the settings panel and knows what to do.
//
// So: run AUTO, in the dense pack, on the Intel part, and watch.
// Usage: node tools/acc2_auto.mjs --adapter igpu [--secs 120]
import { writeFileSync } from "node:fs";
import { boot, installProbe, stage, census, shape, flag } from "./acc2_lab.mjs";

const adapter = flag("--adapter", "igpu");
const secs = Number(flag("--secs", 120));
const out = flag("--out", `tools/_acc2auto_${adapter}.json`);

// ?test&quality=auto is the documented escape hatch that restores the tuner.
const url = `http://localhost:5282/iso.html?test&floor=15&level=26&seed=41&abilities=all&debug=1&quality=auto`;
const { browser, page } = await boot({ adapter, url });
try {
  await installProbe(page);
  await page.evaluate(() => {
    const r3d = window.__dcc.renderer;
    window.__notices = [];
    r3d.setQualityNoticeListener((n) => window.__notices.push({ t: performance.now(), ...n }));
    window.__mode = () => r3d.qualityProfile.name;
  });
  await stage(page);
  console.log(`\nAUTO on ${adapter}, dense pack, ${secs}s. foreign=${census().foreign}`);
  console.log(`mode at start: ${await page.evaluate(() => window.__mode())}`);

  const trail = [];
  await page.evaluate(() => window.__winStart());
  const t0 = Date.now();
  while ((Date.now() - t0) / 1000 < secs) {
    await page.evaluate(() => window.__toPack());
    await page.mouse.move(760, 380);
    await page.mouse.down();
    await page.waitForTimeout(4000);
    await page.mouse.up();
    const m = await page.evaluate(() => window.__mode());
    const live = await page.evaluate(() => window.__live());
    trail.push({ at: Math.round((Date.now() - t0) / 1000), mode: m, px: live.pixelRatio, buf: `${live.bufW}x${live.bufH}` });
    console.log(`  t=${trail[trail.length - 1].at}s  mode=${m}  pixelRatio=${live.pixelRatio}  buffer=${live.bufW}x${live.bufH}`);
  }
  const raw = await page.evaluate(() => window.__winEnd());
  const s = shape(raw.deltas, raw.wallMs);
  const notices = await page.evaluate(() => window.__notices);
  const modes = [...new Set(trail.map((t) => t.mode))];
  console.log(`\nover the whole ${secs}s: ${s.fps} fps, delivered ${s.delivered} ms, p50 ${s.p50}, p90 ${s.p90}, p99 ${s.p99}, `
    + `>16.7 ${s.over16}%, >20 ${s.over20}%, >33.3 ${s.over33}%`);
  console.log(`modes visited by AUTO: ${modes.join(", ")}`);
  console.log(`tuner notices: ${notices.length ? JSON.stringify(notices) : "NONE — the tuner never fired"}`);
  writeFileSync(out, JSON.stringify({ adapter, secs, shape: s, trail, notices, census: census() }, null, 2));
  console.log(`wrote ${out}`);
} finally {
  await browser.close();
}
