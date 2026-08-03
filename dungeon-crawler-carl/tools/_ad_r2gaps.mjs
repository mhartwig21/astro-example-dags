// The three frames the main r2 pass could not take, and WHY they could not.
// ONE Chromium, three viewports, sequential. Run after _ad_r2.mjs, never with it.
//
//  · #tutorial — `step()` clears `state.announcements` every tick, so a single
//    push between frames is wiped before the host drains it (this is why r1 and
//    r2 both reported "card never mounted"). The fix is to keep pushing until
//    the host has actually mounted the card: the announcement is a real
//    kind:"tip", it goes through showAnnouncement -> showTutorialCard, and the
//    card on screen is the product's card with the product's copy. Nothing is
//    drawn by the harness.
//
//  · #saferoom / #draft — sim/game.ts:7996: `state.monsters.some(m => m.kind
//    === "boss")` blocks descent, and floor 6 has a boss, so eight presses of E
//    could never open the shop. The harness kills the floor's monsters through
//    the debug hook and then presses E: the safe room, its stock, its prices
//    and its draft all come from the real generator.
//
//  · #rotate — main3d.ts:89 reads `screen.width/height` for `isPhone`, and
//    Chromium under device emulation reports the HOST screen, so `body.phone`
//    was never added and the gate could not show. `?phone=1` is the documented
//    headless hook. See tools/_ad_r2rotate.mjs.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = process.argv[2] || "shots/ad-r2";
const BASE = "http://localhost:5284";
mkdirSync(OUT, { recursive: true });
const report = [];
const push = (k, v) => report.push([k, typeof v === "string" ? v : JSON.stringify(v)]);

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
try {
for (const vp of [{ w: 1366, h: 768 }, { w: 1600, h: 900 }, { w: 2560, h: 1440 }]) {
  const tag = `${vp.w}x${vp.h}`;
  const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(240000);
  page.on("pageerror", (e) => console.error(`PAGE ERROR [${tag}]:`, e.message));
  const cdp = await page.context().newCDPSession(page);
  const shot = async (name, sel) => {
    await page.mouse.move(2, 2); await page.waitForTimeout(120);
    const ok = await page.evaluate((s) => {
      const e = document.querySelector(s);
      if (!e) return { ok: false, why: "absent" };
      const cs = getComputedStyle(e), r = e.getBoundingClientRect();
      if (cs.display === "none") return { ok: false, why: "display:none" };
      if (Number(cs.opacity) < 0.9) return { ok: false, why: `opacity ${cs.opacity}` };
      if (r.width < 8 || r.height < 8) return { ok: false, why: `box ${Math.round(r.width)}x${Math.round(r.height)}` };
      return { ok: true, box: `${Math.round(r.width)}x${Math.round(r.height)}` };
    }, sel);
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${OUT}/${ok.ok ? "" : "MISSED-"}${name}-${tag}.png`, Buffer.from(data, "base64"));
    push(`${name} ${tag}`, ok.ok ? `OK ${ok.box}` : `MISSED — ${ok.why}`);
    return ok.ok;
  };
  const fit = async (sel) => page.evaluate((s) => {
    const root = document.querySelector(s);
    if (!root) return { missing: true };
    const panel = root.querySelector(".panel") || root;
    const r = panel.getBoundingClientRect();
    let worst = 0; const over = [];
    for (const el of [root, panel, ...root.querySelectorAll("*")]) {
      const o = el.scrollHeight - el.clientHeight;
      if (o > 2 && getComputedStyle(el).overflowY !== "visible") {
        worst = Math.max(worst, o);
        over.push(`${el.id ? "#" + el.id : "." + String(el.className).split(" ")[0]}:+${o}`);
      }
    }
    const cs = getComputedStyle(panel);
    return { box: `${Math.round(r.width)}x${Math.round(r.height)}`,
      pctOfFrame: Math.round((r.width * r.height * 100) / (innerWidth * innerHeight)),
      budget: Math.round(parseFloat(cs.maxHeight)), over: Math.round(r.height - parseFloat(cs.maxHeight)),
      boxSizing: cs.boxSizing, worstDescendantOver: worst, scrollers: over };
  }, sel);
  const freeze = async () => {
    await page.evaluate(() => {
      for (const e of document.querySelectorAll("#saferoom,#draft,#tutorial")) {
        e.style.animation = "none";
        const p = e.querySelector(".panel"); if (p) p.style.animation = "none";
      }
      for (const a of document.getAnimations()) a.finish();
    }).catch(() => {});
    await page.waitForTimeout(200);
  };

  await page.goto(`${BASE}/iso.html?test&floor=6&level=12&abilities=all&gold=5000&seed=42&eagerassets&debug=1`,
    { waitUntil: "load", timeout: 120000 });
  await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1",
    null, { timeout: 200000 }).catch(() => {});
  await page.waitForFunction(() => {
    const l = document.getElementById("loading"); if (!l) return true;
    const cs = getComputedStyle(l);
    return l.classList.contains("done") || cs.display === "none" || Number(cs.opacity) === 0;
  }, null, { timeout: 200000 }).catch(() => {});
  await page.waitForTimeout(3200);

  // ---- TUTORIAL: keep the tip alive across the sim's per-tick announcement wipe
  const mounted = await page.evaluate(async () => {
    const line = "COURTESY EXPLANATION: that stairwell is sealed until the floor boss is dead. The System does not accept complaints about doors.";
    for (let i = 0; i < 200; i++) {
      const s = window.__dcc?.state; if (!s) return "no __dcc";
      if (document.querySelector("#tutorial .tut")) return "mounted";
      s.announcements.push({ text: line, kind: "tip", priority: "normal" });
      await new Promise((r) => setTimeout(r, 40));
    }
    return document.querySelector("#tutorial .tut") ? "mounted" : "never mounted";
  });
  push(`tutorial mount ${tag}`, mounted);
  await page.waitForTimeout(400);
  await freeze();
  await shot("tutorial", "#tutorial .tut-head");
  push(`tutorial fit ${tag}`, await fit("#tutorial"));
  await page.evaluate(() => { document.querySelector("#tutorial .tut")?.remove(); });

  // ---- SAFE ROOM: the boss seals the stairs (sim/game.ts) — put it down first
  const cleared = await page.evaluate(() => {
    const s = window.__dcc?.state; if (!s) return "no __dcc";
    const before = s.monsters.length;
    s.monsters.length = 0;
    const p = s.players[0]; p.pos.x = s.map.stairs.x; p.pos.y = s.map.stairs.y;
    return `cleared ${before} monsters, stood on the stairs`;
  });
  push(`safe-room staging ${tag}`, cleared);
  await page.waitForTimeout(1000);
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => {
      const s = window.__dcc?.state; if (!s) return;
      s.monsters.length = 0;
      const p = s.players[0]; p.pos.x = s.map.stairs.x; p.pos.y = s.map.stairs.y;
    });
    await page.keyboard.press("e", { delay: 700 });
    await page.waitForTimeout(1800);
    if (await page.evaluate(() => !!window.__dcc?.state?.safeRoom)) break;
  }
  push(`safe-room entry ${tag}`, await page.evaluate(() => ({
    safeRoom: !!window.__dcc?.state?.safeRoom, floor: window.__dcc?.state?.floor })));

  if (await page.evaluate(() => getComputedStyle(document.getElementById("draft")).display === "flex")) {
    await freeze();
    await shot("draft", "#draft .reward");
    push(`draft fit ${tag}`, await fit("#draft"));
    await page.keyboard.press("Escape", { delay: 450 });
    await page.waitForTimeout(800);
  } else { push(`draft ${tag}`, "MISSED — safe-room entry generated no reward draft"); }

  if (await page.evaluate(() => getComputedStyle(document.getElementById("saferoom")).display !== "none")) {
    await freeze();
    await shot("saferoom", "#saferoom .shop-body");
    push(`saferoom fit ${tag}`, await fit("#saferoom"));
    push(`saferoom title ${tag}`, await page.evaluate(() => {
      const h = document.querySelector("#saferoom h2"); const c = getComputedStyle(h);
      const tabs = document.querySelector("#saferoom .shop-tabs").getBoundingClientRect();
      const hr = h.getBoundingClientRect();
      return { spec: `${c.fontFamily.split(",")[0].replace(/["']/g, "")}/${c.fontSize}/${c.fontWeight}/${c.letterSpacing}`,
        titleOwnLine: hr.bottom <= tabs.top + 1 };
    }));
    for (const [sel, nm, want] of [["#sr-tab-chase", "saferoom-chase", "#sr-shelf"],
                                   ["#sr-tab-ach", "saferoom-ach", "#sr-ach .sr-ach"]]) {
      await page.click(sel).catch(() => {});
      await page.waitForTimeout(900); await freeze();
      await shot(nm, want);
      push(`${nm} fit ${tag}`, await fit("#saferoom"));
      if (nm === "saferoom-ach") {
        push(`ach layout SAFEROOM ${tag}`, await page.evaluate(() => {
          const g = document.getElementById("sr-ach"); const c = g.querySelector(".sr-ach");
          if (!c) return "no card";
          const r = c.getBoundingClientRect();
          return { cls: c.className, cols: getComputedStyle(g).gridTemplateColumns.split(" ").length,
            card: `${Math.round(r.width)}x${Math.round(r.height)}`,
            hasReward: !!c.querySelector(".areward, .claim-btn"),
            bg: getComputedStyle(c).backgroundColor };
        }));
      }
      if (nm === "saferoom-chase") {
        push(`tab underline ${tag}`, await page.evaluate(() => {
          const out = {};
          for (const [k, s] of [["shop", "#saferoom .shop-tabs .tab.active"],
                                ["sub", "#saferoom .shop-subtabs .tab.active"]]) {
            const e = document.querySelector(s); if (!e) continue;
            const c = getComputedStyle(e);
            out[k] = `${e.textContent.trim()} rule=${c.borderBottomColor} shadow=${c.boxShadow.slice(0, 24)}`;
          }
          return out;
        }));
      }
    }
  } else { push(`saferoom ${tag}`, "MISSED — safe room never opened"); }
  await page.close();
}
} catch (e) { push("RUN ABORTED", String(e.message).split(/\r?\n/)[0]); }
finally {
  await browser.close();
  for (const [k, v] of report) console.log(`\n--- ${k}\n${v}`);
  writeFileSync(`${OUT}/measurements-gaps.json`, JSON.stringify(report, null, 1));
}
