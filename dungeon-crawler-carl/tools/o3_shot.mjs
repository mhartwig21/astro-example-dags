// OPT-R3 — the world-shader change must be INVISIBLE. Same frame, both
// variants, one session: pack-vs-two-fetches and gated-vs-ungated murk are
// arithmetic identities everywhere the murk is non-zero and are exactly zero
// where it is not, so a pixel diff is the claim.
import { writeFileSync } from "node:fs";
import { boot, installProbe, stage, flag } from "./o3lab.mjs";

const adapter = flag("--adapter", "igpu");
const mode = flag("--mode", "high");
const { browser, page } = await boot({ adapter });
try {
  await installProbe(page);
  await stage(page);
  await page.evaluate((m) => window.__setMode(m), mode);
  await page.evaluate(() => { window.__dcc.state.players[0].hp = window.__dcc.state.players[0].maxHp; });
  await page.waitForTimeout(2500);
  // Freeze the wobble sources so the two shots differ only by the shader.
  await page.evaluate(() => {
    const r3d = window.__dcc.renderer;
    r3d.update = () => {};
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: "tools/_o3shot_new.png" });
  const n = await page.evaluate(() => window.__dcc.renderer.setWorldShaderLegacy(true));
  console.log(`recompiled ${n} world materials into the legacy shader`);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: "tools/_o3shot_legacy.png" });
  console.log("wrote tools/_o3shot_new.png + tools/_o3shot_legacy.png");
} finally {
  await browser.close();
}
