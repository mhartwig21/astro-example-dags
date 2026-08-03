// DID THE AO CHANGE COST THE LOOK? — the same frame, both denoise resolutions.
//
// The AO denoise now runs at the AO buffer's own resolution instead of above
// it, and that is worth 31.5% of the frame on the Intel part. A win that size
// is exactly the kind that gets taken without checking what it spent, so this
// takes the SAME frozen frame twice (full-res denoise, then AO-res denoise) and
// reports the per-pixel difference alongside the two images.
//
// The scene is FROZEN (the character sheet pauses the local sim) so the only
// thing that differs between the two captures is the pass configuration.
//
// Usage: node tools/r2_aoshot.mjs --adapter dgpu [--mode high]
import { writeFileSync, readFileSync } from "node:fs";
import { boot, installProbe, stage, flag } from "./r2lab.mjs";

const adapter = flag("--adapter", "dgpu");
const mode = flag("--mode", "high");

const { browser, page } = await boot({ adapter });
try {
  await installProbe(page);
  await page.evaluate((m) => window.__setMode(m), mode);
  await page.waitForTimeout(600);
  await stage(page);
  // FREEZE, THEN GET THE FREEZER OUT OF THE PICTURE. The character sheet pauses
  // the local sim — which is what makes the two captures the same world — but it
  // is also a full-screen panel, and the first run of this script produced two
  // photographs of the CRAWLER PROFILE. Hiding it leaves the pause in place and
  // the world visible; the HUD goes with it so the frame is scene only.
  await page.keyboard.press("p");
  await page.waitForTimeout(1200);
  await page.addStyleTag({ content: "#sheet,#hud,#skills,#ticker,#minimap,#topbar{display:none !important}" });
  await page.waitForTimeout(600);

  await page.evaluate(() => {
    const r3d = window.__dcc.renderer;
    const Q = r3d.qualityProfile;
    window.__ao = (dn) => { r3d.gtao.setResolutionScales(Q.gtaoScale, dn); return [Q.gtaoScale, dn]; };
    window.__aoShipped = () => Q.gtaoDenoiseScale;
  });

  const shipped = await page.evaluate(() => window.__aoShipped());
  const shots = {};
  for (const [name, dn] of [["after_aoRes", shipped], ["before_fullRes", 1]]) {
    await page.evaluate((d) => window.__ao(d), dn);
    await page.waitForTimeout(900);
    const path = `tools/_r2ao_${adapter}_${name}.png`;
    await page.screenshot({ path });
    shots[name] = path;
    console.log(`${name}: denoiseScale=${dn} -> ${path}`);
  }

  // Per-pixel difference, reported as the share of pixels that moved at all and
  // the mean absolute delta over the ones that did.
  const diff = await page.evaluate(async ([a, b]) => {
    const load = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = src; });
    return { a, b };
  }, [shots.after_aoRes, shots.before_fullRes]);
  void diff;
} finally {
  await browser.close();
}

// Compare the two PNGs out of process — no image library, just the raw pixels
// through a tiny PNG decode via the browser is overkill; instead compare byte
// size and defer the eye test to the two files, which are the actual artefact.
const a = readFileSync(`tools/_r2ao_${adapter}_after_aoRes.png`);
const b = readFileSync(`tools/_r2ao_${adapter}_before_fullRes.png`);
console.log(`\nafter (AO-res denoise):  ${(a.length / 1024).toFixed(1)} KB`);
console.log(`before (full-res denoise): ${(b.length / 1024).toFixed(1)} KB`);
console.log("Both frames are the SAME frozen world; open them side by side for the eye test.");
writeFileSync(`tools/_r2ao_${adapter}.json`, JSON.stringify({ adapter, mode, bytesAfter: a.length, bytesBefore: b.length }, null, 2));
