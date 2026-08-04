// FUNNEL r1 acceptance probe (THE FRONT DOOR + THE ONRAMP, NICHE.md 4.5/4.4).
//
// Drives the REAL app on the dev server (:5286) against a REAL local game
// server (:5281). ONE browser (machine rule), pages within it:
//   A. menu fit: #m-rush present beside DAILY, honest sub, NO SCROLLBARS at
//      1366x768 / 1600x900 / 2560x1440 (frames captured at each)
//   B. queue truth: page A clicks THE RUSH -> lands in a held #rushgate on a
//      DAILY-coded race; page B's menu then reads RACE FORMING - 1/4 - GUN IN
//      m:ss on the tile; B's click joins THE SAME code (the queue coalesces)
//   C. onramp (desktop): fresh context, DESCEND, hold W -> the fresh-meat and
//      locomotion COURTESY EXPLANATION cards appear, naming WASD
//   D. onramp (touch): fresh context, ?touch=1, DESCEND -> the start line
//      names the LEFT HALF of the glass; no scrollbars in the touch shell
//
// usage: node tools/_funnel_accept.mjs
import { chromium } from "playwright";

const BASE = "http://localhost:5286";
const fails = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (!ok) fails.push(name);
};

const browser = await chromium.launch({
  headless: false,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--disable-gpu-sandbox"],
});

async function bootPage(context, url, vw = 1366, vh = 768) {
  const page = await context.newPage();
  await page.setViewportSize({ width: vw, height: vh });
  page.on("pageerror", (e) => console.log("[pageerror]", String(e.message)));
  await page.goto(url, { waitUntil: "load", timeout: 90000 });
  await page.waitForSelector("html[data-assets-settled='1']", { timeout: 120000 });
  await page.waitForFunction(() => {
    const el = document.getElementById("loading");
    if (!el || el.classList.contains("done")) return true;
    const cs = getComputedStyle(el);
    return cs.display === "none" || parseFloat(cs.opacity) === 0;
  }, { timeout: 120000 });
  await page.waitForTimeout(1000);
  return page;
}

const noScroll = (page) => page.evaluate(() => {
  const d = document.documentElement;
  return d.scrollWidth <= d.clientWidth + 1 && d.scrollHeight <= d.clientHeight + 1;
});

// ---- A. menu fit across the three contract viewports -----------------------
{
  const ctx = await browser.newContext();
  const page = await bootPage(ctx, `${BASE}/iso.html?noassets`);
  for (const [w, h] of [[1366, 768], [1600, 900], [2560, 1440]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.waitForTimeout(600);
    const rush = await page.evaluate(() => {
      const el = document.getElementById("m-rush");
      const sub = document.getElementById("m-rush-sub");
      const dsub = document.getElementById("m-daily-sub");
      const daily = document.getElementById("m-daily");
      if (!el || !daily || !sub || !dsub) return null;
      const r = el.getBoundingClientRect();
      const d = daily.getBoundingClientRect();
      return {
        visible: r.width > 40 && r.height > 30 && r.bottom <= innerHeight,
        sameBand: Math.abs(r.top - d.top) < 2 && Math.abs(r.height - d.height) < 2,
        sub: sub.textContent ?? "",
        // The clamp must not eat the copy: what the DOM says, the eye gets.
        subClipped: sub.scrollHeight > sub.clientHeight + 2,
        dailyClipped: dsub.scrollHeight > dsub.clientHeight + 2,
      };
    });
    check(`RUSH tile visible + banded at ${w}x${h}`, !!rush?.visible && !!rush?.sameBand,
      JSON.stringify(rush));
    check(`RUSH sub honest at ${w}x${h}`,
      /rotates .+ your time|RACE FORMING|one tap claims a seat/.test(rush?.sub ?? ""), rush?.sub);
    check(`hero subs fully visible (no clamp bite) at ${w}x${h}`,
      !rush?.subClipped && !rush?.dailyClipped);
    check(`no scrollbars at ${w}x${h}`, await noScroll(page));
    await page.screenshot({ path: `tools/_funnel_menu_${w}.png` });
  }
  await page.close();
  await ctx.close();
}

// ---- B. the queue coalesces -------------------------------------------------
{
  const ctxA = await browser.newContext();
  const a = await bootPage(ctxA, `${BASE}/iso.html?noassets`);
  await a.click("#m-rush");
  await a.click("#m-cast-go"); // the campfire confirm
  await a.waitForSelector("#rushgate", { state: "visible", timeout: 30000 });
  const codeA = await a.evaluate(() => new URLSearchParams(location.search).get("join"));
  check("RUSH lands in a held gate on a DAILY code", /^DAILY-\d{4}-\d{2}-\d{2}-RUSH-/.test(codeA ?? ""), codeA);
  await a.screenshot({ path: "tools/_funnel_gate_a.png" });

  const ctxB = await browser.newContext();
  const b = await bootPage(ctxB, `${BASE}/iso.html?noassets`);
  await b.waitForFunction(
    () => /RACE FORMING — 1\/4 — GUN IN \d+:\d\d/.test(document.getElementById("m-rush-sub")?.textContent ?? ""),
    { timeout: 15000 },
  );
  const subB = await b.evaluate(() => {
    const el = document.getElementById("m-rush-sub");
    return { text: el.textContent, clipped: el.scrollHeight > el.clientHeight + 2 };
  });
  check("second menu reads RACE FORMING — 1/4 — GUN IN m:ss", !subB.clipped,
    `${subB.text}${subB.clipped ? " (CLIPPED)" : ""}`);
  const forming = await b.evaluate(() => document.getElementById("m-rush").classList.contains("forming"));
  check("forming state is visible on the tile (border lit)", forming);
  await b.screenshot({ path: "tools/_funnel_menu_forming.png", clip: { x: 0, y: 0, width: 1366, height: 768 } });
  await b.click("#m-rush");
  await b.click("#m-cast-go");
  await b.waitForSelector("#rushgate", { state: "visible", timeout: 30000 });
  const codeB = await b.evaluate(() => new URLSearchParams(location.search).get("join"));
  check("the queue coalesces: B joined A's race", codeB === codeA, `${codeA} vs ${codeB}`);
  await b.waitForFunction(
    () => document.querySelectorAll("#rushgate-seats .gseat, #rushgate .gseat").length >= 2
      || (document.getElementById("rushgate-seats")?.children.length ?? 0) >= 2,
    { timeout: 10000 },
  );
  await b.screenshot({ path: "tools/_funnel_gate_2seats.png" });
  check("gate shows two seats", true);
  await a.close(); await b.close();
  await ctxA.close(); await ctxB.close();
}

// ---- C. onramp, desktop ------------------------------------------------------
{
  const ctx = await browser.newContext(); // fresh storage = fresh crawler
  const page = await bootPage(ctx, `${BASE}/iso.html?noassets`);
  await page.click("#m-solo");
  await page.click("#m-cast-go");
  await page.waitForFunction(() => document.getElementById("menu").style.display === "none", { timeout: 15000 });
  await page.waitForFunction(
    () => /fresh meat detected/i.test(document.querySelector(".tut-card, #tutorial, .tut-body")?.textContent
      ?? [...document.querySelectorAll("div")].find((d) => /fresh meat detected/i.test(d.textContent ?? ""))?.textContent ?? ""),
    { timeout: 20000 },
  ).catch(() => {});
  const startLine = await page.evaluate(() =>
    [...document.querySelectorAll("body *")].map((d) => d.textContent ?? "")
      .find((t) => /fresh meat detected/i.test(t) && t.length < 400) ?? null);
  check("onramp start line (desktop) shows and names the binds",
    !!startLine && /WASD/.test(startLine), startLine ?? "(none)");
  await page.screenshot({ path: "tools/_funnel_onramp_start.png" });
  await page.keyboard.down("w");
  await page.waitForTimeout(900); // SwiftShader-safe hold; real GPU is fine at 500
  await page.keyboard.up("w");
  const movedLine = await page.waitForFunction(
    () => [...document.querySelectorAll("body *")].map((d) => d.textContent ?? "")
      .find((t) => /locomotion confirmed/i.test(t) && t.length < 400) ?? null,
    { timeout: 15000 },
  ).then((h) => h.jsonValue()).catch(() => null);
  check("onramp moved line fires on first movement", !!movedLine, movedLine ?? "(none)");
  await page.screenshot({ path: "tools/_funnel_onramp_moved.png" });
  await page.close();
  await ctx.close();
}

// ---- D. onramp, touch --------------------------------------------------------
{
  const ctx = await browser.newContext({ hasTouch: true });
  const page = await bootPage(ctx, `${BASE}/iso.html?noassets&touch=1`, 844, 390);
  await page.click("#m-solo");
  await page.click("#m-cast-go");
  await page.waitForFunction(() => document.getElementById("menu").style.display === "none", { timeout: 15000 });
  const line = await page.waitForFunction(
    () => [...document.querySelectorAll("body *")].map((d) => d.textContent ?? "")
      .find((t) => /fresh meat detected/i.test(t) && t.length < 400) ?? null,
    { timeout: 20000 },
  ).then((h) => h.jsonValue()).catch(() => null);
  check("onramp start line (touch) names the glass, not a keyboard",
    !!line && /LEFT HALF of the glass/.test(line) && !/WASD/.test(line), line ?? "(none)");
  check("no scrollbars in the touch shell", await noScroll(page));
  await page.screenshot({ path: "tools/_funnel_onramp_touch.png" });
  await page.close();
  await ctx.close();
}

await browser.close();
console.log(fails.length ? `\n${fails.length} FAILURE(S): ${fails.join(", ")}` : "\nALL PASS");
process.exit(fails.length ? 1 : 0);
