// Funnel r2 ACCEPTANCE probe (critic-owned). One Chromium, contexts within.
// Server on :5281 runs with DAILY_FLIP_HOUR_UTC=19 => server day 2026-08-03
// while the browser's UTC guess says 2026-08-04 — the exact MAJOR-1 scenario.
import { chromium } from "playwright";

const BASE = "http://localhost:5286";
const CARD = "WzEsMjY5ODkzMjExNywiZGFpbHktMjAyNi0wOC0wMyIsIk1FQVRTSElFTEQiLDcsMCwzNzIsNDEsOSwiIl0";
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
  await page.waitForTimeout(1200);
  return page;
}
const noScroll = (page) => page.evaluate(() => {
  const d = document.documentElement;
  return d.scrollWidth <= d.clientWidth + 1 && d.scrollHeight <= d.clientHeight + 1;
});

// ---- 1. MENU: server-day coherence + honest RUSH sub + fit ----------------
{
  const ctx = await browser.newContext();
  const page = await bootPage(ctx, `${BASE}/iso.html?noassets`);
  await page.waitForTimeout(1500); // let /rush answer
  const menu = await page.evaluate(() => ({
    boardDay: document.getElementById("m-board-day")?.textContent ?? "",
    rushSub: document.getElementById("m-rush-sub")?.textContent ?? "",
    dailySub: document.getElementById("m-daily-sub")?.textContent ?? "",
    bodyHasZeroCrawlers: /\b0 CRAWLERS\b/i.test(document.body.textContent ?? ""),
  }));
  check("board day header names the SERVER's day (2026-08-03, not UTC 08-04)",
    menu.boardDay === "2026-08-03", menu.boardDay);
  check("RUSH sub: crew window lead (<6h away) + rotates-your-time",
    /crew window — Critic Crew/i.test(menu.rushSub) && /rotates .+ your time/.test(menu.rushSub),
    menu.rushSub);
  check("DAILY sub tells the configured clock, not 'midnight UTC'",
    !/midnight UTC/.test(menu.dailySub) && /rotates .+ your time/.test(menu.dailySub), menu.dailySub);
  check("no '0 CRAWLERS' anywhere (presence floor)", !menu.bodyHasZeroCrawlers);
  check("no scrollbars at 1366x768", await noScroll(page));
  await page.screenshot({ path: "tools/_critic_r2_menu.png" });

  // ---- 2. RUSH lands in a held gate on the SERVER-day DAILY code ----------
  await page.click("#m-rush");
  await page.click("#m-cast-go");
  await page.waitForSelector("#rushgate", { state: "visible", timeout: 30000 });
  const codeA = await page.evaluate(() => new URLSearchParams(location.search).get("join"));
  check("RUSH gate held on DAILY-2026-08-03-RUSH-* (server day, not local)",
    /^DAILY-2026-08-03-RUSH-/.test(codeA ?? ""), codeA);
  await page.screenshot({ path: "tools/_critic_r2_gateA.png" });

  // ---- 3. second menu sees RACE FORMING, joins the SAME code, gun fires ---
  const ctxB = await browser.newContext();
  const b = await bootPage(ctxB, `${BASE}/iso.html?noassets`);
  await b.waitForFunction(
    () => /RACE FORMING — 1\/4 — GUN IN \d+:\d\d/.test(document.getElementById("m-rush-sub")?.textContent ?? ""),
    { timeout: 15000 });
  await b.click("#m-rush");
  await b.click("#m-cast-go");
  await b.waitForSelector("#rushgate", { state: "visible", timeout: 30000 });
  const codeB = await b.evaluate(() => new URLSearchParams(location.search).get("join"));
  check("queue coalesces: B joined A's race", codeB === codeA, `${codeA} vs ${codeB}`);
  await b.screenshot({ path: "tools/_critic_r2_gateB.png" });
  // both ready -> gun fires -> sim runs for both
  const readyBtn = async (p) => {
    const sel = await p.evaluate(() => {
      const cands = [...document.querySelectorAll("#rushgate button")];
      const btn = cands.find((x) => /READY|I'M READY|ARM/i.test(x.textContent ?? ""));
      return btn ? (btn.id ? "#" + btn.id : null) : null;
    });
    if (sel) { await p.click(sel); return true; }
    return false;
  };
  const rA = await readyBtn(page); const rB = await readyBtn(b);
  check("both gate pages expose a READY control", rA && rB, `A:${rA} B:${rB}`);
  const gunGone = async (p) => p.waitForFunction(() => {
    const g = document.getElementById("rushgate");
    return !g || g.style.display === "none" || getComputedStyle(g).display === "none";
  }, { timeout: 25000 }).then(() => true).catch(() => false);
  const [ga, gb] = await Promise.all([gunGone(page), gunGone(b)]);
  check("the gun fires for both seats (gate leaves both screens)", ga && gb);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: "tools/_critic_r2_postgun.png" });
  await page.close(); await b.close(); await ctx.close(); await ctxB.close();
}

// ---- 4. the ?c= card confirms 'today' against the SERVER day --------------
{
  const ctx = await browser.newContext();
  const page = await bootPage(ctx, `${BASE}/iso.html?noassets&c=${encodeURIComponent(CARD)}`);
  await page.waitForTimeout(3500); // the <=3s confirm window
  const card = await page.evaluate(() => ({
    label: document.querySelector("#m-daily b")?.textContent ?? "",
    sub: document.getElementById("m-daily-sub")?.textContent ?? "",
    solo: document.getElementById("m-hero-row")?.classList.contains("solo") ?? false,
    rushHidden: (() => {
      const r = document.getElementById("m-rush");
      return !r || getComputedStyle(r).display === "none";
    })(),
  }));
  check("card re-dresses the DAILY door into ACCEPT CHALLENGE", card.label === "ACCEPT CHALLENGE", card.label);
  check("card for the LIVE (server-day) daily says the board is watching",
    /It's today's daily — the board is watching/.test(card.sub), card.sub);
  check("card owns the band: row solo, RUSH steps out", card.solo && card.rushHidden);
  check("card frames depth against finalFloor (FLOOR 7 OF 18 grammar)",
    /floor 7 of 18/i.test(card.sub), card.sub);
  await page.screenshot({ path: "tools/_critic_r2_card.png" });

  // ---- 5. ONRAMP: fresh context + card -> first-contact lines, then death->
  // (fresh storage = fresh crawler; the card run is a normal run)
  await page.click("#m-daily"); // ACCEPT CHALLENGE
  await page.click("#m-cast-go");
  await page.waitForFunction(() => document.getElementById("menu").style.display === "none", { timeout: 20000 });
  await page.waitForTimeout(2500);
  const findLine = (re) => page.evaluate((src) => {
    const rx = new RegExp(src, "i");
    return [...document.querySelectorAll("body *")].map((d) => d.textContent ?? "")
      .find((t) => rx.test(t) && t.length < 400) ?? null;
  }, re.source);
  const startLine = await findLine(/fresh meat detected/);
  check("onramp start line fires on a CARD run and names WASD",
    !!startLine && /WASD/.test(startLine), startLine ?? "(none)");
  const banner = await findLine(/MEATSHIELD/);
  check("the claim is restated once (banner/log), not a live delta",
    !!banner, banner ?? "(none)");
  await page.screenshot({ path: "tools/_critic_r2_onrampcard.png" });
  await page.close(); await ctx.close();
}

await browser.close();
console.log(fails.length ? `\n${fails.length} FAILURE(S): ${fails.join(", ")}` : "\nALL PASS");
process.exit(fails.length ? 1 : 0);
