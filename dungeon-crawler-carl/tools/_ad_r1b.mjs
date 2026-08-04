// AD critique r1, pass 2: the screens pass 1 could not reach on a boss floor.
// floor=2 so the stairs are NOT boss-sealed -> safe room + the real draft it
// generates. Also re-tries the contract ledger at 1600/2560 and the tip card.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = process.argv[2] || "shots/ad-r1";
const BASE = "http://localhost:5284";
mkdirSync(OUT, { recursive: true });
const VIEWPORTS = [{ w: 1366, h: 768 }, { w: 1600, h: 900 }, { w: 2560, h: 1440 }];
const report = [];
const push = (k, v) => report.push([k, typeof v === "string" ? v : JSON.stringify(v)]);

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
try {
for (const vp of VIEWPORTS) {
  const tag = `${vp.w}x${vp.h}`;
  const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(240000);
  page.on("pageerror", (e) => console.error(`PAGE ERROR [${tag}]:`, e.message));
  const cdp = await page.context().newCDPSession(page);
  const shot = async (n) => {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${OUT}/${n}-${tag}.png`, Buffer.from(data, "base64"));
  };
  const measure = async (rs) => page.evaluate((s) => {
    const root = document.querySelector(s); if (!root) return { missing: true };
    const rcs = getComputedStyle(root);
    if (rcs.display === "none" || Number(rcs.opacity) === 0) return { hidden: true };
    const panel = root.querySelector(".panel") || root;
    const r = panel.getBoundingClientRect(); const pcs = getComputedStyle(panel);
    const scrollers = [];
    for (const el of [root, panel, ...root.querySelectorAll("*")]) {
      const o = el.scrollHeight - el.clientHeight; const ov = getComputedStyle(el).overflowY;
      if (o > 2 && ov !== "visible") scrollers.push(`${el.id ? "#" + el.id : "." + String(el.className).split(" ")[0]}[${ov}]:+${o}`);
    }
    const fnt = (q) => { const e = root.querySelector(q); if (!e) return null; const c = getComputedStyle(e);
      return `${c.fontFamily.split(",")[0].replace(/["']/g, "")}/${c.fontSize}/${c.fontWeight}/${c.letterSpacing}`; };
    return { docOver: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      bodyOver: document.body.scrollHeight - document.body.clientHeight,
      rootOver: root.scrollHeight - root.clientHeight, panelOver: panel.scrollHeight - panel.clientHeight,
      box: `${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.x)},${Math.round(r.y)}`,
      topGap: Math.round(r.y), bottomGap: Math.round(innerHeight - r.bottom), scrollers,
      tok: { bg: pcs.backgroundColor, border: `${pcs.borderTopWidth} ${pcs.borderTopColor}`,
        radius: pcs.borderRadius, pad: pcs.padding },
      type: { h: fnt("h1") || fnt("h2"), hint: fnt(".hint") } };
  }, rs);
  const settled = async () => {
    await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 200000 }).catch(() => {});
    await page.waitForFunction(() => { const l = document.getElementById("loading"); if (!l) return true;
      const cs = getComputedStyle(l); return l.classList.contains("done") || cs.display === "none" || Number(cs.opacity) === 0;
    }, null, { timeout: 200000 }).catch(() => {});
    await page.waitForTimeout(3200);
    const b = await page.evaluate(() => { const l = document.getElementById("loading"); if (!l) return null;
      const cs = getComputedStyle(l); if (cs.display === "none" || Number(cs.opacity) === 0) return null;
      const r = l.getBoundingClientRect(); return { w: r.width, h: r.height }; });
    if (b) throw new Error(`ASSERT: #loading still boxed ${JSON.stringify(b)}`);
  };

  await page.goto(`${BASE}/iso.html?test&floor=2&level=8&abilities=all&gold=5000&seed=7&eagerassets&debug=1`,
    { waitUntil: "load", timeout: 90000 });
  await settled();

  // --- TUTORIAL: cast BOLT once; sim fires the first-contact tip for real.
  const tutBoot = await page.evaluate(() => {
    const t = document.getElementById("tutorial");
    return !!t && getComputedStyle(t).display !== "none" && t.childElementCount > 0;
  });
  if (!tutBoot) { await page.keyboard.press("q", { delay: 500 }); await page.waitForTimeout(2500); }
  const tutUp = await page.evaluate(() => {
    const t = document.getElementById("tutorial");
    return !!t && getComputedStyle(t).display !== "none" && t.childElementCount > 0;
  });
  if (tutUp) {
    await shot("tutorial");
    push(`tutorial ${tag}`, { ...(await measure("#tutorial")), how: tutBoot ? "fired at boot" : "fired by casting bolt (real sim tip)" });
    await page.click("#tutorial .tut-dismiss").catch(() => {});
    await page.waitForTimeout(600);
  } else push(`tutorial ${tag}`, "MISSED — no tip card");

  // --- QUESTS ledger (display-only render off staged roam state)
  await page.evaluate(() => {
    const s = window.__dcc?.state; if (!s) return;
    s.runKind = "roam";
    s.quests = [
      { id: 1, key: "q1", title: "Thin the Nest", state: "active", objective: { kind: "killTribe", tribe: "kobold", target: 8, killed: 5 } },
      { id: 2, key: "q2", title: "Light the Old Road", state: "active", objective: { kind: "beacons", spots: [{ x: 0, y: 0, lit: true }, { x: 0, y: 0, lit: true }, { x: 0, y: 0, lit: false }] } },
      { id: 3, key: "q3", title: "A Parcel for Mordecai", state: "offered", objective: { kind: "killTribe", tribe: "goblin", target: 4, killed: 0 } },
    ];
  });
  await page.waitForTimeout(2000);
  const qUp = await page.evaluate(() => { const q = document.getElementById("quests");
    return !!q && getComputedStyle(q).display !== "none" && q.getBoundingClientRect().height > 10; });
  if (qUp) { await shot("quests"); push(`quests ${tag}`, await measure("#quests")); }
  else push(`quests ${tag}`, "MISSED — tracker never shown");
  await page.evaluate(() => { const s = window.__dcc?.state; if (s) { s.runKind = "dungeon"; s.quests = []; } });
  await page.waitForTimeout(800);

  // --- SAFE ROOM + the DRAFT the sim generates on entry (real rewards)
  await page.evaluate(() => { const s = window.__dcc?.state; if (!s) return;
    const p = s.players[0]; p.pos.x = s.map.stairs.x; p.pos.y = s.map.stairs.y; });
  await page.waitForTimeout(1200);
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press("e", { delay: 800 });
    await page.waitForTimeout(2500);
    if (await page.evaluate(() => !!window.__dcc?.state?.safeRoom)) break;
  }
  push(`safe-room reached ${tag}`, await page.evaluate(() => ({
    safeRoom: !!window.__dcc?.state?.safeRoom,
    draft: getComputedStyle(document.getElementById("draft")).display,
    sr: getComputedStyle(document.getElementById("saferoom")).display })));

  if (await page.evaluate(() => getComputedStyle(document.getElementById("draft")).display === "flex")) {
    await page.evaluate(() => { document.getElementById("draft").style.animation = "none";
      for (const a of document.getAnimations()) a.finish(); });
    await page.waitForTimeout(400);
    await shot("draft");
    push(`draft ${tag}`, { ...(await measure("#draft")),
      cards: await page.evaluate(() => [...document.querySelectorAll("#draft .reward")].map((c) => {
        const b = c.getBoundingClientRect(); return `${Math.round(b.width)}x${Math.round(b.height)}`; })) });
    await page.keyboard.press("Escape", { delay: 450 });
    await page.waitForTimeout(900);
  } else push(`draft ${tag}`, "MISSED — no draft on safe-room entry");

  if (await page.evaluate(() => getComputedStyle(document.getElementById("saferoom")).display !== "none")) {
    await page.evaluate(() => { document.getElementById("saferoom").style.animation = "none";
      for (const a of document.getAnimations()) a.finish(); });
    await page.waitForTimeout(600);
    await shot("saferoom"); push(`saferoom ${tag}`, await measure("#saferoom"));
    for (const [sel, nm] of [["#sr-tab-chase", "saferoom-chase"], ["#sr-tab-ach", "saferoom-ach"]]) {
      await page.click(sel).catch(() => {});
      await page.waitForTimeout(1000);
      await shot(nm); push(`${nm} ${tag}`, await measure("#saferoom"));
    }
  } else push(`saferoom ${tag}`, "MISSED — never opened");

  await page.close();
}
} finally { await browser.close(); }
console.log("\n=========== AD critique r1 pass 2 ===========");
for (const [k, v] of report) console.log(`\n--- ${k}\n${v}`);
writeFileSync(`${OUT}/measurements-pass2.json`, JSON.stringify(report, null, 1));
