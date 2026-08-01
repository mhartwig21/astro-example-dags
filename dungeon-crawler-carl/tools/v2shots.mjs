// ITEMIZATION-V2 UI capture panel: shop v2 (build path + chase shelf + bench),
// the ability page with glyph sockets, and the crawler sheet's modifier block.
// Same harness contract as tools/uishots.mjs — poll data-assets-settled, never
// shoot the loading screen, retry panel toggles under SwiftShader time dilation.
// Usage: node tools/v2shots.mjs [outDir] [filter]
import { chromium } from "playwright";

const OUT = process.argv[2] ?? "tools/_v2shots";
const only = process.argv[3] ?? "";
const BASE = process.env.SHOT_BASE ?? "http://localhost:5285/iso.html";

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});

async function keys(page, pairs) {
  for (const [k, hold] of pairs) {
    await page.keyboard.down(k);
    await page.waitForTimeout(hold);
    await page.keyboard.up(k);
    await page.waitForTimeout(80);
  }
}

async function shot(name, url, fn, opts = {}) {
  if (only && !name.includes(only)) return;
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  page.on("pageerror", (e) => console.error(name, "PAGE ERROR:", e.message));
  page.on("console", (m) => { if (m.type() === "error") console.error(name, "CONSOLE:", m.text()); });
  try {
    await page.goto(url, { waitUntil: "load", timeout: 60000 });
    try {
      await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1",
        null, { timeout: 120000 });
    } catch { console.error(name, "WARN: assets never settled; shooting anyway"); }
    try {
      await page.waitForFunction(() => {
        const l = document.getElementById("loading");
        return !l || l.style.display === "none";
      }, null, { timeout: 120000 });
    } catch { console.error(name, "WARN: loading screen never cleared"); }
    await page.waitForTimeout(opts.wait ?? 4000);
    if (fn) await fn(page);
    await page.waitForTimeout(opts.settle ?? 600);
    await page.screenshot({ path: `${OUT}/${name}.png`, timeout: 300000 });
    console.log("saved", name);
  } catch (e) {
    console.error("FAILED", name, e.message);
  } finally {
    await page.close();
  }
}

const openShop = async (page) => {
  await page.waitForFunction(() => !!window.__dcc, null, { timeout: 90000 });
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => {
      const s = window.__dcc.state;
      const p = s.players[0];
      p.pos.x = s.map.stairs.x;
      p.pos.y = s.map.stairs.y;
      p.hp = p.maxHp;
    });
    // A first-contact tutorial card swallows the next keypress — clear it, then
    // knock. (The tip cards are dismissible by design; this is the same click.)
    await page.evaluate(() => {
      document.querySelectorAll("#tutorial button, #tutorial .tdismiss").forEach((b) => b.click());
    });
    await page.waitForTimeout(600);
    await keys(page, [["e", 650]]);
    await page.waitForTimeout(2200);
    const open = await page.evaluate(() =>
      document.getElementById("saferoom")?.style.display === "flex");
    if (open) break;
  }
  await page.waitForTimeout(600);
};

// 1) SHOP V2: a COMPLETED WORK selected, so the card shows the build path
// (components owned/needed -> the item -> the signature it feeds), the
// rarity-amplified identity line, and the chase shelf below the tiers.
await shot("v2-shop", `${BASE}?test&floor=8&level=16&gold=520&seed=41&abilities=all&debug=1`, async (page) => {
  await openShop(page);
  const picked = await page.evaluate(() => {
    // Prefer a stocked COMPLETED WORK whose components we hold — the card that
    // actually shows the whole ladder lit up.
    const tiles = [...document.querySelectorAll("#sr-shelf .igrid .itile[data-id]")];
    const adv = tiles.find((t) => t.classList.contains("tier-advanced") && !t.classList.contains("locked"));
    const el = adv ?? tiles.find((t) => t.classList.contains("tier-legendary")) ?? tiles[0];
    if (el) el.click();
    return el ? el.dataset.id : null;
  });
  console.log("  selected", picked);
  await page.waitForTimeout(900);
});

// 2) SHOP BENCH: a bag item selected -> REFIT preview (cost, resulting quality,
// floor rescale) + DISMANTLE shard yield, with shards in the wallet.
await shot("v2-shop-bench", `${BASE}?test&floor=8&level=16&gold=520&seed=41&abilities=all&debug=1`, async (page) => {
  await openShop(page);
  await page.evaluate(() => {
    // Stage the bench economy mid-run: some shards banked (dismantled junk),
    // which is exactly the state the REFIT decision is made in.
    window.__dcc.state.players[0].materials.refit_shard = 9;
  });
  await page.evaluate(() => {
    const el = document.querySelector("#sr-bag .itile[data-bag]");
    if (el) el.click();
  });
  await page.waitForTimeout(900);
});

// 2b) THE CHASE: the drop-only boss uniques, and one of them selected so the
// card reads as a wanted poster (no price, no BUY — the currency is the fight).
await shot("v2-chase", `${BASE}?test&floor=8&level=16&gold=520&seed=41&abilities=all&debug=1`, async (page) => {
  await openShop(page);
  await page.click("#sr-tab-chase", { force: true });
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    const row = document.querySelectorAll("#sr-shelf .chase-row")[1];
    if (row) row.click();
  });
  await page.waitForTimeout(900);
});

// 3b) GLYPH TOOLTIP: hovering a socketed stone prints the composed behavior —
// what the glyph does, and what the ability does WITH it (numbers off the sheet).
await shot("v2-glyph-tip", `${BASE}?test&floor=8&level=16&gold=520&seed=41&abilities=all&debug=1`, async (page) => {
  await openShop(page);
  await page.click("#sr-tab-abil", { force: true });
  await page.waitForTimeout(700);
  const box = await page.evaluate(() => {
    // Prefer a Hair Trigger seat: on a maxed Swift Strikes melee slot it is the
    // CDR-at-cap case, so the tip shows the composed read AND the breakpoint
    // warning (the trap the panel now names). Falls back to any filled socket.
    const el = document.querySelector('#sr-loadout .sock.filled[data-glyph="hair_trigger"]')
      ?? document.querySelector("#sr-loadout .sock.filled");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  if (box) {
    await page.mouse.move(box.x, box.y);
    await page.waitForTimeout(300);
    await page.mouse.move(box.x + 1, box.y + 1);
  }
  await page.waitForTimeout(800);
});

// 2c) BUY FEEDBACK: the ACQUIRED/COMBINED stamp, the gold flash on the card and
// the wallet bump — a purchase has to read as an EVENT, not a silent redraw.
await shot("v2-buy", `${BASE}?test&floor=8&level=16&gold=900&seed=41&abilities=all&debug=1`, async (page) => {
  await openShop(page);
  await page.evaluate(() => {
    // Pick something actually affordable and in stock, then buy it.
    const tiles = [...document.querySelectorAll("#sr-shelf .igrid .itile[data-id]")];
    const el = tiles.find((t) => t.classList.contains("tier-basic") && !t.classList.contains("locked")
      && !t.classList.contains("broke")) ?? tiles[0];
    if (el) el.click();
  });
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const b = document.querySelector("#sr-detail button[data-buy]:not([disabled])");
    if (b) b.click();
  });
  // The stamp lives ~2s on the REAL clock and this harness composites a frame
  // per second, so it has usually faded by capture. Re-trigger the same class
  // the buy handler sets, let the animation actually START (it does not exist
  // until a frame ticks), then freeze every animation mid-hold.
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const el = document.getElementById("sr-stamp");
    el.classList.remove("show");
    void el.offsetWidth;
    el.classList.add("show");
  });
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    for (const a of document.getAnimations()) { try { a.pause(); } catch { /* ok */ } }
  });
}, { settle: 120 });

// 3) ABILITY PAGE: socket wells on every slot, the glyph bench, one glyph
// picked up so the legal sockets light, and the per-ability modifier lines.
await shot("v2-abilities", `${BASE}?test&floor=8&level=16&gold=520&seed=41&abilities=all&debug=1`, async (page) => {
  await openShop(page);
  await page.click("#sr-tab-abil", { force: true });
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    // Free one socket and bank a couple of glyphs so the page shows the whole
    // verb: a bench, an empty well, and a held stone looking for a home.
    const p = window.__dcc.state.players[0];
    const g = p.glyphs;
    for (const arr of g.slots) {
      if (arr[1]) { g.bench.push(arr[1]); arr[1] = null; break; }
    }
    if (!g.bench.includes("reprise")) g.bench.push("reprise");
    if (!g.bench.includes("arc_splice")) g.bench.push("arc_splice");
  });
  await page.click("#sr-tab-shop", { force: true });
  await page.click("#sr-tab-abil", { force: true });
  await page.waitForTimeout(600);
  // Pick up an "any"-tagged stone so every open socket lights: the shot has to
  // show the legality read, not just a bench.
  await page.evaluate(() => {
    const chip = document.querySelector('#sr-glyphs .gchip[data-glyph="executioners_rebate"]')
      ?? document.querySelector("#sr-glyphs .gchip");
    if (chip) chip.click();
  });
  await page.waitForTimeout(800);
});

// 4) CRAWLER SHEET: the MODIFIERS block — item passives + per-slot glyphs
// (with dormancy called out) beside the usual ledger.
// Floor 14: deep enough that COMPLETED WORKS with passives are in the kit,
// so the MODIFIERS block shows both of its layers (passive + glyphs).
await shot("v2-sheet", `${BASE}?test&floor=14&level=22&gold=520&seed=41&abilities=all&debug=1`, async (page) => {
  await page.waitForFunction(() => !!window.__dcc, null, { timeout: 90000 });
  await page.evaluate(() => { window.__dcc.state.players[0].hp = window.__dcc.state.players[0].maxHp; });
  for (let i = 0; i < 6; i++) {
    await keys(page, [["p", 400]]);
    const ok = await page.evaluate(() => {
      const el = document.getElementById("sheet");
      return !!el && el.style.display === "flex" && el.querySelectorAll(".gear-row").length > 0;
    });
    if (ok) break;
  }
  await page.waitForTimeout(800);
});

// 5) THE CONSTELLATION (T panel): the same ability cards outside a safe room —
// modifier lines read-only, no socket controls. Regression guard for the shared
// abilityCard() renderer.
await shot("v2-constellation", `${BASE}?test&floor=8&level=16&gold=520&seed=41&abilities=all&debug=1`, async (page) => {
  await page.waitForFunction(() => !!window.__dcc, null, { timeout: 90000 });
  await page.evaluate(() => { window.__dcc.state.players[0].hp = window.__dcc.state.players[0].maxHp; });
  // Toggle, then WAIT before judging: a single press can land between dilated
  // SwiftShader frames, and re-pressing an already-open panel closes it.
  for (let i = 0; i < 6; i++) {
    const open = () => page.evaluate(() => {
      const el = document.getElementById("abil");
      return !!el && el.style.display === "flex" && el.querySelectorAll("#abil-grid .acard .nrow").length > 0;
    });
    if (await open()) break;
    await keys(page, [["t", 400]]);
    await page.waitForTimeout(1400);
    if (await open()) break;
  }
  await page.waitForTimeout(700);
});

await browser.close();
console.log("v2 panel done");
