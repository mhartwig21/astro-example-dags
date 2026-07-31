// Roam presentation capture: drives the REAL menu into a solo Roam campaign
// (createTestGame has no roam leg), then walks the settlement flows with the
// ?debug=1 __dcc hook: arrival plaque, resident plates, the Mordecai guide
// moment, quest accept/turn-in beats, the outfitter, and the campaign card.
// Usage: node tools/roamflow.mjs <outdir> [--base http://localhost:5285]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const outdir = process.argv[2] ?? "shots";
const baseIdx = process.argv.indexOf("--base");
const base = baseIdx >= 0 ? process.argv[baseIdx + 1] : "http://localhost:5285";
mkdirSync(outdir, { recursive: true });

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--disable-gpu-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("PAGE ERROR:", e.message));
page.on("console", (m) => { if (m.type() === "error") console.error("CONSOLE:", m.text().slice(0, 200)); });

const url = `${base}/iso.html?debug=1&eagerassets`;
await page.goto(url, { waitUntil: "load", timeout: 60000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 120000 });
await page.waitForFunction(() => {
  const el = document.getElementById("loading");
  return !el || getComputedStyle(el).display === "none";
}, null, { timeout: 90000 });
await page.waitForTimeout(1500);

const shot = async (name) => {
  await page.screenshot({ path: join(outdir, name), timeout: 60000 });
  console.log("saved", name);
};
// SwiftShader screenshots lag the DOM by seconds — a 3.4s banner can expire
// mid-capture. Pin a timer-free clone for the shot, then sweep it.
const pinBanner = async () => {
  await page.waitForFunction(() => !!document.querySelector("#headline .ann.quest.show"), null, { timeout: 12000 });
  await page.evaluate(() => {
    const el = document.querySelector("#headline .ann.quest.show");
    const copy = el.cloneNode(true);
    copy.style.opacity = "1";
    copy.style.transform = "none";
    copy.dataset.pin = "1";
    el.replaceWith(copy);
  });
};
const sweepBanner = async () => {
  await page.evaluate(() => {
    for (const e of document.querySelectorAll("#headline [data-pin]")) e.remove();
  });
};
const dismiss = async () => {
  await page.evaluate(() => {
    for (const b of document.querySelectorAll("button")) {
      const t = (b.textContent || "").trim().toUpperCase();
      if (t === "GOT IT" || t === "OK" || t === "DISMISS") b.click();
    }
  }).catch(() => {});
};

// ---- Into the campaign: menu -> ROAM -> casting -> go ----
await page.click("#m-roam-solo");
await page.waitForTimeout(700);
await page.click("#m-cast-go");
await page.waitForFunction(() => {
  const s = window.__dcc?.state;
  return s && s.runKind === "roam" && s.status === "playing" && (s.npcs?.length ?? 0) > 0;
}, null, { timeout: 60000 });
await page.waitForTimeout(2500);
await dismiss();

// Helpers on the live state.
const teleport = async (x, y) => {
  await page.evaluate(([tx, ty]) => {
    const s = window.__dcc.state;
    s.players[0].pos = { x: tx, y: ty };
  }, [x, y]);
  await page.waitForTimeout(400);
};
const npcByRole = async (role) => page.evaluate((r) => {
  const s = window.__dcc.state;
  const list = s.npcs ?? [];
  const n = list.find((x) => x.role === r) ?? list[0];
  return n ? { x: n.pos.x, y: n.pos.y, id: n.id, name: n.name } : null;
}, role);
// Stand AT the target (residents cluster; the sim talks to the nearest one),
// press E, and verify the session is with the right resident.
const talkTo = async (npc) => {
  await teleport(npc.x + 0.35, npc.y + 0.2);
  await page.keyboard.press("e");
  await page.waitForFunction(
    (id) => window.__dcc.state.dialogue?.npcId === id,
    npc.id,
    { timeout: 8000 },
  );
};

// 1) Settlement approach: arrive at an OUTLYING settlement (the crawler
//    spawns inside the entrance one, so its plaque already fired at boot) —
//    plaque fades in over the camp, pennant lands on the chart.
const outlying = await page.evaluate(() => {
  const s = window.__dcc.state;
  const st = (s.settlements ?? [])[1] ?? (s.settlements ?? [])[0];
  const r = s.map.rooms[st.roomIdx];
  return { cx: r.x + r.w / 2, cy: r.y + r.h / 2, name: st.name };
});
console.log("outlying settlement:", outlying.name);
await teleport(outlying.cx, outlying.cy + 1);
await page.waitForTimeout(1400); // plaque fade-in
await dismiss();
await shot("roam-settlement-arrival.png");
// back to the entrance camp for the rest of the flow
const entrance = await page.evaluate(() => {
  const s = window.__dcc.state;
  const st = (s.settlements ?? [])[0];
  const r = s.map.rooms[st.roomIdx];
  return { cx: r.x + r.w / 2, cy: r.y + r.h / 2, name: st.name };
});
await teleport(entrance.cx, entrance.cy + 1);
await page.waitForTimeout(500);

// 2) Guide moment: stand at Mordecai's elbow, talk.
const guide = await npcByRole("guide");
await talkTo(guide);
await page.waitForTimeout(2600); // typewriter
await shot("roam-dialogue-mordecai.png");

// 3) Orientation: the guide paints the chart (reveal + deferred mm flash).
await page.evaluate(() => {
  const btn = document.querySelector('.dlg-choice[data-choice="orient"]');
  if (btn) btn.click();
});
await page.waitForTimeout(2400);
await shot("roam-dialogue-orient.png");
await page.keyboard.press("Escape");
await page.waitForTimeout(900); // mm flash + plates back
await shot("roam-after-orient-map.png");

// 4) The elder's contract: numbered choices with the quest accept.
const cullGiver = await page.evaluate(() => {
  const s = window.__dcc.state;
  const q = s.quests.find((x) => x.key === "cull") ?? s.quests[0];
  const n = (s.npcs ?? []).find((x) => x.id === q.giverNpcId);
  return n ? { x: n.pos.x, y: n.pos.y, id: n.id, name: n.name, qtitle: q.title } : null;
});
console.log("cull giver:", cullGiver?.name);
await talkTo(cullGiver);
await page.waitForTimeout(3000);
await shot("roam-dialogue-elder-offer.png");
await page.evaluate(() => {
  const btn = [...document.querySelectorAll(".dlg-choice")].find((b) => (b.dataset.choice || "").startsWith("accept:"));
  if (btn) btn.click();
});
await page.waitForTimeout(700);
await page.keyboard.press("Escape");
// The beat buffers behind the modal (and any in-flight System banner) — poll.
await pinBanner();
await shot("roam-quest-accepted-banner.png");
await sweepBanner();

// 5) Tracker + chart pins, standing in the camp.
await shot("roam-tracker-and-pins.png");

// 6) The outfitter: trader vendor choice opens the settlement shop.
const trader = await npcByRole("trader");
await talkTo(trader);
await page.waitForTimeout(1200);
await page.evaluate(() => {
  const btn = document.querySelector('.dlg-choice[data-choice="vendor"]');
  if (btn) btn.click();
});
await page.waitForFunction(() => document.getElementById("saferoom").style.display === "flex", null, { timeout: 8000 });
await page.waitForTimeout(900);
await shot("roam-outfitter.png");
await page.click("#sr-descend"); // BACK TO THE STREET
await page.waitForTimeout(600);

// 7) Contract settled: credit the cull, turn in with the elder, claim.
await page.evaluate(() => {
  const s = window.__dcc.state;
  const q = s.quests.find((x) => x.key === "cull");
  if (q && q.objective.kind === "killTribe") q.objective.killed = q.objective.target;
});
await page.waitForTimeout(600);
await shot("roam-tracker-done.png");
await talkTo(cullGiver);
await page.waitForTimeout(1400);
await page.evaluate(() => {
  const btn = [...document.querySelectorAll(".dlg-choice")].find((b) => (b.dataset.choice || "").startsWith("turnin:"));
  if (btn) btn.click();
});
await page.waitForTimeout(1200); // reward draft opens over the conversation
await shot("roam-turnin-draft.png");
await page.evaluate(() => {
  const card = document.querySelector("#draft-cards .reward[data-idx]");
  if (card) card.click();
});
await page.waitForTimeout(400);
await page.keyboard.press("Escape");
await pinBanner();
await shot("roam-quest-complete-banner.png");
await sweepBanner();

// 8) The campaign card: reload — the menu's ROAM tile shows the live save.
await page.reload({ waitUntil: "load", timeout: 60000 });
await page.waitForFunction(() => document.documentElement.dataset.assetsSettled === "1", null, { timeout: 120000 });
await page.waitForFunction(() => {
  const el = document.getElementById("loading");
  return !el || getComputedStyle(el).display === "none";
}, null, { timeout: 90000 });
await page.waitForTimeout(2200);
await shot("roam-menu-campaign-card.png");

await browser.close();
console.log("done");
