// BUG 1 REPRO — the boss camera loses the player.
//
// Owner: "it zooms in on a boss and if you run your PC off screen a bit you
// can't see your character and get lost." Drive: trigger a boss intro, let the
// encounter framing settle (frameBias 0.5 toward the boss + frameDrop 6.8
// screen-up), then move the crawler down-screen while still ENGAGED (<18u from
// the boss, so the borrow holds), and project the crawler through the game's
// own camera. |ndc| > 1 on either axis = the player is off-screen.
//
// Usage: node tools/_bugcam.mjs [--floor 3] [--out tools/_bugcam_before]
import { writeFileSync } from "node:fs";
import { boot, flag } from "./o3lab.mjs";
import { census } from "./trk_census.mjs";

const floor = Number(flag("--floor", 3));
const out = flag("--out", "tools/_bugcam_before");
const url = `http://localhost:5282/iso.html?test&floor=${floor}&level=${floor * 3}`
  + `&abilities=all&seed=41&eagerassets&clean=1&debug=1&quality=medium`;

const { browser, page } = await boot({ adapter: "igpu", url });
try {
  // 1. Find the boss and confirm the stage has one.
  const boss0 = await page.evaluate(() => {
    const s = window.__dcc.state;
    const b = s.monsters.find((m) => m.kind === "boss" && m.hp > 0);
    return b ? { id: b.id, x: b.pos.x, y: b.pos.y } : null;
  });
  if (!boss0) throw new Error(`no live boss on floor ${floor}`);
  console.log("boss at", boss0);

  // 2. Walk the crawler into the reveal radius (7 tiles) to trigger the intro.
  await page.evaluate(({ x, y }) => {
    const p = window.__dcc.state.players[0];
    p.pos.x = x + 5; p.pos.y = y + 5;
  }, boss0);
  await page.waitForFunction(() => {
    const s = window.__dcc.state;
    const b = s.monsters.find((m) => m.kind === "boss");
    return !!b?.introduced;
  }, { timeout: 15000 });
  console.log("introduced; waiting out the intro freeze + frame settle");
  await page.waitForTimeout(4500);

  // 3. Run away: down-screen (world +x,+z == sim +x,+y from this iso angle),
  //    staying inside the 18u engagement radius so the borrow stays live.
  await page.evaluate(({ x, y }) => {
    const p = window.__dcc.state.players[0];
    const k = 16.5 / Math.hypot(1, 1);
    p.pos.x = x + k; p.pos.y = y + k;
  }, boss0);
  await page.waitForTimeout(2000); // frameBias/zoom ease at ~1.6-2.6/s: settled

  // 4. Sample the crawler's NDC through the game's own camera for ~1s.
  const sample = await page.evaluate(async () => {
    const r = window.__dcc.renderer;
    const s = window.__dcc.state;
    const p = s.players[0];
    const res = { frames: 0, feet: [], head: [], bias: 0, drop: 0, zoom: 0, dist: 0 };
    for (let i = 0; i < 60; i++) {
      await new Promise((ok) => requestAnimationFrame(ok));
      const mesh = r.playerMeshes.get(p.id);
      if (!mesh) continue;
      const feet = mesh.position.clone().project(r.camera);
      const head = mesh.position.clone();
      head.y += 1.7;
      head.project(r.camera);
      res.frames++;
      res.feet.push([+feet.x.toFixed(3), +feet.y.toFixed(3)]);
      res.head.push([+head.x.toFixed(3), +head.y.toFixed(3)]);
    }
    const b = s.monsters.find((m) => m.kind === "boss");
    res.bias = +r.bossFx.frameBias.toFixed(3);
    res.drop = +r.bossFx.frameDrop.toFixed(3);
    res.zoom = +r.bossFx.zoom.toFixed(3);
    res.dist = b ? +Math.hypot(b.pos.x - p.pos.x, b.pos.y - p.pos.y).toFixed(2) : -1;
    res.bossHp = b ? b.hp : -1;
    return res;
  });
  const last = sample.feet[sample.feet.length - 1];
  const lastHead = sample.head[sample.head.length - 1];
  const offscreen = sample.feet.filter(([x, y]) => Math.abs(x) > 1 || Math.abs(y) > 1).length;
  const bothOff = sample.feet.filter(([, y], i) =>
    (Math.abs(sample.feet[i][0]) > 1 || Math.abs(y) > 1)
    && (Math.abs(sample.head[i][0]) > 1 || Math.abs(sample.head[i][1]) > 1)).length;
  console.log(`engaged dist=${sample.dist} bias=${sample.bias} drop=${sample.drop} zoom=${sample.zoom}`);
  console.log(`feet NDC last=[${last}] head NDC last=[${lastHead}]`);
  console.log(`frames sampled=${sample.frames} feetOff=${offscreen} fullyOff=${bothOff}`);
  await page.screenshot({ path: `${out}.png` });
  writeFileSync(`${out}.json`, JSON.stringify({ floor, sample, offscreen, bothOff, census: census() }, null, 2));
  console.log(`wrote ${out}.png / .json  foreign=${census().foreign}`);
  console.log(offscreen > 0 ? "REPRODUCED: player off-screen during boss borrow" : "NOT reproduced");
} finally {
  await browser.close();
}
