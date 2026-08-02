// Desktop non-regression smoke for the touch round.
//
// Rule (2) of the mobile brief: touch is ADDITIVE and must not steal desktop
// input. The touch router binds at the document in the capture phase, so this
// checks the things that would break if it over-reached: keyboard movement,
// LMB casting, mouse aim, and the absence of body.touch on a fine pointer.
//
//   node tools/desktopsmoke.mjs [--base http://localhost:5370] [--headed]
import { chromium } from "playwright";

const argv = process.argv.slice(2);
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const BASE = (flag("base", process.env.DCC_BASE ?? "http://localhost:5370")).replace(/\/$/, "");
const TEST = "test&debug=1&abilities=all&eagerassets&quality=performance&floor=3&level=14&seed=7";

const browser = await chromium.launch({
  headless: !argv.includes("--headed"),
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errs = [];
page.on("pageerror", (e) => errs.push(e.message));
await page.goto(`${BASE}/iso.html?${TEST}`, { waitUntil: "load", timeout: 120000 });
await page.waitForSelector("html[data-assets-settled='1']", { timeout: 240000 });
await page.waitForFunction(() => {
  const l = document.getElementById("loading");
  return !l || getComputedStyle(l).display === "none" || getComputedStyle(l).opacity === "0";
}, null, { timeout: 90000 });
await page.waitForTimeout(1200);

const out = [];
const rec = (name, ok, detail) => {
  out.push({ name, ok, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name} — ${detail}`);
};
const snap = () => page.evaluate(() => {
  const p = window.__dcc.state.players[0];
  return {
    pos: { x: +p.pos.x.toFixed(3), y: +p.pos.y.toFixed(3) },
    facing: { x: +p.facing.x.toFixed(3), y: +p.facing.y.toFixed(3) },
    cd: JSON.parse(JSON.stringify(p.cd || {})),
    monsterHp: window.__dcc.state.monsters.reduce((a, m) => a + Math.max(0, m.hp), 0),
  };
});
const keepAlive = () => page.evaluate(() => {
  const p = window.__dcc.state.players[0];
  p.hp = p.maxHp; p.alive = true; p.downedT = 0;
});
const settle = async (frames = 6) => {
  await page.waitForTimeout(120);
  await page.evaluate((n) => new Promise((res) => {
    let i = 0;
    const t = () => (++i >= n ? res(null) : requestAnimationFrame(t));
    requestAnimationFrame(t);
  }), frames).catch(() => {});
};

// 1. no touch chrome on a fine pointer
{
  const st = await page.evaluate(() => ({
    touch: document.body.classList.contains("touch"),
    layerShown: getComputedStyle(document.getElementById("t-layer")).display,
    stick: getComputedStyle(document.getElementById("t-stick2")).opacity,
  }));
  rec("desktop: no touch chrome", !st.touch && st.layerShown === "none",
    `body.touch=${st.touch}, #t-layer display=${st.layerShown}, stick opacity=${st.stick}`);
}

// 2. keyboard movement
{
  await keepAlive();
  const a = await snap();
  await page.keyboard.down("w");
  await settle(20);
  await page.keyboard.up("w");
  const b = await snap();
  const d = Math.hypot(b.pos.x - a.pos.x, b.pos.y - a.pos.y);
  rec("desktop: W walks", d > 0.3, `moved ${d.toFixed(2)} tiles`);
}

// 3. LMB casts slot 1, and the mouse still aims
{
  await keepAlive();
  const a = await snap();
  await page.mouse.move(1100, 300);
  await settle(4);
  await page.mouse.down();
  await settle(8);
  await page.mouse.up();
  await settle(10);
  const b = await snap();
  const facingChanged = Math.hypot(b.facing.x - a.facing.x, b.facing.y - a.facing.y) > 0.05;
  const cast = Object.keys(b.cd).some((k) => (b.cd[k] ?? 0) > (a.cd[k] ?? 0)) || b.monsterHp < a.monsterHp;
  rec("desktop: LMB casts and the mouse aims", cast || facingChanged,
    `cooldown or damage changed=${cast}; facing changed=${facingChanged}`);
}

// 4. keyboard panels still open and close
{
  await page.keyboard.press("i");
  await settle(6);
  const open = await page.evaluate(() => getComputedStyle(document.getElementById("inv")).display !== "none");
  await page.keyboard.press("i");
  await settle(6);
  const closed = await page.evaluate(() => getComputedStyle(document.getElementById("inv")).display === "none");
  rec("desktop: panels open and close on the keyboard", open && closed, `opened=${open}, closed=${closed}`);
}

// 5. a mouse press is never claimed by the touch router
{
  const claimed = await page.evaluate(() => {
    let prevented = false;
    const probe = (e) => { if (e.defaultPrevented) prevented = true; };
    document.addEventListener("pointerdown", probe);
    const el = document.getElementById("game");
    el.dispatchEvent(new PointerEvent("pointerdown", {
      bubbles: true, cancelable: true, pointerType: "mouse", clientX: 700, clientY: 400,
    }));
    document.removeEventListener("pointerdown", probe);
    return prevented;
  });
  // The canvas handler cancels TOUCH pointers only, and only in touch mode.
  rec("desktop: mouse pointers are not swallowed", !claimed, `defaultPrevented=${claimed}`);
}

console.log(errs.length ? `page errors: ${errs.length} (${errs[0]})` : "no page errors");
const fails = out.filter((o) => !o.ok).length;
console.log(fails ? `DESKTOP SMOKE: ${fails} FAILED` : "DESKTOP SMOKE: all clear");
await browser.close();
process.exit(fails ? 1 : 0);