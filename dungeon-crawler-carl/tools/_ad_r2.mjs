// trk-screens ROUND 2 verification. ONE Chromium, sequential, three viewports.
//
// Two things r1's harness could not answer and this one must:
//   1. FIT is `scrollHeight - clientHeight` on EVERY descendant, not just the
//      panel — r1's #abil reported panelOver:0 while .apane hid +2708px.
//   2. A frame must visibly contain what it claims. Every shot is gated on a
//      predicate that asserts the subject is on screen and boxed; a failed
//      predicate writes MISSED-*.png instead, and says why.
//
// It also parks the mouse at (2,2) before every capture, because a stuck
// :hover from an earlier click is indistinguishable from a styling bug in a
// screenshot (r1 reported the "Shift / Ctrl" chip as a stuck focus state).
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";

const OUT = process.argv[2] || "shots/ad-r2";
const BASE = "http://localhost:5284";
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [{ w: 1366, h: 768 }, { w: 1600, h: 900 }, { w: 2560, h: 1440 }];
const report = [];
const push = (k, v) => { report.push([k, typeof v === "string" ? v : JSON.stringify(v)]); };
// A probe that throws must not cost the other 60 measurements (r2: a null
// .sr-ach at one viewport took the whole run down before it wrote anything).
const firstLine = (m) => String(m).split(/\r?\n/)[0];
const probe = async (k, fn) => {
  try { push(k, await fn()); } catch (e) { push(k, `PROBE FAILED — ${firstLine(e.message)}`); }
};
const writeReport = () => {
  console.log("\n=========== trk-screens r2 — measurements ===========");
  for (const [k, v] of report) console.log(`\n--- ${k}\n${v}`);
  writeFileSync(`${OUT}/measurements.json`, JSON.stringify(report, null, 1));
};

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

  // A shot is only written if `sel` is really on screen with a real box.
  const shot = async (name, sel) => {
    await page.mouse.move(2, 2);
    await page.waitForTimeout(120);
    const ok = sel ? await page.evaluate((s) => {
      const e = document.querySelector(s);
      if (!e) return { ok: false, why: "absent" };
      const cs = getComputedStyle(e), r = e.getBoundingClientRect();
      if (cs.display === "none") return { ok: false, why: "display:none" };
      if (Number(cs.opacity) < 0.9) return { ok: false, why: `opacity ${cs.opacity}` };
      if (r.width < 8 || r.height < 8) return { ok: false, why: `box ${r.width}x${r.height}` };
      if (r.bottom < 0 || r.top > innerHeight) return { ok: false, why: "off screen" };
      return { ok: true, box: `${Math.round(r.width)}x${Math.round(r.height)}` };
    }, sel) : { ok: true };
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
    const file = ok.ok ? `${OUT}/${name}-${tag}.png` : `${OUT}/MISSED-${name}-${tag}.png`;
    writeFileSync(file, Buffer.from(data, "base64"));
    if (!ok.ok) push(`${name} ${tag}`, `MISSED — ${ok.why}`);
    return ok.ok;
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

  const measure = async (rootSel) => page.evaluate((rs) => {
    const root = document.querySelector(rs);
    if (!root) return { missing: true };
    const rcs = getComputedStyle(root);
    if (rcs.display === "none" || Number(rcs.opacity) === 0) return { hidden: true };
    const panel = root.querySelector(".panel") || root;
    const pr = panel.getBoundingClientRect();
    const pcs = getComputedStyle(panel);
    // EVERY descendant, not just the panel: this is the number r1 missed.
    const over = [];
    let worst = 0;
    for (const el of [root, panel, ...root.querySelectorAll("*")]) {
      const o = el.scrollHeight - el.clientHeight;
      const ov = getComputedStyle(el).overflowY;
      if (o > 2 && ov !== "visible") {
        worst = Math.max(worst, o);
        over.push(`${el.id ? "#" + el.id : "." + String(el.className).split(" ")[0]}[${ov}]:+${o}`);
      }
    }
    const fnt = (sel) => {
      const e = root.querySelector(sel); if (!e) return null;
      const c = getComputedStyle(e);
      return `${c.fontFamily.split(",")[0].replace(/["']/g, "")}/${c.fontSize}/${c.fontWeight}/${c.letterSpacing}`;
    };
    return {
      docOver: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      panelOver: panel.scrollHeight - panel.clientHeight,
      worstDescendantOver: worst,
      scrollers: over,
      box: `${Math.round(pr.width)}x${Math.round(pr.height)}@${Math.round(pr.x)},${Math.round(pr.y)}`,
      pctOfFrame: Math.round((pr.width * pr.height * 100) / (innerWidth * innerHeight)),
      bottomGap: Math.round(innerHeight - pr.bottom),
      tok: { bg: pcs.backgroundColor, bimg: pcs.backgroundImage.slice(0, 46),
        radius: pcs.borderRadius, pad: pcs.padding },
      title: fnt("h1") || fnt("h2"),
    };
  }, rootSel);

  const rec = async (name, sel, note = "") => {
    const m = await measure(sel);
    push(`${name} ${tag}`, note ? { ...m, note } : m);
    return m;
  };
  const freeze = async () => {
    await page.evaluate(() => {
      for (const e of document.querySelectorAll("#inv,#abil,#sheet,#keys,#saferoom,#draft,#menu,#loading")) {
        e.style.animation = "none";
        const p = e.querySelector(".panel"); if (p) p.style.animation = "none";
      }
      for (const a of document.getAnimations()) a.finish();
    }).catch(() => {});
    await page.waitForTimeout(220);
  };

  // ============ 1. LOADING (deliberately captured EARLY) ============
  await page.goto(`${BASE}/iso.html?eagerassets`, { waitUntil: "commit", timeout: 90000 });
  await page.waitForTimeout(1500);
  await shot("loading", "#loading .l-title");
  push(`loading ${tag}`, {
    ...(await measure("#loading")),
    frame: await page.evaluate(() => {
      const f = document.querySelector("#loading .l-frame");
      if (!f) return "absent";
      const r = f.getBoundingClientRect();
      const t = document.querySelector("#loading .l-title");
      return { frame: `${Math.round(r.width)}x${Math.round(r.height)}`,
        framePctOfViewport: Math.round((r.width * r.height * 100) / (innerWidth * innerHeight)),
        titlePx: getComputedStyle(t).fontSize, border: getComputedStyle(f).borderTopWidth };
    }),
    note: "captured EARLY on purpose — this IS the loading screen",
  });

  // ============ 2. MENU — the front door ============
  await page.goto(`${BASE}/iso.html?eagerassets&clean=1`, { waitUntil: "load", timeout: 90000 });
  await settled();
  await freeze();
  await shot("menu", "#menu .panel");
  await rec("menu", "#menu");
  push(`menu composition ${tag}`, await page.evaluate(() => {
    const box = (s) => { const e = document.querySelector(s); if (!e) return null;
      const cs = getComputedStyle(e); if (cs.display === "none") return "hidden";
      const r = e.getBoundingClientRect();
      return `${Math.round(r.width)}x${Math.round(r.height)}`; };
    const p = document.querySelector("#menu .panel").getBoundingClientRect();
    const goldFilled = [...document.querySelectorAll("#menu button")].filter((b) => {
      if (getComputedStyle(b).display === "none") return false;
      const bg = getComputedStyle(b).backgroundImage;
      return /#ffd970|255, 217, 112/.test(bg);
    }).map((b) => b.id || b.className);
    const titleColours = [...new Set([...document.querySelectorAll("#menu .m-tile b")]
      .filter((b) => b.offsetParent).map((b) => getComputedStyle(b).color))];
    return {
      panel: `${Math.round(p.width)}x${Math.round(p.height)}@${Math.round(p.x)}`,
      firePct: Math.round((p.x / innerWidth) * 100),
      primary: box("#m-solo"), daily: box("#m-daily"),
      party: box("#m-party"), rivals: box("#m-rivals-card"), roam: box("#m-roam-solo"),
      filledGoldPrimaries: goldFilled, secondaryTitleColours: titleColours,
      colsOver: (() => { const c = document.querySelector("#menu .m-cols");
        return c.scrollHeight - c.clientHeight; })(),
    };
  }));
  // the state that CLIPPED at 1366 in r1
  await page.click("#m-party").catch(() => {});
  await page.waitForTimeout(500);
  await freeze();
  await shot("menu-party", "#m-party-form");
  await rec("menu-party", "#menu");
  push(`menu-party fit ${tag}`, await page.evaluate(() => {
    const c = document.querySelector("#menu .m-cols");
    const t = document.querySelector(".m-testlink").getBoundingClientRect();
    const roam = document.querySelector("#m-roam-solo").getBoundingClientRect();
    const panel = document.querySelector("#menu .panel").getBoundingClientRect();
    return { colsOver: c.scrollHeight - c.clientHeight,
      testlinkVisible: t.bottom <= panel.bottom + 1 && t.height > 4,
      roamBottomInsidePanel: roam.bottom <= panel.bottom + 1 };
  }));
  await page.click("#m-party").catch(() => {});

  // ============ 3. IN-RUN ============
  await page.goto(`${BASE}/iso.html?test&floor=6&level=12&abilities=all&gold=5000&seed=42&eagerassets&debug=1`,
    { waitUntil: "load", timeout: 90000 });
  await settled();
  await freeze();
  await shot("hud", "#skills");
  push(`skills ${tag}`, await page.evaluate(() => {
    const s = document.getElementById("skills"); const r = s.getBoundingClientRect();
    const q = document.getElementById("quests");
    return { box: `${Math.round(r.width)}x${Math.round(r.height)}`,
      pctOfWidth: Math.round((r.width / innerWidth) * 100),
      slot: (() => { const c = s.firstElementChild?.getBoundingClientRect();
        return c ? `${Math.round(c.width)}x${Math.round(c.height)}` : null; })(),
      questsWidth: Math.round(q.getBoundingClientRect().width) };
  }));

  for (const [key, sel, name] of [["p", "#sheet", "sheet"], ["i", "#inv", "inv"],
                                  ["t", "#abil", "abil"], ["k", "#keys", "keys"]]) {
    await page.keyboard.press(key, { delay: 500 });
    await page.waitForTimeout(1400);
    await freeze();
    if (!(await shot(name, `${sel} .panel`))) { await page.keyboard.press("Escape", { delay: 400 }); continue; }
    await rec(name, sel);

    if (name === "abil") {
      push(`abil stage ${tag}`, await page.evaluate(() => {
        const pane = document.querySelector('#abil .apane[data-pane="chart"]');
        const idx = document.getElementById("abil-index");
        const grid = document.getElementById("abil-grid");
        const card = grid.firstElementChild?.getBoundingClientRect();
        return { paneOver: pane.scrollHeight - pane.clientHeight,
          indexOver: idx.scrollHeight - idx.clientHeight,
          gridOver: grid.scrollHeight - grid.clientHeight,
          indexRows: idx.querySelectorAll("button.aidx").length,
          cardsOnStage: grid.children.length,
          card: card ? `${Math.round(card.width)}x${Math.round(card.height)}` : null,
          paneBg: getComputedStyle(pane).backgroundImage.slice(0, 34),
          panelBg: getComputedStyle(document.querySelector("#abil .panel")).backgroundImage.slice(0, 34) };
      }));
      await page.click('#abil .amode[data-view="graph"]').catch(() => {});
      await page.waitForTimeout(700); await freeze();
      await shot("abil-chart", "#abil .ccard"); await rec("abil-chart", "#abil");
      await page.click('#abil .apage[data-page="ach"]').catch(() => {});
      await page.waitForTimeout(700); await freeze();
      await shot("ach-section", "#ach-section .sr-ach"); await rec("ach-section", "#abil");
      await probe(`ach layout T ${tag}`, () => page.evaluate(() => {
        const g = document.getElementById("ach-grid");
        const c = g.querySelector(".sr-ach");
        if (!c) return "MISSED — no .sr-ach card in the T panel grid";
        const r = c.getBoundingClientRect();
        return { cls: c.className, cols: getComputedStyle(g).gridTemplateColumns.split(" ").length,
          card: `${Math.round(r.width)}x${Math.round(r.height)}`,
          hasReward: !!c.querySelector(".areward, .claim-btn"),
          bg: getComputedStyle(c).backgroundColor };
      }));
      await page.click('#abil .apage[data-page="stats"]').catch(() => {});
      await page.waitForTimeout(600); await freeze();
      await shot("abil-stats", "#abil .stats-table"); await rec("abil-stats", "#abil");
      await page.click('#abil .amode[data-view="list"]').catch(() => {});
    }
    if (name === "keys") {
      // r1 reported the Shift/Ctrl chip carrying a brighter gold border at all
      // three sizes. Answer it with numbers, with the mouse parked off-screen.
      await page.mouse.move(2, 2); await page.waitForTimeout(150);
      push(`keys chips ${tag}`, await page.evaluate(() => {
        const odd = [];
        const seen = {};
        for (const k of document.querySelectorAll("#keys .kb-key")) {
          const c = getComputedStyle(k);
          const key = `${c.borderTopColor}|${c.color}`;
          seen[key] = (seen[key] ?? 0) + 1;
          if (k.matches(":hover") || k.matches(":focus") || k.classList.length > 1) {
            odd.push(`${k.textContent.trim()}: cls=${k.className} hover=${k.matches(":hover")}`);
          }
        }
        const wide = [...document.querySelectorAll("#keys .kb-key")]
          .map((k) => ({ label: k.textContent.trim(),
            w: Math.round(k.getBoundingClientRect().width),
            border: getComputedStyle(k).borderTopColor }));
        return { distinctChipSkins: Object.keys(seen).length, skins: seen, odd,
          widths: [...new Set(wide.map((x) => x.w))],
          shiftCtrl: wide.find((x) => /Shift/.test(x.label)) ?? null,
          neighbour: wide.find((x) => x.label === "C") ?? null };
      }));
      for (const t of ["prefs", "credits"]) {
        await page.click(`#keys [data-kbtab="${t}"]`).catch(() => {});
        await page.waitForTimeout(600); await freeze();
        await shot(`keys-${t}`, "#keys .kb-page.on"); await rec(`keys-${t}`, "#keys");
        push(`keys-${t} density ${tag}`, await page.evaluate(() => {
          const panel = document.querySelector("#keys .panel").getBoundingClientRect();
          const page_ = document.querySelector("#keys .kb-page.on");
          const kids = [...page_.children].map((c) => c.getBoundingClientRect());
          const last = kids.length ? Math.max(...kids.map((k) => k.bottom)) : page_.getBoundingClientRect().top;
          return { panelH: Math.round(panel.height),
            emptyBelowContentPct: Math.round(((panel.bottom - last) / panel.height) * 100) };
        }));
      }
      push(`keys tracks ${tag}`, await page.evaluate(() => {
        const g = document.getElementById("kb-rows");
        return { columns: getComputedStyle(g).gridTemplateColumns.split(" ").length };
      }));
      await page.click(`#keys [data-kbtab="keys"]`).catch(() => {});
    }
    await page.keyboard.press("Escape", { delay: 450 });
    await page.waitForTimeout(900);
  }

  // ---- TUTORIAL: push a real tip announcement, then verify the CARD is up ----
  await page.evaluate(() => {
    const s = window.__dcc?.state; if (!s) return;
    s.announcements.push({ text: "COURTESY EXPLANATION: that stairwell is sealed until the floor boss is dead. The System does not accept complaints about doors.", kind: "tip", priority: "normal" });
  });
  await page.waitForTimeout(2200);
  await freeze();
  await shot("tutorial", "#tutorial .tut-head");
  push(`tutorial ${tag}`, await measure("#tutorial"));

  // ---- QUESTS ----
  await page.evaluate(() => {
    const s = window.__dcc?.state; if (!s) return;
    s.runKind = "roam";
    s.quests = [
      { id: 1, key: "q1", title: "Thin the Nest", state: "active", objective: { kind: "killTribe", tribe: "kobold", target: 8, killed: 5 } },
      { id: 2, key: "q2", title: "Light the Old Road", state: "active", objective: { kind: "beacons", spots: [{ x: 0, y: 0, lit: true }, { x: 0, y: 0, lit: true }, { x: 0, y: 0, lit: false }] } },
      { id: 3, key: "q3", title: "A Parcel for Mordecai", state: "offered", objective: { kind: "killTribe", tribe: "goblin", target: 4, killed: 0 } },
    ];
  });
  await page.waitForTimeout(1500); await freeze();
  await shot("quests", "#quests .q-row");
  push(`quests ${tag}`, await measure("#quests"));
  await page.evaluate(() => { const s = window.__dcc?.state; if (s) { s.runKind = "dungeon"; s.quests = []; } });
  await page.waitForTimeout(600);

  // ---- SAFE ROOM (+ the draft it generates) ----
  await page.evaluate(() => {
    const s = window.__dcc?.state; if (!s) return;
    const p = s.players[0]; p.pos.x = s.map.stairs.x; p.pos.y = s.map.stairs.y;
  });
  await page.waitForTimeout(1200);
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => {
      const s = window.__dcc?.state; if (!s) return;
      const p = s.players[0]; p.pos.x = s.map.stairs.x; p.pos.y = s.map.stairs.y;
    });
    await page.keyboard.press("e", { delay: 800 });
    await page.waitForTimeout(2200);
    if (await page.evaluate(() => !!window.__dcc?.state?.safeRoom)) break;
  }
  push(`safe-room entry ${tag}`, await page.evaluate(() => ({
    safeRoom: !!window.__dcc?.state?.safeRoom, floor: window.__dcc?.state?.floor })));
  if (await page.evaluate(() => getComputedStyle(document.getElementById("draft")).display === "flex")) {
    await freeze();
    await shot("draft", "#draft .reward"); await rec("draft", "#draft", "REAL rewards from the sim");
    await page.keyboard.press("Escape", { delay: 450 });
    await page.waitForTimeout(800);
  } else { push(`draft ${tag}`, "MISSED — no draft opened on safe-room entry"); }

  if (await page.evaluate(() => getComputedStyle(document.getElementById("saferoom")).display !== "none")) {
    await freeze();
    await shot("saferoom", "#saferoom .shop-body"); await rec("saferoom", "#saferoom");
    push(`saferoom budget ${tag}`, await page.evaluate(() => {
      const p = document.querySelector("#saferoom .panel");
      const cs = getComputedStyle(p); const r = p.getBoundingClientRect();
      const budget = parseFloat(cs.maxHeight);
      return { measuredH: Math.round(r.height), budget: Math.round(budget),
        over: Math.round(r.height - budget), boxSizing: cs.boxSizing, pad: cs.padding };
    }));
    for (const [sel, nm, want] of [["#sr-tab-chase", "saferoom-chase", "#sr-shelf"],
                                   ["#sr-tab-ach", "saferoom-ach", "#sr-ach .sr-ach"]]) {
      await page.click(sel).catch(() => {});
      await page.waitForTimeout(900); await freeze();
      await shot(nm, want); await rec(nm, "#saferoom");
      if (nm === "saferoom-ach") {
        await probe(`ach layout SAFEROOM ${tag}`, () => page.evaluate(() => {
          const g = document.getElementById("sr-ach");
          const c = g.querySelector(".sr-ach");
          if (!c) return "MISSED — no .sr-ach card in the safe-room grid";
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
            out[k] = `${e.textContent.trim()} border=${c.borderBottomColor} shadow=${c.boxShadow.slice(0, 30)}`;
          }
          return out;
        }));
      }
    }
  } else { push(`saferoom ${tag}`, "MISSED — safe room never opened"); }

  await page.close();
}

// ============ 4. ROTATE gate (phone portrait) ============
{
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  });
  const cdp = await page.context().newCDPSession(page);
  await page.goto(`${BASE}/iso.html?test&floor=2&level=4&eagerassets`, { waitUntil: "commit", timeout: 90000 });
  await page.waitForTimeout(14000);
  const rot = await page.evaluate(() => {
    const r = document.getElementById("rotate"); if (!r) return "absent";
    const cs = getComputedStyle(r); const b = r.getBoundingClientRect();
    return { display: cs.display, opacity: cs.opacity, bodyCls: document.body.className,
      box: `${Math.round(b.width)}x${Math.round(b.height)}`,
      text: (r.textContent || "").trim().replace(/\s+/g, " ").slice(0, 90) };
  });
  const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
  const up = rot !== "absent" && rot.display !== "none";
  writeFileSync(`${OUT}/${up ? "" : "MISSED-"}rotate-390x844.png`, Buffer.from(data, "base64"));
  push("rotate 390x844", up ? rot : `MISSED — ${JSON.stringify(rot)}`);
  await page.close();
}

} catch (e) {
  push("RUN ABORTED", firstLine(e.message));
} finally { await browser.close(); writeReport(); }
