import {
  createGame, restoreGame, step, equipFromInventory, chooseReward, chooseUpgrade,
  buyShopItem, setReady, addPlayer,
} from "./sim/game";
import { ACHIEVEMENTS } from "./sim/achievements";
import { affixLines, itemScore } from "./sim/items";
import { Tile, type GameState, type HitEvent, type Item } from "./sim/types";
import { CONFIG } from "./sim/config";
import {
  ABILITY_INFO, DISCOVERABLE_ABILITIES, STARTING_ABILITIES, UPGRADES,
  boltParams, dashParams, knows, novaParams, rank,
} from "./sim/abilities";
import { InputController } from "./input/input";
import { Renderer3D } from "./render3d/renderer3d";
import { clearRun, loadRun, saveRun } from "./persist/save";

// 3D isometric host: runs the exact same deterministic sim as the 2D slice, but
// renders it through the Three.js isometric renderer. Proves the art direction and
// that rendering is fully decoupled from gameplay (same sim, two views).

const SIM_HZ = 60;
const SIM_DT = 1 / SIM_HZ;
const MAX_FRAME = 0.1;

const canvas = document.getElementById("game") as HTMLCanvasElement;
const renderer = new Renderer3D(canvas);

function resize(): void {
  renderer.resize(window.innerWidth, window.innerHeight);
}
window.addEventListener("resize", resize);
resize();

function freshSeed(): number {
  return (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
}
function startFresh(): GameState {
  clearRun();
  const g = createGame(freshSeed());
  saveRun(g);
  return g;
}
function boot(): GameState {
  const save = loadRun();
  if (save && save.status === "playing") return restoreGame(save);
  return startFresh();
}

let state = boot();
const log: string[] = [`Entered floor ${state.floor}. Descend to floor ${CONFIG.finalFloor}.`];

const input = new InputController(canvas);
input.onReset = () => {
  state = startFresh();
  log.length = 0;
  log.push(`New run. Descend to floor ${CONFIG.finalFloor}.`);
  if (invOpen) toggleInventory(); // close stale panels from the old run
  if (abilOpen) toggleAbilities();
  document.getElementById("saferoom")!.style.display = "none";
  document.getElementById("draft")!.style.display = "none";
};

// HUD elements.
const hudTL = document.getElementById("hud-tl")!;
const hudTR = document.getElementById("hud-tr")!;
const hudLog = document.getElementById("hud-log")!;
const fxLayer = document.getElementById("fx")!;
const toastLayer = document.getElementById("toast")!;
const dashCd = document.querySelector("#skill-dash .cd > i") as HTMLElement;
const boltCd = document.querySelector("#skill-bolt .cd > i") as HTMLElement;
const dashSkill = document.getElementById("skill-dash")!;
const boltSkill = document.getElementById("skill-bolt")!;
const minimap = document.getElementById("minimap") as HTMLCanvasElement;
const mmCtx = minimap.getContext("2d")!;

const RARITY_COLORS: Record<string, string> = {
  common: "#c9c9d4", magic: "#5a9bff", rare: "#f2c14e", epic: "#b98bff",
};

// ---- The Show: audience bar + sponsor draft ----
const statViewers = document.getElementById("stat-viewers")!;
const statFavorites = document.getElementById("stat-favorites")!;
const statSponsors = document.getElementById("stat-sponsors")!;
const draftEl = document.getElementById("draft")!;
const draftCards = document.getElementById("draft-cards")!;
let shownSponsors = 0;
let shownViewers = 0;

function bump(el: HTMLElement): void {
  const chip = el.closest(".stat") as HTMLElement | null;
  if (!chip) return;
  chip.classList.remove("bump");
  void chip.offsetWidth; // restart animation
  chip.classList.add("bump");
}

function updateShowHud(s: GameState): void {
  const v = Math.round(s.viewers);
  statViewers.textContent = v.toLocaleString();
  statFavorites.textContent = Math.floor(s.favorites).toLocaleString();
  statSponsors.textContent = String(s.sponsors);
  if (s.sponsors !== shownSponsors) { shownSponsors = s.sponsors; bump(statSponsors); }
  // Pop the viewer chip on a big surge (exciting moment).
  if (v > shownViewers * 1.25 && v > 500) bump(statViewers);
  shownViewers = v;
}

const RARITY_TEXT: Record<string, string> = {
  common: "#c9c9d4", magic: "#7fb0ff", rare: "#f2c14e", epic: "#c9a6ff",
};

const draftTitle = document.getElementById("draft-title")!;
const draftHint = document.getElementById("draft-hint")!;

// One modal serves both drafts; sponsor gifts take priority if ever both pend.
function renderDraft(s: GameState): void {
  const lp = s.players[0];
  if (lp.pendingRewards.length > 0) {
    draftEl.classList.remove("levelup");
    draftTitle.textContent = "◆ SPONSOR DRAFT";
    draftHint.textContent = "Your sponsors reward a good show. Choose one gift to carry down.";
    draftCards.innerHTML = lp.pendingRewards
      .map((r, i) => {
        const color = r.item ? RARITY_TEXT[r.item.rarity] : "#e6e6ec";
        return (
          `<div class="reward" data-idx="${i}">` +
          `<div class="rtitle" style="color:${color}">${r.title}</div>` +
          `<div class="rdesc">${r.desc}</div>` +
          `</div>`
        );
      })
      .join("");
  } else {
    draftEl.classList.add("levelup");
    draftTitle.textContent = "◆ LEVEL UP";
    draftHint.textContent = "The System offers an evolution. Choose one upgrade.";
    draftCards.innerHTML = lp.pendingUpgrades
      .map((u, i) =>
        `<div class="reward" data-idx="${i}">` +
        `<div class="rability">${ABILITY_INFO[u.ability].name}</div>` +
        `<div class="rtitle">${u.title}</div>` +
        `<div class="rdesc">${u.desc}</div>` +
        `</div>`,
      )
      .join("");
  }
}

draftCards.addEventListener("click", (e) => {
  const card = (e.target as HTMLElement).closest(".reward") as HTMLElement | null;
  if (!card || card.dataset.idx === undefined) return;
  const me = state.players[0];
  if (me.pendingRewards.length > 0) chooseReward(state, me.id, Number(card.dataset.idx));
  else chooseUpgrade(state, me.id, Number(card.dataset.idx));
  flushFeedback(state);
  saveRun(state);
  draftEl.style.display = "none";
});

// ---- Inventory panel (pauses the game while open) ----
const invEl = document.getElementById("inv")!;
const invEquipped = document.getElementById("inv-equipped")!;
const invBag = document.getElementById("inv-bag")!;
let invOpen = false;

function itemCard(item: Item, opts: { bag?: boolean; idx?: number } = {}): string {
  const cls = `item rar-${item.rarity}${opts.bag ? " bag" : ""}`;
  const idx = opts.bag ? ` data-idx="${opts.idx}"` : "";
  return (
    `<div class="${cls}"${idx}>` +
    `<div class="name">${item.name}</div>` +
    `<div class="slot">${item.slot} · ${item.rarity}</div>` +
    `<div class="affixes">${affixLines(item).join(" · ") || "—"}</div>` +
    `</div>`
  );
}

function renderInventory(s: GameState): void {
  const p = s.players[0];
  invEquipped.innerHTML = (["weapon", "armor", "trinket"] as const)
    .map((slot) => {
      const it = p.equipment[slot];
      return it
        ? itemCard(it)
        : `<div class="item empty rar-common">${slot}: empty</div>`;
    })
    .join("");
  // Bag sorted best-first so upgrades are easy to spot.
  const bag = p.inventory
    .map((item, idx) => ({ item, idx }))
    .sort((a, b) => itemScore(b.item) - itemScore(a.item));
  invBag.innerHTML = bag.length
    ? bag.map(({ item, idx }) => itemCard(item, { bag: true, idx })).join("")
    : `<div class="item empty rar-common">Bag is empty</div>`;
}

function toggleInventory(): void {
  invOpen = !invOpen;
  invEl.style.display = invOpen ? "flex" : "none";
  if (invOpen) renderInventory(state);
}

// Delegated click: equip the clicked bag item, persist, and refresh the panel.
invBag.addEventListener("click", (e) => {
  const card = (e.target as HTMLElement).closest(".item.bag") as HTMLElement | null;
  if (!card || card.dataset.idx === undefined) return;
  equipFromInventory(state, state.players[0].id, Number(card.dataset.idx));
  saveRun(state);
  renderInventory(state);
});

// ---- Ability tree panel (pauses the game while open) ----
const abilEl = document.getElementById("abil")!;
const abilGrid = document.getElementById("abil-grid")!;
let abilOpen = false;

function abilityCard(s: GameState, id: (typeof STARTING_ABILITIES)[number]): string {
  const p = s.players[0];
  const info = ABILITY_INFO[id];
  if (!knows(p, id)) {
    return (
      `<div class="abil-card unknown">` +
      `<div class="aname">??? <span class="akey">undiscovered</span></div>` +
      `<div class="ablurb">Find an ability tome in the dungeon to learn this.</div>` +
      `</div>`
    );
  }
  const nodes = UPGRADES.filter((u) => u.ability === id)
    .map((u) => {
      const r = rank(p, u.id);
      const dots =
        "●".repeat(r) + `<span class="empty">${"●".repeat(u.maxRank - r)}</span>`;
      return (
        `<div class="abil-node${r >= u.maxRank ? " maxed" : ""}">` +
        `<span>${u.title}</span><span class="ranks">${dots}</span>` +
        `</div>`
      );
    })
    .join("");
  return (
    `<div class="abil-card">` +
    `<div class="aname">${info.name} <span class="akey">${info.key}</span></div>` +
    `<div class="ablurb">${info.blurb}</div>` +
    nodes +
    `</div>`
  );
}

const achGrid = document.getElementById("ach-grid")!;
const achCount = document.getElementById("ach-count")!;

function renderAbilities(s: GameState): void {
  const all = [...STARTING_ABILITIES, ...DISCOVERABLE_ABILITIES];
  abilGrid.innerHTML = all.map((id) => abilityCard(s, id)).join("");
  achCount.textContent = `${s.players[0].achievements.length} / ${ACHIEVEMENTS.length}`;
  achGrid.innerHTML = ACHIEVEMENTS.map((a) => {
    const got = s.players[0].achievements.includes(a.id);
    return (
      `<div class="ach${got ? "" : " locked"}">` +
      `<div class="atitle">${got ? "★ " : "☆ "}${a.title}</div>` +
      `<div class="adesc">${a.desc}</div>` +
      `</div>`
    );
  }).join("");
}

function toggleAbilities(): void {
  abilOpen = !abilOpen;
  abilEl.style.display = abilOpen ? "flex" : "none";
  if (abilOpen) renderAbilities(state);
}

window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "i") toggleInventory();
  else if (k === "t") toggleAbilities();
  else if (k === "escape" && invOpen) toggleInventory();
  else if (k === "escape" && abilOpen) toggleAbilities();
});

// ---- Safe room (between floors; pauses the sim until DESCEND) ----
const srEl = document.getElementById("saferoom")!;
const srTip = document.getElementById("sr-tip")!;
const srGold = document.getElementById("sr-gold")!;
const srStock = document.getElementById("sr-stock")!;
const srDescend = document.getElementById("sr-descend")!;

function renderSafeRoom(s: GameState): void {
  const room = s.safeRoom;
  if (!room) return;
  srTip.textContent = room.tip;
  srGold.textContent = `Your gold: ${s.players[0].gold}`;
  srStock.innerHTML = room.stock
    .map((it, i) => {
      const cls = it.sold ? " sold" : s.players[0].gold < it.price ? " broke" : "";
      return (
        `<div class="shop-item${cls}" data-idx="${i}">` +
        `<div class="stitle">${it.title}</div>` +
        `<div class="sdesc">${it.desc}</div>` +
        `<div class="sprice">${it.price} gold</div>` +
        `</div>`
      );
    })
    .join("");
}

// Clicks happen while the sim is paused, so announcements produced by the action
// (achievement unlocks, NEW ABILITY) would be cleared unseen by the next step —
// surface them immediately.
function flushFeedback(s: GameState): void {
  for (const a of s.announcements) showAnnouncement(a);
  for (const e of s.events) log.push(e);
  s.announcements = [];
  s.events = [];
}

srStock.addEventListener("click", (e) => {
  const card = (e.target as HTMLElement).closest(".shop-item") as HTMLElement | null;
  if (!card || card.dataset.idx === undefined) return;
  buyShopItem(state, state.players[0].id, Number(card.dataset.idx));
  flushFeedback(state);
  saveRun(state);
  renderSafeRoom(state); // refresh sold/affordability states
});

srDescend.addEventListener("click", () => {
  setReady(state, state.players[0].id);
  flushFeedback(state);
  saveRun(state);
  srEl.style.display = "none";
});

// Cooldown UI shows "fraction remaining"; empties as the skill recharges.
const novaCdEl = document.querySelector("#skill-nova .cd > i") as HTMLElement;
const novaSkill = document.getElementById("skill-nova")!;

function updateSkills(s: GameState): void {
  const p = s.players[0];
  const dFrac = Math.max(0, Math.min(1, p.dashCd / dashParams(p).cooldown));
  const bFrac = Math.max(0, Math.min(1, p.boltCd / boltParams(p).cooldown));
  dashCd.style.width = `${dFrac * 100}%`;
  boltCd.style.width = `${bFrac * 100}%`;
  dashSkill.classList.toggle("ready", p.dashCd === 0);
  boltSkill.classList.toggle("ready", p.boltCd === 0);
  // Nova chip appears once the ability is discovered.
  const hasNova = knows(p, "nova");
  novaSkill.style.display = hasNova ? "" : "none";
  if (hasNova) {
    const nFrac = Math.max(0, Math.min(1, p.novaCd / novaParams(p).cooldown));
    novaCdEl.style.width = `${nFrac * 100}%`;
    novaSkill.classList.toggle("ready", p.novaCd === 0);
  }
}

// Top-down minimap: explored floor only (fog of war), stairs once seen,
// monsters only while inside the vision radius, and the player (cyan).
function drawMinimap(s: GameState): void {
  const map = s.map;
  const W = minimap.width, H = minimap.height, pad = 6;
  const sx = (W - pad * 2) / map.w, sy = (H - pad * 2) / map.h;
  mmCtx.clearRect(0, 0, W, H);
  for (let y = 0; y < map.h; y++) {
    for (let x = 0; x < map.w; x++) {
      const i = y * map.w + x;
      if (!s.explored[i]) continue;
      const t = map.tiles[i];
      if (t === Tile.Wall) continue;
      mmCtx.fillStyle = t === Tile.StairsDown ? "#c9a24b" : "#2c2c40";
      mmCtx.fillRect(pad + x * sx, pad + y * sy, Math.ceil(sx), Math.ceil(sy));
    }
  }
  const vis2 = CONFIG.fogVisionRadius * CONFIG.fogVisionRadius;
  for (const m of s.monsters) {
    const dx = m.pos.x - s.players[0].pos.x, dy = m.pos.y - s.players[0].pos.y;
    if (dx * dx + dy * dy > vis2) continue;
    mmCtx.fillStyle = m.kind === "boss" ? "#ff3b3b" : "#e2574c";
    const r = m.kind === "boss" ? 3.5 : 2;
    mmCtx.beginPath();
    mmCtx.arc(pad + m.pos.x * sx, pad + m.pos.y * sy, r, 0, Math.PI * 2);
    mmCtx.fill();
  }
  for (const pl of s.players) {
    mmCtx.fillStyle = pl.id === s.players[0].id ? "#4fd1ff" : "#7be89b";
    mmCtx.beginPath();
    mmCtx.arc(pad + pl.pos.x * sx, pad + pl.pos.y * sy, 3, 0, Math.PI * 2);
    mmCtx.fill();
  }
}

const HIT_COLORS: Record<HitEvent["kind"], string> = {
  enemy: "#ffb347", crit: "#ffe066", player: "#ff5a4d",
  heal: "#5fd08a", gold: "#f2c14e", weapon: "#b98bff",
};

// Floating combat numbers: project a world hit to screen and float it upward.
function spawnDamageNumber(h: HitEvent): void {
  const s = renderer.worldToScreen(h.pos.x, 0.7, h.pos.y);
  if (!s.visible) return;
  const el = document.createElement("div");
  el.className = h.kind === "crit" ? "dmg crit" : "dmg";
  el.style.color = HIT_COLORS[h.kind];
  el.style.left = `${s.x}px`;
  el.style.top = `${s.y}px`;
  const sign = h.kind === "heal" || h.kind === "gold" || h.kind === "weapon" ? "+" : "";
  el.textContent = h.kind === "crit" ? `${h.amount}!` : `${sign}${h.amount}`;
  fxLayer.appendChild(el);
  // Kick off the float+fade on the next frame so the transition applies.
  requestAnimationFrame(() => {
    const drift = (Math.random() - 0.5) * 40;
    el.style.transform = `translate(calc(-50% + ${drift}px), calc(-50% - 46px))`;
    el.style.opacity = "0";
  });
  setTimeout(() => el.remove(), 850);
}

// DCC "System" announcer toast.
function showAnnouncement(text: string): void {
  const el = document.createElement("div");
  el.className = "ann";
  el.textContent = text;
  toastLayer.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 400); }, 2600);
}

function phaseColor(s: GameState): string {
  return s.phase === "safe" ? "#5fd08a" : s.phase === "warning" ? "#f2c14e" : "#e2574c";
}
function fmt(t: number): string {
  const c = Math.max(0, t);
  return `${Math.floor(c / 60)}:${Math.floor(c % 60).toString().padStart(2, "0")}`;
}
function updateHud(s: GameState): void {
  const p = s.players[0];
  const tf = Math.max(0, Math.min(1, s.timeRemaining / s.timeBudget));
  hudTL.innerHTML =
    `Floor ${s.floor} / ${CONFIG.finalFloor}<br>` +
    `<span style="color:${phaseColor(s)}">Collapse ${fmt(s.timeRemaining)} · ${s.phase.toUpperCase()}</span>` +
    `<div class="bar"><i style="width:${tf * 100}%;background:${phaseColor(s)}"></i></div>`;
  const rc = RARITY_COLORS[p.weaponRarity] ?? "#c9c9d4";
  hudTR.innerHTML =
    `Level ${p.level} · ${p.gold} gold · ` +
    `<span style="color:${rc}">DMG ${p.baseDamage} (${p.weaponRarity})</span><br>` +
    `HP ${Math.ceil(p.hp)} / ${p.maxHp}` +
    `<div class="bar"><i style="width:${Math.max(0, (p.hp / p.maxHp) * 100)}%;background:#e2574c"></i></div>` +
    `<div class="bar"><i style="width:${(p.xp / p.xpToNext) * 100}%;background:#4fd1ff"></i></div>`;
  hudLog.innerHTML = log.slice(-5).join("<br>");
  if (s.status !== "playing") {
    hudLog.innerHTML +=
      `<br><b style="color:${s.status === "won" ? "#5fd08a" : "#e2574c"}">` +
      `${s.status === "won" ? "YOU ESCAPED" : "YOU DIED"} — press R for a new run</b>` +
      `<br>Final show: ${Math.round(s.viewers).toLocaleString()} viewers · ` +
      `${Math.floor(s.favorites).toLocaleString()} favorites · ${s.sponsors} sponsors`;
  }
}

// Optional debug hook (enable with ?debug=1). Exposes live state + renderer so tests
// and manual debugging can stage scenarios; off by default, no effect in normal play.
if (new URLSearchParams(location.search).has("debug")) {
  (window as unknown as { __dcc: unknown }).__dcc = {
    get state() { return state; },
    renderer,
    addPlayer: (name: string) => addPlayer(state, name),
    step: (intents: Parameters<typeof step>[1], dt: number) => step(state, intents, dt),
  };
}

let lastFloor = state.floor;
let lastStatus = state.status;
let saveAcc = 0;
let prev = performance.now();
let acc = 0;

async function main(): Promise<void> {
  await renderer.init();

  function frame(now: number): void {
    let dt = (now - prev) / 1000;
    prev = now;
    if (dt > MAX_FRAME) dt = MAX_FRAME;
    acc += dt;

    // Player is centered by the follow-camera; attacks use movement facing (no
    // screen->iso aim mapping for the slice), so skip mouse aim here.
    const center = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    // Buffer feedback across every sub-step (step() clears these each call).
    const frameHits: typeof state.hits = [];
    const frameAnns: string[] = [];
    // The inventory/ability panels, pending drafts, and the safe room all pause
    // the sim; drop accumulated time so it doesn't fast-forward on resume.
    const draftPending = state.players[0].pendingRewards.length > 0 || state.players[0].pendingUpgrades.length > 0;
    if (draftEl.style.display !== "flex" && draftPending) {
      renderDraft(state);
      draftEl.style.display = "flex";
    }
    const inSafeRoom = state.safeRoom !== null;
    if (srEl.style.display !== "flex" && inSafeRoom && !draftPending) {
      renderSafeRoom(state);
      srEl.style.display = "flex";
    }
    if (invOpen || abilOpen || draftPending || inSafeRoom) acc = 0;
    while (acc >= SIM_DT) {
      step(state, input.sample(center, false), SIM_DT);
      for (const e of state.events) log.push(e);
      frameHits.push(...state.hits);
      frameAnns.push(...state.announcements);
      acc -= SIM_DT;
      if (state.floor !== lastFloor) { lastFloor = state.floor; saveRun(state); }
      if (state.status !== lastStatus) { lastStatus = state.status; saveRun(state); }
    }

    saveAcc += dt;
    if (saveAcc > 3 && state.status === "playing") { saveAcc = 0; saveRun(state); }

    // Particles + shake use world space, so they can fire before the camera moves.
    renderer.emitHits(frameHits);
    renderer.update(state, now / 1000);
    renderer.render();
    // Damage numbers need the camera positioned (done in update) to project.
    for (const h of frameHits) spawnDamageNumber(h);
    for (const a of frameAnns) showAnnouncement(a);
    updateHud(state);
    updateSkills(state);
    updateShowHud(state);
    drawMinimap(state);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

void main();
