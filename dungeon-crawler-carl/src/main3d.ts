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
import {
  ACTION_INFO, DEFAULT_BINDINGS, bindingLabel, loadBindings, loadMouseAim, rebind,
  saveBindings, saveMouseAim, type BindableAction, type Bindings,
} from "./input/bindings";
import { Renderer3D } from "./render3d/renderer3d";
import { AudioEngine } from "./audio/engine";
import { AudioDirector } from "./audio/director";
import { clearRun, loadRun, saveRun } from "./persist/save";
import { NetClient } from "./net/netClient";

// 3D isometric host: runs the exact same deterministic sim as the 2D slice, but
// renders it through the Three.js isometric renderer. Proves the art direction and
// that rendering is fully decoupled from gameplay (same sim, two views).

const SIM_HZ = 60;
const SIM_DT = 1 / SIM_HZ;
const MAX_FRAME = 0.1;

const canvas = document.getElementById("game") as HTMLCanvasElement;
const renderer = new Renderer3D(canvas);

// Audio seam: same consumer pattern as particles/damage numbers, fed from the
// per-frame feedback buffers. Silent until clips exist under public/audio/
// (see ASSETS.md — Audio); missing files simply never play.
const audio = new AudioEngine();
void audio.load();
const audioDirector = new AudioDirector(audio);

// ---- Network mode (?join=CODE[&name=...][&server=ws://host:5281]) ----
// Local mode runs the sim in-page; network mode renders authoritative snapshots
// from the server and forwards intents/actions. Same renderer, same UI.
const params = new URLSearchParams(location.search);
const joinCode = params.get("join");
const net = joinCode ? new NetClient() : null;
const playerName =
  params.get("name") ?? (joinCode ? (prompt("Crawler name?") || "Crawler") : "Carl");
// Server URL: explicit ?server= wins. In dev (vite on :5280) the game server is
// the sibling process on :5281; in production the SAME origin serves both the
// site and the WebSocket, and wss follows https automatically.
const serverUrl =
  params.get("server") ??
  (import.meta.env.DEV
    ? `ws://${location.hostname}:5281`
    : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);
let localId = 0;
const me = (s: GameState) => s.players.find((p) => p.id === localId) ?? s.players[0];

let mouseAim = loadMouseAim();
canvas.style.cursor = mouseAim ? "crosshair" : "default"; // crosshair only when aiming

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

let state = net ? createGame(0) : boot(); // net: placeholder until the welcome snapshot
const log: string[] = [`Entered floor ${state.floor}. Descend to floor ${CONFIG.finalFloor}.`];

const input = new InputController(canvas);
input.onReset = () => {
  if (net) return; // the server owns the run in network mode
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
  const p = me(s);
  const v = Math.round(p.viewers);
  statViewers.textContent = v.toLocaleString();
  statFavorites.textContent = Math.floor(p.favorites).toLocaleString();
  statSponsors.textContent = String(p.sponsors);
  if (p.sponsors !== shownSponsors) { shownSponsors = p.sponsors; bump(statSponsors); }
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
  const lp = me(s);
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
  const idx = Number(card.dataset.idx);
  const p = me(state);
  audio.play("buy");
  if (net) {
    net.choose(p.pendingRewards.length > 0 ? "reward" : "upgrade", idx);
  } else {
    if (p.pendingRewards.length > 0) chooseReward(state, p.id, idx);
    else chooseUpgrade(state, p.id, idx);
    flushFeedback(state);
    saveRun(state);
  }
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
  const p = me(s);
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
  const idx = Number(card.dataset.idx);
  audio.play("equip");
  if (net) net.equip(idx);
  else {
    equipFromInventory(state, me(state).id, idx);
    saveRun(state);
  }
  renderInventory(state);
});

// ---- Ability tree panel (pauses the game while open) ----
const abilEl = document.getElementById("abil")!;
const abilGrid = document.getElementById("abil-grid")!;
let abilOpen = false;

function abilityCard(s: GameState, id: (typeof STARTING_ABILITIES)[number]): string {
  const p = me(s);
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
const statsRows = document.getElementById("stats-rows")!;

function renderAbilities(s: GameState): void {
  const all = [...STARTING_ABILITIES, ...DISCOVERABLE_ABILITIES];
  abilGrid.innerHTML = all.map((id) => abilityCard(s, id)).join("");
  achCount.textContent = `${me(s).achievements.length} / ${ACHIEVEMENTS.length}`;
  achGrid.innerHTML = ACHIEVEMENTS.map((a) => {
    const got = me(s).achievements.includes(a.id);
    return (
      `<div class="ach${got ? "" : " locked"}">` +
      `<div class="atitle">${got ? "★ " : "☆ "}${a.title}</div>` +
      `<div class="adesc">${a.desc}</div>` +
      `</div>`
    );
  }).join("");
  // Run stats: one row per party member (solo runs show just the local player).
  const localId = me(s).id;
  statsRows.innerHTML = s.players.map((p) => {
    const you = p.id === localId;
    return (
      `<tr class="${[you ? "you" : "", p.alive ? "" : "dead"].filter(Boolean).join(" ")}">` +
      `<td>${p.name}${you ? " (you)" : ""}</td>` +
      `<td>${p.level}</td>` +
      `<td>${p.kills}</td>` +
      `<td>${Math.round(p.damageDealt).toLocaleString()}</td>` +
      `<td>${Math.round(p.damageTaken).toLocaleString()}</td>` +
      `<td>${Math.round(p.viewers).toLocaleString()}</td>` +
      `<td>${p.sponsors}</td>` +
      `</tr>`
    );
  }).join("");
}

function toggleAbilities(): void {
  abilOpen = !abilOpen;
  abilEl.style.display = abilOpen ? "flex" : "none";
  if (abilOpen) renderAbilities(state);
}

// ---- Key bindings (rebindable; persisted per browser) ----
let bindings: Bindings = loadBindings();
const keysEl = document.getElementById("keys")!;
const kbRows = document.getElementById("kb-rows")!;
let kbOpen = false;
let listening: BindableAction | null = null;

function applyBindings(): void {
  input.setBindings(bindings);
  const first = (a: BindableAction) => bindingLabel(bindings, a).split(" / ")[0];
  // Banner + skill chips + panel hints render from the live bindings.
  const wasd = [first("moveUp"), first("moveLeft"), first("moveDown"), first("moveRight")].join("");
  document.getElementById("banner-keys")!.innerHTML =
    `<kbd>${wasd === "WASD" ? "WASD" : wasd}</kbd> move · ` +
    `<kbd>${first("attack")}</kbd>/LMB attack · ` +
    `<kbd>${first("bolt")}</kbd>/RMB bolt · ` +
    `<kbd>${first("dash")}</kbd> dash · ` +
    `<kbd>${first("nova")}</kbd> nova · ` +
    `<kbd>${first("inventory")}</kbd> inv · ` +
    `<kbd>${first("abilities")}</kbd> abilities · ` +
    `<kbd>${first("keybinds")}</kbd> keys · ` +
    `<kbd>${first("stairs")}</kbd> stairs · ` +
    `<kbd>${first("newRun")}</kbd> new run · ` +
    `<kbd>${first("mute")}</kbd> mute` + (mouseAim ? " · aim with mouse" : "");
  (document.querySelector("#skill-dash .key") as HTMLElement).textContent = first("dash");
  (document.querySelector("#skill-bolt .key") as HTMLElement).textContent = `${first("bolt")} / RMB`;
  (document.querySelector("#skill-nova .key") as HTMLElement).textContent = first("nova");
  document.getElementById("kb-close-key")!.textContent = first("keybinds");
}

function renderKeybinds(): void {
  kbRows.innerHTML = (Object.keys(ACTION_INFO) as BindableAction[])
    .map((a) => {
      const info = ACTION_INFO[a];
      const cls = listening === a ? "kb-key listening" : "kb-key";
      const label = listening === a ? "press a key…" : bindingLabel(bindings, a);
      return (
        `<div class="kb-row"><span class="kb-name">${info.name}` +
        (info.hint ? `<small>${info.hint}</small>` : "") +
        `</span><span class="${cls}" data-action="${a}">${label}</span></div>`
      );
    })
    .join("");
}

function toggleKeybinds(): void {
  kbOpen = !kbOpen;
  keysEl.style.display = kbOpen ? "flex" : "none";
  listening = null;
  input.captureMode = false;
  if (kbOpen) renderKeybinds();
}

kbRows.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest(".kb-key") as HTMLElement | null;
  if (!el || !el.dataset.action) return;
  listening = el.dataset.action as BindableAction;
  input.captureMode = true; // gameplay keys off while we capture
  renderKeybinds();
});

const kbMouseAim = document.getElementById("kb-mouseaim")!;
function renderMouseAim(): void {
  kbMouseAim.textContent = mouseAim ? "ON" : "OFF";
}
kbMouseAim.addEventListener("click", () => {
  mouseAim = !mouseAim;
  saveMouseAim(mouseAim);
  canvas.style.cursor = mouseAim ? "crosshair" : "default";
  renderMouseAim();
  applyBindings(); // refresh the banner hint
});
renderMouseAim();

document.getElementById("kb-reset")!.addEventListener("click", () => {
  bindings = { ...DEFAULT_BINDINGS };
  saveBindings(bindings);
  applyBindings();
  renderKeybinds();
});

window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (listening) {
    e.preventDefault();
    if (k !== "escape") {
      bindings = rebind(bindings, listening, k);
      saveBindings(bindings);
      applyBindings();
    }
    listening = null;
    input.captureMode = false;
    renderKeybinds();
    return;
  }
  if (k === "escape") {
    if (invOpen) toggleInventory();
    else if (abilOpen) toggleAbilities();
    else if (kbOpen) toggleKeybinds();
  }
});

input.onAction = (a) => {
  if (a === "inventory") toggleInventory();
  else if (a === "abilities") toggleAbilities();
  else if (a === "keybinds") toggleKeybinds();
  else if (a === "mute") log.push(`Sound ${audio.toggleMute() ? "muted" : "on"}.`);
};
applyBindings();

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
  srGold.textContent = `Your gold: ${me(s).gold}`;
  if (s.safeRoom && s.players.length > 1) {
    srGold.textContent += ` · ready ${s.safeRoom.ready.length}/${s.players.length}`;
  }
  srStock.innerHTML = room.stock
    .map((it, i) => {
      const cls = it.sold ? " sold" : me(s).gold < it.price ? " broke" : "";
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
  const idx = Number(card.dataset.idx);
  const stock = state.safeRoom?.stock[idx];
  if (stock && !stock.sold && me(state).gold >= stock.price) audio.play("buy");
  if (net) net.buy(idx);
  else {
    buyShopItem(state, me(state).id, idx);
    flushFeedback(state);
    saveRun(state);
    renderSafeRoom(state); // refresh sold/affordability states
  }
});

srDescend.addEventListener("click", () => {
  if (net) {
    net.ready(); // modal stays until the whole party is ready (snapshot clears it)
    return;
  }
  setReady(state, me(state).id);
  flushFeedback(state);
  saveRun(state);
  srEl.style.display = "none";
});

// Cooldown UI shows "fraction remaining"; empties as the skill recharges.
const novaCdEl = document.querySelector("#skill-nova .cd > i") as HTMLElement;
const novaSkill = document.getElementById("skill-nova")!;

function updateSkills(s: GameState): void {
  const p = me(s);
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
      mmCtx.fillStyle =
        t === Tile.StairsDown ? "#c9a24b" :
        t === Tile.DoorLocked ? "#ffd23e" : "#2c2c40";
      mmCtx.fillRect(pad + x * sx, pad + y * sy, Math.ceil(sx), Math.ceil(sy));
    }
  }
  const vis2 = CONFIG.fogVisionRadius * CONFIG.fogVisionRadius;
  for (const m of s.monsters) {
    const dx = m.pos.x - me(s).pos.x, dy = m.pos.y - me(s).pos.y;
    if (dx * dx + dy * dy > vis2) continue;
    mmCtx.fillStyle = m.kind === "boss" ? "#ff3b3b" : "#e2574c";
    const r = m.kind === "boss" ? 3.5 : 2;
    mmCtx.beginPath();
    mmCtx.arc(pad + m.pos.x * sx, pad + m.pos.y * sy, r, 0, Math.PI * 2);
    mmCtx.fill();
  }
  for (const pl of s.players) {
    mmCtx.fillStyle = pl.id === me(s).id ? "#4fd1ff" : "#7be89b";
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
  const p = me(s);
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
      `<br>Final show: ${Math.round(p.viewers).toLocaleString()} viewers · ` +
      `${Math.floor(p.favorites).toLocaleString()} favorites · ${p.sponsors} sponsors`;
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

// Network mode: transient feedback arrives as an event stream, buffered here
// until the frame loop consumes it.
const netHits: HitEvent[] = [];
const netAnns: string[] = [];
let netIntentAcc = 0;
let srRefreshAcc = 0;
const partyChip = document.getElementById("party")!;

/** Sample input and aim it at the mouse (screen -> iso ground -> sim coords). */
function sampleIntent(): ReturnType<InputController["sample"]> {
  const center = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  const intent = input.sample(center, false);
  if (mouseAim && input.mouse) {
    const g = renderer.screenToGround(input.mouse.x, input.mouse.y);
    if (g) {
      const p = me(state);
      const dx = g.x - p.pos.x, dy = g.y - p.pos.y;
      if (dx * dx + dy * dy > 0.04) intent.aim = { x: dx, y: dy };
    }
  }
  return intent;
}

async function main(): Promise<void> {
  await renderer.init();

  if (net) {
    try {
      state = await net.connect(serverUrl, joinCode!, playerName);
    } catch (err) {
      hudLog.innerHTML = `<b style="color:#e2574c">${(err as Error).message}</b><br>` +
        `Start it with <b>npm run server</b>, or check ?server=.`;
      return;
    }
    localId = net.playerId;
    renderer.localPlayerId = localId;
    log.push(`Joined party ${joinCode} as ${playerName}.`);
    net.onEvents = (batch) => {
      netHits.push(...batch.hits);
      netAnns.push(...batch.announcements);
      for (const e of batch.events) log.push(e);
    };
    net.onDisconnect = () => {
      log.push("Disconnected from the server.");
      showAnnouncement("CONNECTION LOST. The System apologizes for the technical difficulties.");
    };
    partyChip.style.display = "";
  }

  function frame(now: number): void {
    let dt = (now - prev) / 1000;
    prev = now;
    if (dt > MAX_FRAME) dt = MAX_FRAME;
    acc += dt;

    // Buffer feedback across every sub-step (step() clears these each call).
    const frameHits: typeof state.hits = [];
    const frameAnns: string[] = [];

    if (net) {
      // Authoritative snapshots drive the world; we pump intent + drain events.
      netIntentAcc += dt;
      if (netIntentAcc >= 0.05) {
        netIntentAcc = 0;
        net.sendIntent(sampleIntent());
      }
      const disp = net.display(now);
      if (disp) state = disp;
      frameHits.push(...netHits.splice(0));
      frameAnns.push(...netAnns.splice(0));
      // Party chip: code + roster.
      partyChip.textContent = `⚔ ${joinCode} · ${state.players.map((p) => p.name).join(", ")}`;
      // Safe-room stock/ready counts change server-side; refresh while open.
      srRefreshAcc += dt;
      if (state.safeRoom && srEl.style.display === "flex" && srRefreshAcc > 0.3) {
        srRefreshAcc = 0;
        renderSafeRoom(state);
      }
    }

    const draftPending = me(state).pendingRewards.length > 0 || me(state).pendingUpgrades.length > 0;
    if (draftEl.style.display !== "flex" && draftPending) {
      renderDraft(state);
      draftEl.style.display = "flex";
    }
    if (draftEl.style.display === "flex" && !draftPending) draftEl.style.display = "none";
    const inSafeRoom = state.safeRoom !== null;
    if (srEl.style.display !== "flex" && inSafeRoom && !draftPending) {
      renderSafeRoom(state);
      srEl.style.display = "flex";
    }
    if (srEl.style.display === "flex" && !inSafeRoom) srEl.style.display = "none";

    if (!net) {
      // Local sim. Panels/drafts/safe room pause it (a host UX choice — the
      // networked world never pauses for drafts); drop accumulated time.
      if (invOpen || abilOpen || kbOpen || draftPending || inSafeRoom) acc = 0;
      while (acc >= SIM_DT) {
        step(state, sampleIntent(), SIM_DT);
        for (const e of state.events) log.push(e);
        frameHits.push(...state.hits);
        frameAnns.push(...state.announcements);
        acc -= SIM_DT;
        if (state.floor !== lastFloor) { lastFloor = state.floor; saveRun(state); }
        if (state.status !== lastStatus) { lastStatus = state.status; saveRun(state); }
      }

      saveAcc += dt;
      if (saveAcc > 3 && state.status === "playing") { saveAcc = 0; saveRun(state); }
    }

    // Particles + shake use world space, so they can fire before the camera moves.
    renderer.emitHits(frameHits);
    audioDirector.frame(state, frameHits, frameAnns, localId);
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
