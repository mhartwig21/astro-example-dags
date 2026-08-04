// Re-verify ONLY the four screens the post-capture polish touched, so the
// numbers in the commit message describe the code that is actually committed:
//   · #menu      — the side rail became a clamp (it was a hard 250px cap)
//   · #keys      — the CREDITS floor dropped 320 -> 240
//   · #abil      — the RUN STATS floor dropped 420 -> 300
//   · #sheet     — --set-lg capped at 1560 and both its columns became clamps
// ONE Chromium, three viewports, sequential.
import { chromium } from "playwright";
import { writeFileSync, mkdirSync } from "node:fs";

const OUT = process.argv[2] || "shots/ad-r2";
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
  const cdp = await page.context().newCDPSession(page);
  const settle = async () => {
    await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1",
      null, { timeout: 200000 }).catch(() => {});
    await page.waitForFunction(() => {
      const l = document.getElementById("loading"); if (!l) return true;
      const cs = getComputedStyle(l);
      return l.classList.contains("done") || cs.display === "none" || Number(cs.opacity) === 0;
    }, null, { timeout: 200000 }).catch(() => {});
    await page.waitForTimeout(3200);
    const boxed = await page.evaluate(() => {
      const l = document.getElementById("loading"); if (!l) return null;
      const cs = getComputedStyle(l);
      if (cs.display === "none" || Number(cs.opacity) === 0) return null;
      const r = l.getBoundingClientRect(); return `${r.width}x${r.height}`;
    });
    if (boxed) throw new Error(`ASSERT: #loading still boxed ${boxed}`);
  };
  const freeze = async () => {
    await page.evaluate(() => {
      for (const e of document.querySelectorAll("#inv,#abil,#sheet,#keys,#menu")) {
        e.style.animation = "none";
        const p = e.querySelector(".panel"); if (p) p.style.animation = "none";
      }
      for (const a of document.getAnimations()) a.finish();
    }).catch(() => {});
    await page.waitForTimeout(220);
  };
  // Effective opacity up the chain — the gate that caught the tutorial lie.
  const shot = async (name, sel) => {
    await page.mouse.move(2, 2); await page.waitForTimeout(120);
    const ok = await page.evaluate((s) => {
      const e = document.querySelector(s);
      if (!e) return { ok: false, why: "absent" };
      let op = 1, n = e;
      while (n && n !== document.documentElement) {
        const cs = getComputedStyle(n);
        if (cs.display === "none") return { ok: false, why: `display:none on ${n.id || n.className}` };
        op *= Number(cs.opacity); n = n.parentElement;
      }
      const r = e.getBoundingClientRect();
      return { ok: op > 0.95 && r.width > 20 && r.height > 20,
        effOpacity: Number(op.toFixed(3)), box: `${Math.round(r.width)}x${Math.round(r.height)}` };
    }, sel);
    const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
    writeFileSync(`${OUT}/${ok.ok ? "" : "MISSED-"}${name}-${tag}.png`, Buffer.from(data, "base64"));
    if (!ok.ok) push(`${name} ${tag}`, `MISSED — ${ok.why ?? JSON.stringify(ok)}`);
    return ok.ok;
  };
  const fit = async (sel) => page.evaluate((s) => {
    const root = document.querySelector(s);
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
    return { box: `${Math.round(r.width)}x${Math.round(r.height)}`,
      pctOfFrame: Math.round((r.width * r.height * 100) / (innerWidth * innerHeight)),
      docOver: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      worstDescendantOver: worst, scrollers: over };
  }, sel);

  // ---- MENU (front door + the 1366 party-form clip) ----
  await page.goto("http://localhost:5284/iso.html?eagerassets&clean=1", { waitUntil: "load", timeout: 120000 });
  await settle(); await freeze();
  await shot("menu", "#menu .panel");
  push(`menu ${tag}`, await fit("#menu"));
  push(`menu board ${tag}`, await page.evaluate(() => {
    const side = document.querySelector(".m-side").getBoundingClientRect();
    const tabs = [...document.querySelectorAll(".m-board-h .bt")].map((b) => Math.round(b.getBoundingClientRect().top));
    return { sideWidth: Math.round(side.width), tabRows: new Set(tabs).size };
  }));
  await page.click("#m-party").catch(() => {});
  await page.waitForTimeout(500); await freeze();
  await shot("menu-party", "#m-party-form");
  push(`menu-party fit ${tag}`, await page.evaluate(() => {
    const c = document.querySelector("#menu .m-cols");
    const t = document.querySelector(".m-testlink").getBoundingClientRect();
    const panel = document.querySelector("#menu .panel").getBoundingClientRect();
    return { colsOver: c.scrollHeight - c.clientHeight,
      testlinkVisible: t.bottom <= panel.bottom + 1 && t.height > 4 };
  }));

  // ---- the in-run panels the polish touched ----
  await page.goto("http://localhost:5284/iso.html?test&floor=6&level=12&abilities=all&gold=5000&seed=42&eagerassets&debug=1",
    { waitUntil: "load", timeout: 120000 });
  await settle();
  for (const [key, sel, name] of [["p", "#sheet", "sheet"], ["k", "#keys", "keys"], ["t", "#abil", "abil"]]) {
    await page.keyboard.press(key, { delay: 500 });
    await page.waitForTimeout(1400); await freeze();
    if (!(await shot(name, `${sel} .panel`))) { await page.keyboard.press("Escape", { delay: 400 }); continue; }
    push(`${name} ${tag}`, await fit(sel));
    if (name === "keys") {
      await page.click('#keys [data-kbtab="credits"]').catch(() => {});
      await page.waitForTimeout(600); await freeze();
      await shot("keys-credits", "#keys .kb-page.on");
      push(`keys-credits density ${tag}`, await page.evaluate(() => {
        const panel = document.querySelector("#keys .panel").getBoundingClientRect();
        const kids = [...document.querySelector("#keys .kb-page.on").children].map((c) => c.getBoundingClientRect());
        const last = Math.max(...kids.map((k) => k.bottom));
        return { panelH: Math.round(panel.height),
          emptyBelowContentPct: Math.round(((panel.bottom - last) / panel.height) * 100) };
      }));
      await page.click('#keys [data-kbtab="keys"]').catch(() => {});
      // the ledger's track count, measured while the page is VISIBLE (a hidden
      // grid reports its declared repeat(), which is how r2 first read "5")
      push(`keys tracks ${tag}`, await page.evaluate(() =>
        getComputedStyle(document.getElementById("kb-rows")).gridTemplateColumns));
    }
    if (name === "abil") {
      await page.click('#abil .apage[data-page="stats"]').catch(() => {});
      await page.waitForTimeout(600); await freeze();
      await shot("abil-stats", "#abil .stats-table");
      push(`abil-stats density ${tag}`, await page.evaluate(() => {
        const panel = document.querySelector("#abil .panel").getBoundingClientRect();
        const t = document.querySelector("#abil .stats-table").getBoundingClientRect();
        return { panelH: Math.round(panel.height),
          emptyBelowTablePct: Math.round(((panel.bottom - t.bottom) / panel.height) * 100) };
      }));
      await page.click('#abil .amode[data-view="list"]').catch(() => {});
    }
    await page.keyboard.press("Escape", { delay: 450 });
    await page.waitForTimeout(900);
  }
  await page.close();
}
} catch (e) { push("RUN ABORTED", String(e.message).split(/\r?\n/)[0]); }
finally {
  await browser.close();
  for (const [k, v] of report) console.log(`\n--- ${k}\n${v}`);
  writeFileSync(`${OUT}/measurements-post.json`, JSON.stringify(report, null, 1));
}
