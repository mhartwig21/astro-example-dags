// BUG 2 — look check: the hero's directional contact ellipse must stay
// WORLD-oriented while the body turns (a cast shadow does not spin with its
// caster), and on HIGH it must lie along the real map shadow, not across it.
// Two captures per mode: facing north-ish, then facing east-ish.
import { boot, flag } from "./o3lab.mjs";

const mode = flag("--mode", "medium");
const url = "http://localhost:5282/iso.html?test&floor=2&level=4&abilities=all"
  + `&seed=7&eagerassets&clean=1&debug=1&quality=${mode}`;
const { browser, page } = await boot({ adapter: "igpu", url });
try {
  const face = async (fx, fy) => page.evaluate(([x, y]) => {
    const p = window.__dcc.state.players[0];
    p.facing.x = x; p.facing.y = y;
  }, [fx, fy]);
  const heroBox = async () => page.evaluate(() => {
    const r = window.__dcc.renderer;
    const p = window.__dcc.state.players[0];
    const m = r.playerMeshes.get(p.id);
    const v = m.position.clone().project(r.camera);
    const g = m.userData.dirShadow;
    return {
      x: (v.x + 1) / 2, y: (1 - v.y) / 2,
      bodyYaw: +m.rotation.y.toFixed(3),
      blobYaw: +g.rotation.y.toFixed(3),
      worldYaw: +((m.rotation.y + g.rotation.y) % (Math.PI * 2)).toFixed(3),
    };
  });
  await face(0, 1); await page.waitForTimeout(900);
  const a = await heroBox();
  await page.screenshot({ path: `tools/_shadowlook_${mode}_a.png`,
    clip: { x: a.x * 1440 - 220, y: a.y * 852 - 190, width: 440, height: 340 } });
  await face(1, 0); await page.waitForTimeout(900);
  const b = await heroBox();
  await page.screenshot({ path: `tools/_shadowlook_${mode}_b.png`,
    clip: { x: b.x * 1440 - 220, y: b.y * 852 - 190, width: 440, height: 340 } });
  console.log("A", JSON.stringify(a));
  console.log("B", JSON.stringify(b));
  const drift = Math.abs(a.worldYaw - b.worldYaw);
  console.log(`world yaw drift across a body turn: ${drift.toFixed(4)} rad (want ~0)`);
} finally {
  await browser.close();
}
