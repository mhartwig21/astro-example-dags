// TUTORIAL r1 acceptance probe (TUTORIAL.md §6). COLD-PROFILE RULE: every
// first-run claim runs in a FRESH browser context (empty localStorage).
// RASTER RULE: every visual claim saves a frame to tools/_tut_shots/ and the
// probe additionally asserts the claimed box is non-uniform + warm-keyed
// (the #tutorial card has a history of not painting — DOM is not evidence).
// One Chromium for the whole battery (machine limit).
//
// Usage: node tools/_tut_r1.mjs [url-base]   (default http://localhost:5284)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://localhost:5284";
const SHOTS = new URL("./_tut_shots/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
mkdirSync(SHOTS, { recursive: true });

const fails = [];
const notes = [];
function check(name, cond, detail = "") {
  (cond ? notes : fails).push(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  let off = 8, w = 0, h = 0, colorType = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); colorType = data[9]; }
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * channels;
  const px = Buffer.allocUnsafe(h * stride);
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const rawB = raw[src + x];
      const a = x >= channels ? px[dst + x - channels] : 0;
      const b = y > 0 ? px[dst - stride + x] : 0;
      const c = y > 0 && x >= channels ? px[dst - stride + x - channels] : 0;
      let v;
      if (filter === 0) v = rawB;
      else if (filter === 1) v = rawB + a;
      else if (filter === 2) v = rawB + b;
      else if (filter === 3) v = rawB + ((a + b) >> 1);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = rawB + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      px[dst + x] = v & 0xff;
    }
  }
  return { w, h, channels, px };
}

/** Raster stats over a css-pixel box of a saved viewport shot. */
function boxStats(file, box) {
  const { w, channels, px } = decodePng(readFileSync(file));
  const X0 = Math.max(0, Math.floor(box.x)), Y0 = Math.max(0, Math.floor(box.y));
  const X1 = Math.floor(box.x + box.width), Y1 = Math.floor(box.y + box.height);
  let n = 0, sum = 0, sum2 = 0, warmN = 0;
  for (let y = Y0; y < Y1; y++) {
    for (let x = X0; x < X1; x++) {
      const o = (y * w + x) * channels;
      const r = px[o], g = px[o + 1] ?? r, b = px[o + 2] ?? r;
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      sum += l; sum2 += l * l; n++;
      if (r - b > 30 && r > 90) warmN++; // gold/ember keyed content
    }
  }
  const mean = sum / n;
  return { mean, std: Math.sqrt(Math.max(0, sum2 / n - mean * mean)), warmFrac: warmN / n, n };
}

/** Screenshot viewport + assert an element's box painted (non-uniform, warm). */
async function rasterCheck(page, sel, name, minWarm = 0.01) {
  const box = await page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, sel);
  const file = `${SHOTS}${name}.png`;
  await page.screenshot({ path: file });
  if (!box || box.width < 4 || box.height < 4) {
    check(`${name}: ${sel} has a real box`, false, JSON.stringify(box));
    return null;
  }
  const st = boxStats(file, box);
  check(`${name}: ${sel} painted (std ${st.std.toFixed(1)}, warm ${(st.warmFrac * 100).toFixed(1)}%)`,
    st.std > 8 && st.warmFrac > minWarm);
  return { box, st, file };
}

const gotoOpts = { waitUntil: "load", timeout: 90000 };
async function boot(page, url) {
  await page.goto(url, gotoOpts);
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 180000 });
  await page.waitForFunction(() => {
    const el = document.getElementById("loading");
    if (!el || el.classList.contains("done")) return true;
    const cs = getComputedStyle(el);
    return cs.display === "none" || parseFloat(cs.opacity) === 0;
  }, { timeout: 180000 }).catch(() => {});
  await page.waitForTimeout(800);
}

const dlgVisible = (page) => page.evaluate(() => {
  const el = document.getElementById("dialogue");
  return !!el && el.style.display === "flex" && el.classList.contains("show");
});
const dlgName = (page) => page.evaluate(() => document.getElementById("dlg-name")?.textContent ?? "");
const dlgChoiceN = (page) => page.evaluate(() => document.querySelectorAll("#dialogue .dlg-choice").length);

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--disable-gpu-sandbox"],
});

try {
  // ================= CONTEXT A: cold organic first session ================
  const ctxA = await browser.newContext({ viewport: { width: 1366, height: 768 } });
  const A = await ctxA.newPage();
  const errsA = [];
  A.on("pageerror", (e) => errsA.push(e.message));
  await boot(A, `${BASE}/iso.html?debug=1&noassets`);

  // Boot: menu open, no beat (first session — the campfire owns the intro).
  check("A boot: RINGSIDE CHECK-IN open", await A.evaluate(() => document.getElementById("menu")?.style.display === "flex"));
  check("A boot: no dialogue on the panel stage (B9 needs a history)", !(await dlgVisible(A)));

  // B0: DESCEND -> casting stage -> the campfire beat.
  await A.click("#m-solo");
  await A.waitForTimeout(600);
  check("B0: Mordecai panel up at the casting stage", await dlgVisible(A));
  check("B0: nameplate reads Mordecai", (await dlgName(A)) === "Mordecai");
  check("B0: three numbered choices", (await dlgChoiceN(A)) === 3);
  await A.waitForTimeout(1800); // let the typewriter land for the frame
  await rasterCheck(A, "#dialogue .dlg-stage", "b0_1366");
  // Depth choice returns to the choices (minus the asked question).
  await A.keyboard.press("1");
  await A.waitForTimeout(1200);
  check("B0: depth answer consumed the question", (await dlgChoiceN(A)) === 2);
  await rasterCheck(A, "#dialogue .dlg-stage", "b0_reply");
  // ESC = farewell; CHECK IN is the very next input.
  await A.keyboard.press("Escape");
  await A.waitForTimeout(400);
  check("B0: ESC closes the beat", !(await dlgVisible(A)));
  await A.click("#m-cast-go");
  await A.waitForTimeout(1500);
  check("B0->run: CHECK IN launched the run", await A.evaluate(() => window.__dcc?.state?.status === "playing"));

  // B1 regression: the onramp's first card paints within ~3s of gameplay.
  await A.waitForTimeout(2500);
  const b1 = await rasterCheck(A, "#tutorial .tut", "b1_card");
  check("B1: onramp card body mentions fresh meat / walking",
    await A.evaluate(() => /fresh meat|walk/i.test(document.querySelector("#tutorial .tut")?.textContent ?? "")));

  // ---- helpers driving the REAL run through the debug hook ----
  const levelUp = async (mult = 1) => A.evaluate((m) => {
    const s = window.__dcc.state;
    const p = s.players[0];
    p.xp = p.xpToNext * m; // the next kill's grant crosses m level(s)
    p.attackPower = 9999;
    const mon = s.monsters.find((x) => x.kind !== "boss" && x.hp > 0);
    if (!mon) return false;
    mon.hp = 1;
    p.hp = p.maxHp;
    mon.pos = { x: p.pos.x + 0.5, y: p.pos.y + 0.2 }; // in arm's reach
    return true;
  }, mult);
  const level = () => A.evaluate(() => window.__dcc.state.players[0].level);
  /** Swing at whatever is adjacent: LMB held while the mouse circles the
   *  player (aim direction sweeps every quadrant). */
  const meleeFlurry = async (page) => {
    const c = { x: 683, y: 384 };
    await page.mouse.move(c.x + 90, c.y);
    await page.mouse.down();
    for (const a of [0, 1, 2, 3, 4, 5, 6, 7]) {
      await page.mouse.move(c.x + Math.round(90 * Math.cos(a * Math.PI / 4)),
        c.y + Math.round(90 * Math.sin(a * Math.PI / 4)));
      await page.waitForTimeout(320);
    }
    await page.mouse.up();
  };

  // B3: first level-up banks a draft; V opens the claim -> Mordecai first.
  check("B3 setup: staged a kill", await levelUp(1));
  await meleeFlurry(A);
  check("B3 setup: leveled up", (await level()) >= 2, `level ${await level()}`);
  await A.waitForTimeout(400);
  await A.keyboard.press("v");
  await A.waitForTimeout(600);
  check("B3: guide beat BEFORE the draft UI", (await dlgVisible(A))
    && (await A.evaluate(() => document.getElementById("draft")?.style.display !== "flex")));
  await A.waitForTimeout(1500);
  await rasterCheck(A, "#dialogue .dlg-stage", "b3_beat");
  await A.keyboard.press("1"); // "Show me the picks."
  await A.waitForTimeout(500);
  check("B3: choice 1 opens the draft panel", await A.evaluate(() => document.getElementById("draft")?.style.display === "flex"));
  await A.waitForTimeout(400); // let the overlay's fade land before the frame
  await rasterCheck(A, "#draft", "b3_draft", 0.002);
  await A.keyboard.press("1"); // take the first pick — the pick is the lesson
  await A.waitForTimeout(400);
  check("B3: the pick completed", await A.evaluate(() => {
    const p = window.__dcc.state.players[0];
    return p.pendingUpgrades.length === 0;
  }));

  // Second draft, same run: no beat — straight to the panel (once EVER).
  check("B3-2 setup: staged a kill", await levelUp(4));
  await meleeFlurry(A);
  check("B3-2 setup: leveled to >=5 (socket 1 open)", (await level()) >= 5, `level ${await level()}`);
  await A.keyboard.press("v");
  await A.waitForTimeout(600);
  check("B3-2: second draft opens with NO beat", !(await dlgVisible(A))
    && (await A.evaluate(() => document.getElementById("draft")?.style.display === "flex")));
  // Claim every queued draft so the safe room isn't gated by draftPending —
  // the owed queue mints new offers between claims, so drive by state.
  for (let i = 0; i < 30; i++) {
    const st = await A.evaluate(() => {
      const p = window.__dcc.state.players[0];
      return {
        open: document.getElementById("draft")?.style.display === "flex",
        left: p.pendingUpgrades.length + p.pendingRewards.length + p.upgradeDraftsOwed,
      };
    });
    if (!st.open && st.left === 0) break;
    await A.keyboard.press(st.open ? "1" : "v");
    await A.waitForTimeout(600);
  }
  check("B3-2: drafts all claimed", await A.evaluate(() => {
    const p = window.__dcc.state.players[0];
    return p.pendingUpgrades.length === 0 && p.upgradeDraftsOwed === 0 && p.pendingRewards.length === 0;
  }));

  // B4: force the collapse warning — the SYSTEM's card, on the card surface.
  await A.evaluate(() => {
    const s = window.__dcc.state;
    s.timeRemaining = s.timeBudget * 0.25 - 0.5; // under warningFraction
  });
  // The card can queue behind an earlier COURTESY card (7s auto-dismiss each).
  await A.waitForFunction(() => /clock has opinions/.test(document.querySelector("#tutorial .tut")?.textContent ?? ""), { timeout: 16000 }).catch(() => {});
  const b4ok = await A.evaluate(() => /clock has opinions/.test(document.querySelector("#tutorial .tut")?.textContent ?? ""));
  check("B4: collapse card text present", b4ok);
  if (b4ok) {
    await A.waitForTimeout(700); // the card fades in; photograph it landed
    await rasterCheck(A, "#tutorial .tut", "b4_card");
  }
  check("B4: no Mordecai surface during live play", !(await dlgVisible(A)));

  // B5: the first safe room — the beat, then the panel on choice 1.
  await A.evaluate(() => {
    const s = window.__dcc.state;
    const p = s.players[0];
    p.hp = p.maxHp;
    p.pos = { x: s.map.stairs.x, y: s.map.stairs.y };
  });
  await A.keyboard.press("e");
  await A.waitForTimeout(700);
  check("B5: safe room opened in the sim", await A.evaluate(() => !!window.__dcc.state.safeRoom));
  check("B5: Mordecai beat before the panel", await dlgVisible(A)
    && (await A.evaluate(() => document.getElementById("saferoom")?.style.display !== "flex")));
  await A.waitForTimeout(1800);
  await rasterCheck(A, "#dialogue .dlg-stage", "b5_beat");
  await A.keyboard.press("1"); // "Open the shop."
  await A.waitForTimeout(600);
  check("B5: choice 1 lands in the safe-room shop", await A.evaluate(() =>
    document.getElementById("saferoom")?.style.display === "flex"));
  await rasterCheck(A, "#saferoom", "b5_shop");

  // Descend to floor 2 through the shipped safe-room button.
  await A.click("#saferoom .descend button");
  await A.waitForTimeout(1500);
  check("A: on floor 2", (await A.evaluate(() => window.__dcc.state.floor)) === 2);

  // B7: second safe-room visit, socket open (level>=4), Glyph Cache stocked
  // (shop #2) — the glyph beat (Show not yet met, so B6 correctly waits).
  await A.evaluate(() => {
    const s = window.__dcc.state;
    const p = s.players[0];
    p.hp = p.maxHp;
    p.pos = { x: s.map.stairs.x, y: s.map.stairs.y };
  });
  await A.keyboard.press("e");
  await A.waitForTimeout(700);
  const b7state = await A.evaluate(() => ({
    safe: !!window.__dcc.state.safeRoom,
    glyphCache: window.__dcc.state.safeRoom?.available?.includes("glyph_cache") ?? false,
    level: window.__dcc.state.players[0].level,
  }));
  if (b7state.glyphCache && b7state.level >= 4) {
    check("B7: glyph beat on the visit where socketing is possible", await dlgVisible(A));
    await A.waitForTimeout(1500);
    await rasterCheck(A, "#dialogue .dlg-stage", "b7_beat");
    await A.keyboard.press("1"); // "Open the bench."
    await A.waitForTimeout(600);
    check("B7: choice 1 lands on the bench tab", await A.evaluate(() =>
      document.getElementById("saferoom")?.style.display === "flex"
      && document.querySelector("#saferoom")?.textContent?.length > 0));
    await rasterCheck(A, "#saferoom", "b7_bench");
  } else {
    check("B7: shelf/level preconditions", false, JSON.stringify(b7state));
  }
  await A.click("#saferoom .descend button");
  await A.waitForTimeout(1500);

  // B8: die -> THE VERDICT wears the aside plate above an unobstructed CTA.
  const seedBefore = await A.evaluate(() => window.__dcc.state.seed);
  await A.evaluate(() => {
    const s = window.__dcc.state;
    const p = s.players[0];
    p.hp = 3;
    const mon = s.monsters.find((x) => x.hp > 0);
    if (mon) p.pos = { x: mon.pos.x + 0.5, y: mon.pos.y };
  });
  await A.waitForFunction(() => window.__dcc.state.status !== "playing", { timeout: 20000 });
  await A.waitForTimeout(1400); // the verdict's short beat
  check("B8: THE VERDICT is up", await A.evaluate(() => document.getElementById("recap")?.style.display === "flex"));
  check("B8: the Mordecai aside plate shows", await A.evaluate(() =>
    document.getElementById("recap-guide")?.style.display === "flex"
    && /run it back/i.test(document.getElementById("recap-guide-line")?.textContent ?? "")));
  const b8boxes = await A.evaluate(() => {
    const g = document.getElementById("recap-guide")?.getBoundingClientRect();
    const cta = document.getElementById("recap-again")?.getBoundingClientRect();
    return { g, cta, overlap: g && cta ? !(g.bottom <= cta.top || cta.bottom <= g.top || g.right <= cta.left || cta.right <= g.left) : null };
  });
  check("B8: aside sits clear of the RUN IT BACK CTA", b8boxes.overlap === false, JSON.stringify(b8boxes.overlap));
  await rasterCheck(A, "#recap-guide", "b8_verdict");
  await A.screenshot({ path: `${SHOTS}b8_full.png` });
  // R runs back the identical seed.
  await A.keyboard.press("r");
  await A.waitForTimeout(1500);
  const rb = await A.evaluate(() => ({ seed: window.__dcc.state.seed, status: window.__dcc.state.status }));
  check("B8: R runs back the identical seed", rb.status === "playing" && rb.seed === seedBefore, JSON.stringify({ seedBefore, rb }));

  // Second death: the plate is absent (once EVER).
  await A.evaluate(() => {
    const s = window.__dcc.state;
    const p = s.players[0];
    p.hp = 2;
    const mon = s.monsters.find((x) => x.hp > 0);
    if (mon) p.pos = { x: mon.pos.x + 0.5, y: mon.pos.y };
  });
  await A.waitForFunction(() => window.__dcc.state.status !== "playing", { timeout: 20000 });
  await A.waitForTimeout(1400);
  check("B8-2: second verdict has NO plate", await A.evaluate(() =>
    document.getElementById("recap-guide")?.style.display === "none"));
  await A.screenshot({ path: `${SHOTS}b8_second.png` });

  // B9: reload (organic arrival #2, history >= 1) -> the menu beat, once.
  await boot(A, `${BASE}/iso.html?debug=1&noassets`);
  await A.waitForTimeout(700);
  check("B9: beat on the second organic check-in", await dlgVisible(A)
    && (await dlgName(A)) === "Mordecai");
  await A.waitForTimeout(1800);
  await rasterCheck(A, "#dialogue .dlg-stage", "b9_menu");
  await A.keyboard.press("1"); // "And Roam?" depth
  await A.waitForTimeout(1000);
  await rasterCheck(A, "#dialogue .dlg-stage", "b9_roam");
  await A.keyboard.press("Escape");
  await A.waitForTimeout(400);
  check("B9: ESC leaves the menu usable", await A.evaluate(() =>
    document.getElementById("menu")?.style.display === "flex" && !document.getElementById("dialogue")?.classList.contains("show")));
  await boot(A, `${BASE}/iso.html?debug=1&noassets`);
  await A.waitForTimeout(700);
  check("B9-2: third visit shows no beat", !(await dlgVisible(A)));
  check("A: zero page errors", errsA.length === 0, errsA.slice(0, 3).join(" | "));
  await ctxA.close();

  // ============== CONTEXT B: cold profile, the global skip ================
  const ctxB = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const B = await ctxB.newPage();
  const errsB = [];
  B.on("pageerror", (e) => errsB.push(e.message));
  await boot(B, `${BASE}/iso.html?debug=1&noassets`);
  await B.click("#m-solo");
  await B.waitForTimeout(600);
  check("skip: B0 up at 1600x900", await dlgVisible(B));
  await B.waitForTimeout(1500);
  await rasterCheck(B, "#dialogue .dlg-stage", "b0_1600");
  await B.keyboard.press("3"); // "Skip the hand-holding."
  await B.waitForTimeout(1200);
  await rasterCheck(B, "#dialogue .dlg-stage", "b0_skip");
  await B.keyboard.press("1"); // the one goodbye left
  await B.waitForTimeout(400);
  check("skip: panel closed", !(await dlgVisible(B)));
  check("skip: every tut key + the skip flag ledgered", await B.evaluate(() => {
    const ids = JSON.parse(localStorage.getItem("dcc:tips:v1") ?? "[]");
    return ["tut.campfire", "tut.draft", "tut.saferoom", "tut.show", "tut.glyphs",
      "tut.runback", "tut.menu2", "tut.skipAll"].every((k) => ids.includes(k));
  }));
  await B.click("#m-cast-go");
  await B.waitForTimeout(1500);
  // 20s of floor-1 play: not one ONRAMP line (sim rule tips are a different
  // voice with their own once-ever ledger and are not silenced by the skip).
  let sawOnramp = "";
  const ONRAMP_RX = /fresh meat|locomotion confirmed|loot is a raise|you are leaking|down is the only way/i;
  for (let i = 0; i < 40; i++) {
    await B.keyboard.down("w");
    await B.waitForTimeout(250);
    await B.keyboard.up("w");
    await B.waitForTimeout(250);
    const txt = await B.evaluate(() => document.querySelector("#tutorial .tut")?.textContent ?? "");
    if (ONRAMP_RX.test(txt)) { sawOnramp = txt; break; }
  }
  check("skip: zero onramp lines in 20s of floor-1 play", sawOnramp === "", sawOnramp.slice(0, 60));
  await B.screenshot({ path: `${SHOTS}skip_floor1.png` });
  check("B: zero page errors", errsB.length === 0, errsB.slice(0, 3).join(" | "));
  await ctxB.close();

  // ============ CONTEXT C: cold LINK arrival — no campfire beat ===========
  const today = new Date().toISOString().slice(0, 10);
  const ctxC = await browser.newContext({ viewport: { width: 2560, height: 1440 } });
  const C = await ctxC.newPage();
  await boot(C, `${BASE}/iso.html?debug=1&noassets&daily=${today}`);
  await C.click("#m-daily");
  await C.waitForTimeout(700);
  check("link arrival: NO campfire beat at the casting stage", !(await dlgVisible(C)));
  await C.screenshot({ path: `${SHOTS}c_link_casting.png` });
  await ctxC.close();

  // ==== CONTEXT D: B6 (Show debrief) + B0 at 2560x1440, targeted ledger ===
  // B6's own trigger REQUIRES a warm Show ledger (the System demonstrates
  // first); the campfire/saferoom keys are pre-seeded so the visit under
  // test is exactly the state the beat gates on.
  const ctxD = await browser.newContext({ viewport: { width: 2560, height: 1440 } });
  const D = await ctxD.newPage();
  await D.addInitScript(() => {
    if (!localStorage.getItem("dcc:tips:v1")) {
      localStorage.setItem("dcc:tips:v1", JSON.stringify(["tut.draft", "tut.saferoom", "sponsors"]));
    }
  });
  await boot(D, `${BASE}/iso.html?debug=1&noassets`);
  await D.click("#m-solo");
  await D.waitForTimeout(600);
  check("B0 @2560: campfire beat up (tut.campfire unseen)", await dlgVisible(D));
  await D.waitForTimeout(1800);
  await rasterCheck(D, "#dialogue .dlg-stage", "b0_2560");
  await D.keyboard.press("Escape");
  await D.click("#m-cast-go");
  await D.waitForTimeout(1500);
  await D.evaluate(() => {
    const s = window.__dcc.state;
    const p = s.players[0];
    p.pos = { x: s.map.stairs.x, y: s.map.stairs.y };
  });
  await D.keyboard.press("e");
  await D.waitForTimeout(700);
  check("B6: Show debrief at the safe room AFTER the System demonstrated",
    await dlgVisible(D) && (await D.evaluate(() =>
      /cameras|hype is money/i.test(document.getElementById("dlg-text")?.textContent ?? ""))) !== false);
  await D.waitForTimeout(2200);
  await rasterCheck(D, "#dialogue .dlg-stage", "b6_beat");
  await D.keyboard.press("1"); // "Noted."
  await D.waitForTimeout(500);
  check("B6: farewell leaves the safe-room panel usable", await D.evaluate(() =>
    document.getElementById("saferoom")?.style.display === "flex"));
  await ctxD.close();
} finally {
  await browser.close();
}

writeFileSync(`${SHOTS}_report.txt`, [...notes, ...fails].join("\n"));
console.log(`\n${notes.length} pass, ${fails.length} fail. Shots in tools/_tut_shots/`);
if (fails.length > 0) process.exit(1);
