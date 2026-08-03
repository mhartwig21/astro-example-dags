// Independent acceptance critique, round 1 (art direction).
// ONE Chromium, sequential, three viewports. Captures every screen trk-screens
// owns, MEASURES scrollHeight-clientHeight on each, and samples the type/panel
// tokens so "does it read as one product" can be answered with numbers.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = process.argv[2] || "shots/ad-r1";
const BASE = "http://localhost:5284";
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [{ w: 1366, h: 768 }, { w: 1600, h: 900 }, { w: 2560, h: 1440 }];
const report = [];
const push = (k, v) => { report.push([k, typeof v === "string" ? v : JSON.stringify(v)]); };

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

  const settled = async () => {
    await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1",
      null, { timeout: 200000 }).catch(() => {});
    await page.waitForFunction(() => {
      const l = document.getElementById("loading"); if (!l) return true;
      const cs = getComputedStyle(l);
      return l.classList.contains("done") || cs.display === "none" || Number(cs.opacity) === 0;
    }, null, { timeout: 200000 }).catch(() => {});
    await page.waitForTimeout(3200);
    const b = await page.evaluate(() => {
      const l = document.getElementById("loading"); if (!l) return null;
      const cs = getComputedStyle(l);
      if (cs.display === "none" || Number(cs.opacity) === 0) return null;
      const r = l.getBoundingClientRect(); return { w: r.width, h: r.height };
    });
    if (b) throw new Error(`ASSERT: #loading still boxed ${JSON.stringify(b)}`);
  };

  // FIT + TOKENS in one probe. `over` is the owner's pass/fail number.
  const probe = await page.evaluateHandle(() => {}).then(() => null);
  const measure = async (rootSel) => page.evaluate((rs) => {
    const root = document.querySelector(rs);
    if (!root) return { missing: true };
    const rcs = getComputedStyle(root);
    if (rcs.display === "none" || Number(rcs.opacity) === 0) return { hidden: true };
    const panel = root.querySelector(".panel") || root;
    const pr = panel.getBoundingClientRect();
    const pcs = getComputedStyle(panel);
    const scrollers = [];
    for (const el of [root, panel, ...root.querySelectorAll("*")]) {
      const o = el.scrollHeight - el.clientHeight;
      const ov = getComputedStyle(el).overflowY;
      if (o > 2 && ov !== "visible") {
        scrollers.push(`${el.id ? "#" + el.id : "." + String(el.className).split(" ")[0]}[${ov}]:+${o}`);
      }
    }
    const fnt = (sel) => {
      const e = root.querySelector(sel); if (!e) return null;
      const c = getComputedStyle(e);
      return `${c.fontFamily.split(",")[0].replace(/["']/g, "")}/${c.fontSize}/${c.fontWeight}/${c.letterSpacing}/${c.textTransform}`;
    };
    return {
      // documentElement overflow is the real "did a scrollbar appear" test
      docOver: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      bodyOver: document.body.scrollHeight - document.body.clientHeight,
      rootOver: root.scrollHeight - root.clientHeight,
      panelOver: panel.scrollHeight - panel.clientHeight,
      box: `${Math.round(pr.width)}x${Math.round(pr.height)}@${Math.round(pr.x)},${Math.round(pr.y)}`,
      bottomGap: Math.round(innerHeight - pr.bottom),
      topGap: Math.round(pr.y),
      scrollers,
      tok: {
        bg: pcs.backgroundColor, bimg: pcs.backgroundImage.slice(0, 60),
        border: pcs.borderTopWidth + " " + pcs.borderTopStyle + " " + pcs.borderTopColor,
        radius: pcs.borderRadius, pad: pcs.padding, shadow: pcs.boxShadow.slice(0, 70),
      },
      type: { h: fnt("h1") || fnt("h2"), hint: fnt(".hint"), body: fnt("p") || fnt("div") },
    };
  }, rootSel);

  const rec = async (name, sel, note = "") => {
    const m = await measure(sel);
    push(`${name} ${tag}`, note ? { ...m, note } : m);
    return m;
  };

  // ================= 1. LOADING (deliberately captured early) =================
  await page.goto(`${BASE}/iso.html?eagerassets`, { waitUntil: "commit", timeout: 90000 });
  await page.waitForTimeout(1400);
  const lvis = await page.evaluate(() => {
    const l = document.getElementById("loading");
    if (!l) return "absent";
    const cs = getComputedStyle(l);
    return { display: cs.display, opacity: cs.opacity, h: Math.round(l.getBoundingClientRect().height) };
  });
  if (lvis !== "absent" && lvis.display !== "none" && Number(lvis.opacity) > 0.5) {
    await shot("loading");
    await rec("loading", "#loading", "captured EARLY on purpose");
  } else { push(`loading ${tag}`, `MISSED — ${JSON.stringify(lvis)}`); }

  // ================= 2. MENU (the front door) =================
  await page.goto(`${BASE}/iso.html?eagerassets&clean=1`, { waitUntil: "load", timeout: 90000 });
  await settled();
  await page.evaluate(() => { for (const a of document.getAnimations()) a.finish(); }).catch(() => {});
  await page.waitForTimeout(400);
  const menuUp = await page.evaluate(() => getComputedStyle(document.getElementById("menu")).display !== "none");
  if (menuUp) {
    await shot("menu");
    await rec("menu", "#menu");
    const comp = await page.evaluate(() => {
      const p = document.querySelector("#menu .panel"); const r = p.getBoundingClientRect();
      const t = [...document.querySelectorAll("#menu .m-tile")].filter((x) => getComputedStyle(x).display !== "none")
        .map((x) => { const b = x.getBoundingClientRect(); return `${x.id}:${Math.round(b.width)}x${Math.round(b.height)}`; });
      const seen = new Set(); let dead = 0;
      // how much of the frame is pure background (crude "is the art doing work")
      return { panelPctW: Math.round((r.width / innerWidth) * 100), panelX: Math.round(r.x),
        tiles: t, tileCount: t.length, canvasFree: Math.round(r.x) };
    });
    push(`menu composition ${tag}`, comp);
    // party form open (the only in-menu state change we own)
    await page.click("#m-party").catch(() => {});
    await page.waitForTimeout(500);
    await shot("menu-party");
    await rec("menu-party", "#menu");
    await page.click("#m-party").catch(() => {});
  } else { push(`menu ${tag}`, "MISSED — #menu not displayed"); }

  // ================= 3. IN-RUN: staged via test mode + debug hook =============
  await page.goto(`${BASE}/iso.html?test&floor=6&level=12&abilities=all&gold=5000&seed=42&eagerassets&debug=1`,
    { waitUntil: "load", timeout: 90000 });
  await settled();

  // --- 3a. the HUD, incl. #skills (the ability bar) ---
  await page.evaluate(() => { for (const a of document.getAnimations()) a.finish(); }).catch(() => {});
  await shot("hud");
  push(`skills ${tag}`, await page.evaluate(() => {
    const s = document.getElementById("skills"); if (!s) return "absent";
    const r = s.getBoundingClientRect(); const cs = getComputedStyle(s);
    const slots = [...s.children].map((c) => { const b = c.getBoundingClientRect(); return `${Math.round(b.width)}x${Math.round(b.height)}`; });
    return { box: `${Math.round(r.width)}x${Math.round(r.height)}@${Math.round(r.x)},${Math.round(r.y)}`,
      over: s.scrollHeight - s.clientHeight, slots, gap: cs.gap, bottomGap: Math.round(innerHeight - r.bottom) };
  }));

  // --- 3b. modal panels by hotkey ---
  for (const [key, sel, name] of [["p", "#sheet", "sheet"], ["i", "#inv", "inv"],
                                  ["t", "#abil", "abil"], ["k", "#keys", "keys"]]) {
    await page.keyboard.press(key, { delay: 500 });
    await page.waitForTimeout(1400);
    await page.evaluate((s) => {
      const e = document.querySelector(s); if (!e) return;
      e.style.animation = "none";
      const p = e.querySelector(".panel"); if (p) p.style.animation = "none";
      for (const a of document.getAnimations()) a.finish();
    }, sel).catch(() => {});
    await page.waitForTimeout(300);
    const vis = await page.evaluate((s) => {
      const e = document.querySelector(s); const cs = getComputedStyle(e);
      return { display: cs.display, opacity: cs.opacity };
    }, sel);
    if (vis.display === "none" || Number(vis.opacity) < 0.9) {
      push(`${name} ${tag}`, `MISSED — ${JSON.stringify(vis)}`);
      continue;
    }
    await shot(name);
    await rec(name, sel);

    if (name === "abil") {
      await page.click('#abil .amode[data-view="graph"]').catch(() => {});
      await page.waitForTimeout(700);
      await shot("abil-chart"); await rec("abil-chart", "#abil");
      await page.click('#abil .apage[data-page="ach"]').catch(() => {});
      await page.waitForTimeout(700);
      const achUp = await page.evaluate(() => getComputedStyle(document.getElementById("ach-section")).display !== "none");
      if (achUp) { await shot("ach-section"); await rec("ach-section", "#abil"); }
      else push(`ach-section ${tag}`, "MISSED — pane never shown");
      await page.click('#abil .apage[data-page="stats"]').catch(() => {});
      await page.waitForTimeout(600);
      await shot("abil-stats"); await rec("abil-stats", "#abil");
      await page.click('#abil .amode[data-view="list"]').catch(() => {});
    }
    if (name === "keys") {
      for (const t of ["prefs", "credits"]) {
        await page.click(`#keys [data-kbtab="${t}"]`).catch(() => {});
        await page.waitForTimeout(600);
        await shot(`keys-${t}`); await rec(`keys-${t}`, "#keys");
      }
      await page.click(`#keys [data-kbtab="keys"]`).catch(() => {});
    }
    await page.keyboard.press("Escape", { delay: 450 });
    await page.waitForTimeout(900);
  }

  // --- 3c. TUTORIAL card: push a real kind:"tip" announcement through the host
  const tipOk = await page.evaluate(() => {
    const s = window.__dcc?.state; if (!s) return "no __dcc";
    s.announcements.push({ text: "COURTESY EXPLANATION: that stairwell is sealed until the floor boss is dead. The System does not accept complaints about doors.", kind: "tip", priority: "normal" });
    return "pushed";
  });
  await page.waitForTimeout(2500);
  const tutUp = await page.evaluate(() => {
    const t = document.getElementById("tutorial");
    return t && getComputedStyle(t).display !== "none" && t.childElementCount > 0;
  });
  if (tutUp) { await shot("tutorial"); await rec("tutorial", "#tutorial"); }
  else push(`tutorial ${tag}`, `MISSED — ${tipOk}, card never mounted`);

  // --- 3d. QUESTS ledger: display-only render, staged roam state
  const qOk = await page.evaluate(() => {
    const s = window.__dcc?.state; if (!s) return "no __dcc";
    s.runKind = "roam";
    s.quests = [
      { id: 1, key: "q1", title: "Thin the Nest", state: "active", objective: { kind: "killTribe", tribe: "kobold", target: 8, killed: 5 } },
      { id: 2, key: "q2", title: "Light the Old Road", state: "active", objective: { kind: "beacons", spots: [{ x: 0, y: 0, lit: true }, { x: 0, y: 0, lit: true }, { x: 0, y: 0, lit: false }] } },
      { id: 3, key: "q3", title: "A Parcel for Mordecai", state: "offered", objective: { kind: "killTribe", tribe: "goblin", target: 4, killed: 0 } },
    ];
    return "staged";
  });
  await page.waitForTimeout(1500);
  const qUp = await page.evaluate(() => {
    const q = document.getElementById("quests");
    return q && getComputedStyle(q).display !== "none" && q.getBoundingClientRect().height > 10;
  });
  if (qUp) { await shot("quests"); await rec("quests", "#quests"); }
  else push(`quests ${tag}`, `MISSED — ${qOk}, tracker never shown`);
  await page.evaluate(() => { const s = window.__dcc?.state; if (s) { s.runKind = "dungeon"; s.quests = []; } });
  await page.waitForTimeout(600);

  // --- 3e. PARTY roster chip (network-only by design; probe honestly)
  const partyState = await page.evaluate(() => {
    const p = document.getElementById("party");
    const cs = getComputedStyle(p);
    return { display: cs.display, html: (p.innerHTML || "").length, kids: p.childElementCount };
  });
  push(`party ${tag}`, `NOT REACHABLE single-player (net-only render path, main3d.ts:9712) — ${JSON.stringify(partyState)}`);

  // --- 3f. SAFE ROOM + the DRAFT it generates (real rewards, not fabricated)
  await page.evaluate(() => {
    const s = window.__dcc?.state; if (!s) return;
    const p = s.players[0]; p.pos.x = s.map.stairs.x; p.pos.y = s.map.stairs.y;
  });
  await page.waitForTimeout(1200);
  for (let i = 0; i < 5; i++) {
    await page.keyboard.press("e", { delay: 800 });
    await page.waitForTimeout(2500);
    if (await page.evaluate(() => !!window.__dcc?.state?.safeRoom)) break;
  }
  const draftUp = await page.evaluate(() => getComputedStyle(document.getElementById("draft")).display === "flex");
  if (draftUp) {
    await page.evaluate(() => { document.getElementById("draft").style.animation = "none"; for (const a of document.getAnimations()) a.finish(); });
    await page.waitForTimeout(400);
    await shot("draft");
    await rec("draft", "#draft", "REAL rewards from the sim, not fabricated copy");
    await page.keyboard.press("Escape", { delay: 450 });
    await page.waitForTimeout(800);
  } else { push(`draft ${tag}`, "MISSED — no draft opened on safe-room entry"); }

  const srUp = await page.evaluate(() => getComputedStyle(document.getElementById("saferoom")).display !== "none");
  if (srUp) {
    await page.evaluate(() => { document.getElementById("saferoom").style.animation = "none"; for (const a of document.getAnimations()) a.finish(); });
    await page.waitForTimeout(500);
    await shot("saferoom"); await rec("saferoom", "#saferoom");
    for (const [tabSel, nm] of [["#sr-tab-chase", "saferoom-chase"], ["#sr-tab-ach", "saferoom-ach"]]) {
      await page.click(tabSel).catch(() => {});
      await page.waitForTimeout(900);
      await shot(nm); await rec(nm, "#saferoom");
    }
  } else { push(`saferoom ${tag}`, "MISSED — safe room never opened"); }

  await page.close();
}

// ================= 4. ROTATE gate (phone portrait only) =================
{
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  page.setDefaultTimeout(180000);
  const cdp = await page.context().newCDPSession(page);
  await page.goto(`${BASE}/iso.html?eagerassets&clean=1`, { waitUntil: "commit", timeout: 90000 });
  await page.waitForTimeout(6000);
  const rot = await page.evaluate(() => {
    const r = document.getElementById("rotate"); if (!r) return "absent";
    const cs = getComputedStyle(r); const b = r.getBoundingClientRect();
    return { display: cs.display, opacity: cs.opacity, box: `${Math.round(b.width)}x${Math.round(b.height)}`,
      over: r.scrollHeight - r.clientHeight, docOver: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      text: (r.textContent || "").trim().replace(/\s+/g, " ").slice(0, 120) };
  });
  if (rot !== "absent" && rot.display !== "none") {
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${OUT}/rotate-390x844.png`, Buffer.from(data, "base64"));
    push("rotate 390x844", rot);
  } else { push("rotate 390x844", `MISSED — ${JSON.stringify(rot)}`); }
  await page.close();
}

} finally { await browser.close(); }

console.log("\n=========== AD critique r1 — measurements ===========");
for (const [k, v] of report) console.log(`\n--- ${k}\n${v}`);
writeFileSync(`${OUT}/measurements.json`, JSON.stringify(report, null, 1));
