import {
  createGame, restoreGame, step, equipFromInventory, chooseReward, chooseUpgrade,
  buyCatalogItem, sellItem, sellValue, effectivePrice, missingComponents, setReady, addPlayer, slotAbility, setUltimate,
} from "./sim/game";
import { ACHIEVEMENTS } from "./sim/achievements";
import { affixLines, itemScore, weaponClassOf } from "./sim/items";
import {
  CATALOG, CATALOG_BY_ID, TIER_UNLOCK_SHOP, buildsInto, consumablePrice, gearAffixes,
  totalCost, type CatalogEntry, type CatalogTier,
} from "./sim/catalog";
import {
  Tile, type Announcement, type AnnouncementKind, type GameState, type HitEvent, type Item, type Player,
} from "./sim/types";
import { CONFIG } from "./sim/config";
import {
  ABILITY_INFO, ABILITY_SLOTS, DISCOVERABLE_ABILITIES, STARTING_ABILITIES, UPGRADES,
  knows, nodeOpen, rank, upgradeDef, type AbilityId,
} from "./sim/abilities";
import { InputController } from "./input/input";
import {
  ACTION_INFO, DEFAULT_BINDINGS, bindingLabel, loadBindings, loadMouseAim, loadNotify, rebind,
  saveBindings, saveMouseAim, saveNotify, type BindableAction, type Bindings, type NotifyLevel,
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
let notifyLevel = loadNotify();
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
const tickerLayer = document.getElementById("ticker")!;
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

// Boss encounter UI: the ringside intro splash (mirrors the sim's world
// freeze) and a persistent top-center health bar for the engaged menace.
const bossbarEl = document.getElementById("bossbar")!;
const bbIcon = document.getElementById("bb-icon")!;
const bbName = document.getElementById("bb-name")!;
const bbAffix = document.getElementById("bb-affix")!;
const bbFill = document.getElementById("bb-fill") as HTMLElement;
const bossintroEl = document.getElementById("bossintro")!;
const biName = document.getElementById("bi-name")!;
const biAffix = document.getElementById("bi-affix")!;
let introShownFor = -1;

function updateBossBar(s: GameState): void {
  const p = me(s);
  const enc = s.encounter;
  if (enc) {
    if (introShownFor !== enc.monsterId) {
      introShownFor = enc.monsterId;
      biName.textContent = enc.name;
      biAffix.textContent = enc.affix
        ? `${enc.elite ? "ELITE — " : ""}${enc.affix.toUpperCase()}`
        : enc.kind === "boss" ? "BOSS" : "ELITE";
      bossintroEl.classList.remove("show");
      void (bossintroEl as HTMLElement).offsetWidth; // restart the scale-in
      bossintroEl.classList.add("show");
    }
  } else {
    bossintroEl.classList.remove("show");
  }
  // Engaged target: the nearest introduced, living boss/elite within range.
  let target: GameState["monsters"][number] | null = null;
  let best = 16;
  for (const m of s.monsters) {
    if ((m.kind !== "boss" && !m.elite) || !m.introduced || m.hp <= 0) continue;
    const d = Math.hypot(m.pos.x - p.pos.x, m.pos.y - p.pos.y);
    if (d < best) { best = d; target = m; }
  }
  if (!target) {
    bossbarEl.style.display = "none";
    return;
  }
  bossbarEl.style.display = "block";
  bbIcon.textContent = target.kind === "boss" ? "☠" : "◆";
  bbName.textContent = target.eliteName ?? "THE FLOOR BOSS";
  bbAffix.textContent = target.affix ? target.affix.toUpperCase() : "";
  bbFill.style.width = `${Math.max(0, Math.min(1, target.hp / target.maxHp)) * 100}%`;
}

function updateShowHud(s: GameState): void {
  const p = me(s);
  const v = Math.round(p.viewers);
  // Crowd Frenzy: the viewer count burns gold while the buff is live.
  statViewers.style.color = p.frenzy ? "#ffd23e" : "";
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

// Sponsor gifts have no ability icon; a glyph in the plate carries the read.
const REWARD_GLYPHS: Record<string, string> = {
  healFull: "✚", maxHp: "♥", damage: "⚔", crit: "✦", item: "▣", gold: "◈", bonusTime: "⌛",
};

// One modal serves both drafts; sponsor gifts take priority if ever both pend.
function renderDraft(s: GameState): void {
  const lp = me(s);
  if (lp.pendingRewards.length > 0) {
    draftEl.classList.remove("levelup");
    draftTitle.textContent = "◆ SPONSOR DRAFT";
    draftHint.textContent = "Your sponsors reward a good show. Take one gift down — press its number or click.";
    draftCards.innerHTML = lp.pendingRewards
      .map((r, i) => {
        const tint = r.item ? ` style="--oc:${RARITY_TEXT[r.item.rarity]}"` : "";
        const ribbon = r.item ? `<span class="oribbon">${r.item.rarity}</span>` : "";
        return (
          `<div class="reward" data-idx="${i}"${tint}>` +
          `<div class="oicon"><span class="oglyph">${REWARD_GLYPHS[r.kind] ?? "◆"}</span></div>` +
          `<div class="obody">` +
          `<div class="rtitle"><span>${r.title}</span>${ribbon}</div>` +
          `<div class="rdesc">${r.desc}</div>` +
          `</div>` +
          `<kbd class="okey">${i + 1}</kbd>` +
          `</div>`
        );
      })
      .join("");
  } else {
    draftEl.classList.add("levelup");
    draftTitle.textContent = "◆ LEVEL UP";
    draftHint.textContent = "The System offers an evolution. Take one — press its number or click.";
    draftCards.innerHTML = lp.pendingUpgrades
      .map((u, i) => {
        const info = ABILITY_INFO[u.ability];
        const max = UPGRADES.find((n) => n.id === u.id)?.maxRank ?? u.nextRank;
        // Overrank offers extend the pip row past the printed max with stars.
        const pips = Array.from({ length: Math.max(max, u.nextRank) }, (_, r) =>
          r < u.nextRank ? (r >= max ? "⭑" : "●") : "○").join("");
        const icon = `<i style="mask-image:url(/icons/${u.ability}.svg);-webkit-mask-image:url(/icons/${u.ability}.svg)"></i>`;
        return (
          `<div class="reward${info.tier === "ultimate" ? " ult" : ""}${u.overrank ? " over" : ""}" data-idx="${i}">` +
          `<div class="oicon">${icon}<span class="orank">${pips}</span></div>` +
          `<div class="obody">` +
          `<div class="rtitle"><span>${u.title}</span><span class="oribbon">${u.overrank ? "OVERRANK · " : ""}${info.name}</span></div>` +
          `<div class="rdesc">${u.desc}</div>` +
          `</div>` +
          `<kbd class="okey">${i + 1}</kbd>` +
          `</div>`
        );
      })
      .join("");
  }
}

function chooseDraft(idx: number): void {
  const p = me(state);
  const count = p.pendingRewards.length > 0 ? p.pendingRewards.length : p.pendingUpgrades.length;
  if (idx < 0 || idx >= count) return;
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
}

draftCards.addEventListener("click", (e) => {
  const card = (e.target as HTMLElement).closest(".reward") as HTMLElement | null;
  if (!card || card.dataset.idx === undefined) return;
  chooseDraft(Number(card.dataset.idx));
});

// Number keys pick an offer while the draft is up. Capture phase + stop so the
// same digit doesn't also cast the skill bound to it underneath the overlay.
window.addEventListener(
  "keydown",
  (e) => {
    if (draftEl.style.display !== "flex") return;
    const d = Number(e.key);
    if (!Number.isInteger(d) || d < 1 || d > 9) return;
    e.stopPropagation();
    chooseDraft(d - 1);
  },
  true,
);

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

function whereIs(p: ReturnType<typeof me>, id: AbilityId): string {
  const idx = p.abilities.slots.indexOf(id);
  if (idx >= 0) return `SLOT ${idx + 1}`;
  if (p.abilities.ultimate === id) return "ULTIMATE";
  return "BENCH";
}

/**
 * One upgrade node as a readable row: rank pips, the CURRENT magnitude when
 * taken (next rank previewed in parens), and plain-language lock reasons —
 * clarity over constellation art.
 */
function nodeRowHtml(p: ReturnType<typeof me>, u: (typeof UPGRADES)[number]): string {
  const r = rank(p, u.id);
  const open = nodeOpen(p, u);
  const locked = !open && r === 0;
  const pips = u.capstone
    ? `<span class="cap">${r > 0 ? "◆" : "◇"}</span>`
    : `${"●".repeat(Math.min(r, u.maxRank))}` +
      `<span class="opip">${"⭑".repeat(Math.max(0, r - u.maxRank))}</span>` +
      `<span class="off">${"○".repeat(Math.max(0, u.maxRank - r))}</span>`;
  let effect: string;
  if (locked) {
    const forked = (u.excludes ?? []).filter((id) => rank(p, id) > 0).map((id) => upgradeDef(id)!.title);
    const unmet = (u.requires ?? []).filter((id) => rank(p, id) === 0).map((id) => upgradeDef(id)!.title);
    effect = forked.length > 0
      ? `fork closed — you took ${forked.join(", ")}`
      : `needs ${unmet.join(", ")}`;
  } else if (r > 0) {
    effect = u.desc(r) +
      (r < u.maxRank ? ` <span class="nnext">· next rank: ${u.desc(r + 1)}</span>` : "") +
      (r === u.maxRank && !u.capstone ? ` <span class="nnext">· MAX</span>` : "") +
      (r > u.maxRank ? ` <span class="nover">· OVERRANK +${r - u.maxRank}</span>` : "");
  } else {
    effect = `${u.desc(1)} <span class="nnext">· from level-up drafts</span>`;
  }
  const cls = ["nrow", r > 0 ? "taken" : locked ? "locked" : "untaken", u.capstone ? "capstone" : ""]
    .filter(Boolean).join(" ");
  return (
    `<div class="${cls}">` +
    `<span class="ntitle">${u.title}</span>` +
    `<span class="npips">${pips}</span>` +
    `<span class="neffect">${effect}</span>` +
    `</div>`
  );
}

function abilityCard(s: GameState, id: AbilityId): string {
  const p = me(s);
  const info = ABILITY_INFO[id];
  if (!knows(p, id)) {
    return (
      `<div class="acard unknown">` +
      `<div class="ahead"><div><div class="ahname">???</div>` +
      `<div class="ahblurb">undiscovered ${info.tier} — find a tome (or buy one in the shop)</div></div></div>` +
      `</div>`
    );
  }
  const where = whereIs(p, id);
  const whereCls = where === "BENCH" ? "bench" : where === "ULTIMATE" ? "ultc" : "";
  const rows = UPGRADES.filter((u) => u.ability === id).map((u) => nodeRowHtml(p, u)).join("");
  // Slot controls are a SAFE-ROOM decision (the sim enforces it; we just hide
  // the buttons elsewhere). Actives get slot 1-4 + bench; ultimates get U.
  let controls = "";
  if (s.safeRoom) {
    if (info.tier === "active") {
      const btns = Array.from({ length: ABILITY_SLOTS }, (_v, i) =>
        `<button class="slot-btn" data-ability="${id}" data-slot="${i}">SLOT ${i + 1}</button>`).join("");
      const benchBtn = where !== "BENCH"
        ? `<button class="slot-btn" data-ability="${id}" data-slot="bench">BENCH</button>` : "";
      controls = `<div class="slot-controls">${btns}${benchBtn}</div>`;
    } else {
      const ultBtn = p.abilities.ultimate === id
        ? `<button class="slot-btn" data-ability="${id}" data-slot="unult">BENCH</button>`
        : `<button class="slot-btn" data-ability="${id}" data-slot="ult">SLOT AS ULT</button>`;
      controls = `<div class="slot-controls">${ultBtn}</div>`;
    }
  }
  return (
    `<div class="acard${info.tier === "ultimate" ? " ult" : ""}">` +
    `<div class="ahead">` +
    `<i class="ii" style="mask-image:url(/icons/${id}.svg);-webkit-mask-image:url(/icons/${id}.svg)"></i>` +
    `<div><div class="ahname">${info.name}</div><div class="ahblurb">${info.blurb} · ${info.tier}</div></div>` +
    `<span class="awhere ${whereCls}">${where}</span>` +
    `</div>` +
    (rows ? `<div class="nrows">${rows}</div>` : "") +
    controls +
    `</div>`
  );
}

// Slotting clicks (sim validates; net mode forwards to the server). Shared by
// the T panel and the safe room's ABILITIES tab.
function handleSlotClick(e: Event, rerender: (s: GameState) => void): void {
  const btn = (e.target as HTMLElement).closest(".slot-btn") as HTMLElement | null;
  if (!btn) return;
  const ability = btn.dataset.ability as AbilityId;
  const slot = btn.dataset.slot!;
  const p = me(state);
  if (net) {
    net.slot(slot, ability);
  } else {
    if (slot === "ult") setUltimate(state, p.id, ability);
    else if (slot === "unult") setUltimate(state, p.id, null);
    else if (slot === "bench") {
      const idx = p.abilities.slots.indexOf(ability);
      if (idx >= 0) slotAbility(state, p.id, idx, null);
    } else slotAbility(state, p.id, Number(slot), ability);
    flushFeedback(state);
    saveRun(state);
  }
  rerender(state);
}

document.getElementById("abil-grid")!.addEventListener("click", (e) => handleSlotClick(e, renderAbilities));

const achGrid = document.getElementById("ach-grid")!;
const achCount = document.getElementById("ach-count")!;
const statsRows = document.getElementById("stats-rows")!;

function renderAbilities(s: GameState): void {
  const all = [...STARTING_ABILITIES, ...DISCOVERABLE_ABILITIES];
  abilGrid.innerHTML = all.map((id) => abilityCard(s, id)).join("");
  document.getElementById("ach-section")!.style.display =
    CONFIG.achievementsEnabled ? "" : "none";
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
  // Banner + panel hints render from the live bindings (the skill bar renders
  // per-frame from the loadout in updateSkills).
  const wasd = [first("moveUp"), first("moveLeft"), first("moveDown"), first("moveRight")].join("");
  document.getElementById("banner-keys")!.innerHTML =
    `<kbd>${wasd === "WASD" ? "WASD" : wasd}</kbd> move · ` +
    `<kbd>${first("slot1")}</kbd>/LMB·<kbd>${first("slot2")}</kbd>·<kbd>${first("slot3")}</kbd>/RMB·<kbd>${first("slot4")}</kbd> abilities · ` +
    `<kbd>${first("ultimate")}</kbd> ultimate · ` +
    `<kbd>${first("inventory")}</kbd> inv · ` +
    `<kbd>${first("abilities")}</kbd> loadout · ` +
    `<kbd>${first("keybinds")}</kbd> keys · ` +
    `<kbd>${first("stairs")}</kbd> stairs · ` +
    `<kbd>${first("newRun")}</kbd> new run · ` +
    `<kbd>${first("mute")}</kbd> mute` + (mouseAim ? " · aim with mouse" : "");
  document.getElementById("kb-close-key")!.textContent = first("keybinds");
}

function renderKeybinds(): void {
  kbRows.innerHTML = (Object.keys(ACTION_INFO) as BindableAction[])
    .filter((a) => a !== "flask" || CONFIG.flaskEnabled) // no dead key rows
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

// System-chatter verbosity: cycles the ticker filter (see TICKER_KINDS).
const NOTIFY_CYCLE: NotifyLevel[] = ["normal", "critical", "all"];
const kbNotify = document.getElementById("kb-notify")!;
function renderNotify(): void {
  kbNotify.textContent = notifyLevel.toUpperCase();
}
kbNotify.addEventListener("click", () => {
  notifyLevel = NOTIFY_CYCLE[(NOTIFY_CYCLE.indexOf(notifyLevel) + 1) % NOTIFY_CYCLE.length];
  saveNotify(notifyLevel);
  renderNotify();
});
renderNotify();

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

// ---- The System Shop (safe room between floors; pauses the sim until DESCEND) ----
// One hybrid shop/crafting UI (LoL-style): a tier-sectioned shelf of icon
// tiles, a detail pane with the build tree (BUILDS FROM / BUILDS INTO), and
// the bag for selling. IN STOCK shows today's seeded shelf; ALL ITEMS is the
// full-catalog build planner (locked tiles show what future shops can carry).
const srEl = document.getElementById("saferoom")!;
const srTip = document.getElementById("sr-tip")!;
const srWallet = document.getElementById("sr-wallet")!;
const srShelf = document.getElementById("sr-shelf")!;
const srDetail = document.getElementById("sr-detail")!;
const srEquipped = document.getElementById("sr-equipped")!;
const srBag = document.getElementById("sr-bag")!;
const srReady = document.getElementById("sr-ready")!;
const srDescend = document.getElementById("sr-descend")!;
const srTabStock = document.getElementById("sr-tab-stock")!;
const srTabAll = document.getElementById("sr-tab-all")!;
// Top-level safe-room tabs: SYSTEM SHOP / ABILITIES / ACHIEVEMENTS.
const srTabShop = document.getElementById("sr-tab-shop")!;
const srTabAbil = document.getElementById("sr-tab-abil")!;
const srTabAch = document.getElementById("sr-tab-ach")!;
const srPageShop = document.getElementById("sr-page-shop")!;
const srPageAbil = document.getElementById("sr-page-abil")!;
const srPageAch = document.getElementById("sr-page-ach")!;
const srLoadout = document.getElementById("sr-loadout")!;
const srAbil = document.getElementById("sr-abil")!;
const srAch = document.getElementById("sr-ach")!;
const srAchCount = document.getElementById("sr-ach-count")!;
let srTab: "shop" | "abil" | "ach" = "shop";

const TIERS: CatalogTier[] = ["consumable", "starter", "basic", "advanced", "legendary"];
const TIER_COLOR: Record<CatalogTier, string> = {
  consumable: "#8fb8a0", starter: "#c9c9d4", basic: "#7fb0ff", advanced: "#f2c14e", legendary: "#c9a6ff",
};
const TIER_LABEL: Record<CatalogTier, string> = {
  consumable: "CONSUMABLES", starter: "STARTER", basic: "BASIC", advanced: "ADVANCED", legendary: "LEGENDARY",
};

let shopView: "stock" | "all" = "stock";
type ShopSel =
  | { kind: "catalog"; id: string }
  | { kind: "bag"; idx: number }
  | { kind: "equipped"; slot: "weapon" | "armor" | "trinket" };
let shopSel: ShopSel | null = null;

// Icons by convention: /icons/items/<catalogId>.svg (game-icons.net, CSS-mask tinted).
const iconStyle = (id: string): string =>
  `mask-image:url(/icons/items/${id}.svg);-webkit-mask-image:url(/icons/items/${id}.svg)`;
const coin = `<i class="micon" style="${iconStyle("gold")}"></i>`;
const matIcon = (id: string): string => `<i class="micon" style="${iconStyle(id)}"></i>`;

/** How many of each catalog id the player owns (bag + equipped) — component dots. */
function ownedCatalogCounts(p: Player): Record<string, number> {
  const counts: Record<string, number> = {};
  const add = (it: Item | null) => {
    if (it?.catalogId) counts[it.catalogId] = (counts[it.catalogId] ?? 0) + 1;
  };
  p.inventory.forEach((it) => add(it));
  add(p.equipment.weapon);
  add(p.equipment.armor);
  add(p.equipment.trinket);
  return counts;
}

/** Why this entry can't be bought right now, or null if it can. */
function buyBlocker(s: GameState, e: CatalogEntry): string | null {
  const room = s.safeRoom!;
  const p = me(s);
  if (!room.available.includes(e.id)) {
    const unlock = TIER_UNLOCK_SHOP[e.tier];
    return room.nextFloor - 1 < unlock ? `ARRIVES AT SHOP ${unlock}` : "NOT STOCKED TODAY";
  }
  if (e.effect === "tome" && (!room.tomeAbility || knows(p, room.tomeAbility))) return "ALREADY MASTERED";
  // Built gear needs its components IN HAND (the BUILDS FROM row shows which).
  if (e.buildsFrom?.length && missingComponents(p, e.id).length > 0) return "NEEDS COMPONENTS";
  if ((e.sponsors ?? 0) > p.sponsors) return `NEEDS ${e.sponsors} SPONSOR${(e.sponsors ?? 0) > 1 ? "S" : ""}`;
  for (const [m, n] of Object.entries(e.materials ?? {})) {
    if (p.materials[m as keyof Player["materials"]] < (n ?? 0)) return "NEEDS MATERIALS";
  }
  if (effectivePrice(p, e.id, room.nextFloor) > p.gold) return "NOT ENOUGH GOLD";
  return null;
}

function shelfTileHtml(s: GameState, e: CatalogEntry, owned: Record<string, number>): string {
  const room = s.safeRoom!;
  const p = me(s);
  const locked = !room.available.includes(e.id);
  const price = effectivePrice(p, e.id, room.nextFloor);
  const cls = [
    "itile",
    shopSel?.kind === "catalog" && shopSel.id === e.id ? "sel" : "",
    locked ? "locked" : "",
    !locked && price > p.gold ? "broke" : "",
    (owned[e.id] ?? 0) > 0 ? "owned" : "",
  ].filter(Boolean).join(" ");
  return (
    `<div class="${cls}" data-id="${e.id}" style="--tc:${TIER_COLOR[e.tier]}" title="${e.name}">` +
    `<div class="ibox"><i class="ii" style="${iconStyle(e.id)}"></i></div>` +
    `<div class="iprice">${coin}${price}</div>` +
    `</div>`
  );
}

/** Small icon tile for build-tree rows and the bag (no price line). */
function miniTileHtml(e: CatalogEntry, extraCls = "", data = ""): string {
  return (
    `<div class="itile ${extraCls}" ${data} style="--tc:${TIER_COLOR[e.tier]}" title="${e.name}">` +
    `<div class="ibox"><i class="ii" style="${iconStyle(e.id)}"></i></div>` +
    `</div>`
  );
}

/** Bag/equipped tile: catalog gear shows its catalog icon; field drops show
 * their NOUN's icon (every generated-item noun has one at /icons/nouns/),
 * tinted by rarity via the tile's --tc mask color. */
function invTileHtml(it: Item, data: string, selected: boolean): string {
  const noun = it.name.split(" ").pop()!.toLowerCase();
  const inner = it.catalogId
    ? `<i class="ii" style="${iconStyle(it.catalogId)}"></i>`
    : `<i class="ii" style="mask-image:url(/icons/nouns/${noun}.svg);-webkit-mask-image:url(/icons/nouns/${noun}.svg)"></i>`;
  const tc = it.catalogId ? TIER_COLOR[CATALOG_BY_ID[it.catalogId].tier] : RARITY_TEXT[it.rarity];
  return (
    `<div class="itile${selected ? " sel" : ""}" ${data} style="--tc:${tc}" title="${it.name}">` +
    `<div class="ibox">${inner}</div>` +
    `</div>`
  );
}

function statLines(it: Pick<Item, "affixes">): string {
  return affixLines(it as Item).join(" · ");
}

function renderShopDetail(s: GameState): void {
  const room = s.safeRoom!;
  const p = me(s);
  if (!shopSel) {
    srDetail.innerHTML = `<div class="dempty">Select an item. Components you own are credited toward anything they build into.</div>`;
    return;
  }
  if (shopSel.kind === "catalog") {
    const e = CATALOG_BY_ID[shopSel.id];
    if (!e) { srDetail.innerHTML = ""; return; }
    let html =
      `<div class="dname" style="--tc:${TIER_COLOR[e.tier]}">${e.name}</div>` +
      `<div class="dkind">${TIER_LABEL[e.tier]}${e.slot ? ` · ${e.slot.toUpperCase()}` : ""}</div>`;
    if (e.tier === "consumable") {
      if (e.effect === "tome") {
        const ab = room.tomeAbility;
        html += ab
          ? `<div class="dstats">Today's print: <b>${ABILITY_INFO[ab].name}</b> — ${ABILITY_INFO[ab].blurb}</div>`
          : `<div class="dstats">Out of print — the party knows everything.</div>`;
      } else if (e.effect === "maxHp") {
        html += `<div class="dstats">+${12 + room.nextFloor * 2} max HP, permanent.</div>`;
      }
      html += `<div class="ddesc">${e.desc}</div>`;
    } else {
      html += `<div class="dstats">${statLines({ affixes: gearAffixes(e, room.nextFloor) })}</div>`;
      if (e.passive) html += `<div class="dpassive">${e.desc}</div>`;
      else html += `<div class="ddesc">${e.desc}</div>`;
    }
    // Build tree: what it's made of (with owned ✓s), and what it feeds.
    if (e.buildsFrom?.length) {
      const have = { ...ownedCatalogCounts(p) };
      const tiles = e.buildsFrom.map((cid) => {
        const c = CATALOG_BY_ID[cid];
        const got = (have[cid] ?? 0) > 0;
        if (got) have[cid]!--;
        return miniTileHtml(c, got ? "have" : "", `data-id="${cid}"`);
      }).join("");
      html += `<div class="dsec">BUILDS FROM</div><div class="dtree">${tiles}</div>`;
    }
    const into = e.slot ? buildsInto(e.id) : [];
    if (into.length) {
      html += `<div class="dsec">BUILDS INTO</div><div class="dtree">${
        into.map((t) => miniTileHtml(t, "", `data-id="${t.id}"`)).join("")}</div>`;
    }
    // Requirements (sponsor backing + the material hunt).
    if (e.sponsors || e.materials) {
      html += `<div class="dsec">REQUIRES</div>`;
      if (e.sponsors) {
        html += `<div class="dreq ${p.sponsors >= e.sponsors ? "met" : "unmet"}">${e.sponsors} sponsor${e.sponsors > 1 ? "s" : ""} (you: ${p.sponsors})</div>`;
      }
      for (const [m, n] of Object.entries(e.materials ?? {})) {
        const has = p.materials[m as keyof Player["materials"]];
        html += `<div class="dreq ${has >= (n ?? 0) ? "met" : "unmet"}">${matIcon(m)} ${n}× ${m.replace("_", " ")} (you: ${has})</div>`;
      }
    }
    // Price: full price struck through when owned components discount it.
    const full = e.tier === "consumable" ? consumablePrice(e, room.nextFloor) : totalCost(e.id);
    const eff = effectivePrice(p, e.id, room.nextFloor);
    html += `<div class="dprice">${eff < full ? `<span class="full">${full}</span>` : ""}<span class="eff">${coin}${eff}</span></div>`;
    const blocker = buyBlocker(s, e);
    html += `<div class="dbtns"><button data-buy="${e.id}" ${blocker ? "disabled" : ""}>${blocker ?? "BUY"}</button></div>`;
    srDetail.innerHTML = html;
    return;
  }
  // Bag / equipped item detail.
  const it = shopSel.kind === "bag" ? p.inventory[shopSel.idx] : p.equipment[shopSel.slot];
  if (!it) { shopSel = null; renderShopDetail(s); return; }
  const tc = it.catalogId ? TIER_COLOR[CATALOG_BY_ID[it.catalogId].tier] : RARITY_TEXT[it.rarity];
  let html =
    `<div class="dname" style="--tc:${tc}">${it.name}</div>` +
    `<div class="dkind">${it.rarity.toUpperCase()} · ${it.slot.toUpperCase()}` +
    `${weaponClassOf(it) ? ` · ${weaponClassOf(it)!.toUpperCase()}` : ""}` +
    `${shopSel.kind === "equipped" ? " · EQUIPPED" : " · BAG"}</div>` +
    `<div class="dstats">${statLines(it)}</div>`;
  if (it.passive) html += `<div class="dpassive">${CATALOG_BY_ID[it.catalogId ?? ""]?.desc ?? ""}</div>`;
  if (!it.catalogId) html += `<div class="ddesc">Field drop — sells flat, never counts as a build component.</div>`;
  if (it.catalogId) {
    const into = buildsInto(it.catalogId);
    if (into.length) {
      html += `<div class="dsec">BUILDS INTO</div><div class="dtree">${
        into.map((t) => miniTileHtml(t, "", `data-id="${t.id}"`)).join("")}</div>`;
    }
  }
  if (shopSel.kind === "bag") {
    html += `<div class="dbtns">` +
      `<button data-equip="${shopSel.idx}">EQUIP</button>` +
      `<button class="sell" data-sell="${shopSel.idx}">SELL +${sellValue(it)}g</button>` +
      `</div>`;
  }
  srDetail.innerHTML = html;
}

function renderSafeRoom(s: GameState): void {
  const room = s.safeRoom;
  if (!room) return;
  const p = me(s);
  srTip.textContent = room.tip;
  srWallet.innerHTML =
    `<span class="chip">${coin}<b>${p.gold}</b></span>` +
    `<span class="chip">${matIcon("elite_trophy")}<b>${p.materials.elite_trophy}</b></span>` +
    `<span class="chip">${matIcon("boss_sigil")}<b>${p.materials.boss_sigil}</b></span>` +
    `<span class="chip" title="sponsors">🤝 <b>${p.sponsors}</b></span>`;
  srReady.textContent = s.players.length > 1 ? `ready ${room.ready.length}/${s.players.length}` : "";
  // Top-level tab dispatch.
  srTabAch.style.display = CONFIG.achievementsEnabled ? "" : "none";
  if (srTab === "ach" && !CONFIG.achievementsEnabled) srTab = "shop";
  srTabShop.classList.toggle("active", srTab === "shop");
  srTabAbil.classList.toggle("active", srTab === "abil");
  srTabAch.classList.toggle("active", srTab === "ach");
  srPageShop.style.display = srTab === "shop" ? "grid" : "none";
  srPageAbil.style.display = srTab === "abil" ? "" : "none";
  srPageAch.style.display = srTab === "ach" ? "" : "none";
  if (srTab === "shop") renderShopPage(s);
  else if (srTab === "abil") renderAbilPage(s);
  else renderAchPage(s);
}

/** The ABILITIES tab: loadout bar (The Five) + per-ability upgrade cards. */
function renderAbilPage(s: GameState): void {
  const p = me(s);
  const slotTile = (id: AbilityId | null, key: string, ult = false): string => {
    const cls = `lslot${ult ? " ult" : ""}${id ? "" : " empty"}`;
    const icon = id
      ? `<i class="ii" style="mask-image:url(/icons/${id}.svg);-webkit-mask-image:url(/icons/${id}.svg)"></i>`
      : "";
    const name = id ? ABILITY_INFO[id].name : "empty";
    return `<div class="${cls}"><div class="ibox"><span class="lkey">${key}</span>${icon}</div><div class="lname">${name}</div></div>`;
  };
  srLoadout.innerHTML =
    p.abilities.slots.map((id, i) => slotTile(id, String(i + 1))).join("") +
    slotTile(p.abilities.ultimate, "U", true);
  const all = [...STARTING_ABILITIES, ...DISCOVERABLE_ABILITIES];
  srAbil.innerHTML = all.map((id) => abilityCard(s, id)).join("");
}

/** The ACHIEVEMENTS tab: what the System has recognized (and what it hasn't). */
function renderAchPage(s: GameState): void {
  const p = me(s);
  srAchCount.textContent =
    `THE SYSTEM RECOGNIZES — ${p.achievements.length} / ${ACHIEVEMENTS.length} UNLOCKED`;
  srAch.innerHTML = ACHIEVEMENTS.map((a) => {
    const got = p.achievements.includes(a.id);
    return (
      `<div class="sr-ach${got ? "" : " locked"}">` +
      `<div class="atitle">${got ? "★" : "☆"} ${a.title}</div>` +
      `<div class="adesc">${a.desc}</div>` +
      `<div class="areward">${got ? "PAID" : "PAYS"} +${a.gold} gold · +${a.hype} hype</div>` +
      `</div>`
    );
  }).join("");
}

/** The SYSTEM SHOP tab: shelf + detail + bag. */
// Bag density thresholds: item counts at which the bag grid steps down a tile
// size (see .bag-grid.dense/.micro in iso.html), sized so each tier fills its
// rows before the bag would crowd the detail pane out of the side column.
const BAG_DENSE_AT = 19; // 40px tiles hold 3 comfortable rows
const BAG_MICRO_AT = 46; // 32px tiles hold ~6 rows
const BAG_SHOW_MAX = 79; // beyond ~8 micro rows, the tail becomes "+K more"

function renderShopPage(s: GameState): void {
  const room = s.safeRoom;
  if (!room) return;
  const p = me(s);
  srTabStock.classList.toggle("active", shopView === "stock");
  srTabAll.classList.toggle("active", shopView === "all");
  // The shelf, tier by tier.
  const avail = new Set(room.available);
  const owned = ownedCatalogCounts(p);
  const shopIndex = room.nextFloor - 1;
  let shelf = "";
  for (const tier of TIERS) {
    const pool = CATALOG.filter((e) => e.tier === tier && (e.id !== "tome" || room.tomeAbility));
    const entries = shopView === "stock" ? pool.filter((e) => avail.has(e.id)) : pool;
    if (entries.length === 0) continue;
    const unlock = TIER_UNLOCK_SHOP[tier];
    const note = shopIndex < unlock
      ? `<span class="tnote">— unlocks at shop ${unlock}</span>`
      : shopView === "all" && entries.some((e) => !avail.has(e.id))
        ? `<span class="tnote">— stock varies by shop</span>`
        : "";
    shelf +=
      `<div class="tier-h" style="--tc:${TIER_COLOR[tier]}">${TIER_LABEL[tier]}${note}</div>` +
      `<div class="igrid">${entries.map((e) => shelfTileHtml(s, e, owned)).join("")}</div>`;
  }
  srShelf.innerHTML = shelf;
  // Equipped + bag.
  srEquipped.innerHTML = (["weapon", "armor", "trinket"] as const).map((slot) => {
    const it = p.equipment[slot];
    if (!it) return `<div class="itile" style="--tc:#2c3a31"><div class="ibox"><span class="iglyph" style="color:#2c3a31">·</span></div></div>`;
    return invTileHtml(it, `data-slot="${slot}"`, shopSel?.kind === "equipped" && shopSel.slot === slot);
  }).join("");
  // The bag TIGHTENS as it fills so the panel always fits the viewport
  // (house rule: no scrollbars): 40px tiles, then 32px, then 26px; past what
  // even micro tiles can hold, the tail collapses into a "+K more" summary.
  const bagN = p.inventory.length;
  srBag.classList.toggle("dense", bagN >= BAG_DENSE_AT && bagN < BAG_MICRO_AT);
  srBag.classList.toggle("micro", bagN >= BAG_MICRO_AT);
  const hidden = Math.max(0, bagN - BAG_SHOW_MAX);
  srBag.innerHTML = bagN
    ? p.inventory.slice(0, BAG_SHOW_MAX)
        .map((it, i) => invTileHtml(it, `data-bag="${i}"`, shopSel?.kind === "bag" && shopSel.idx === i)).join("") +
      (hidden > 0
        ? `<div class="itile more" title="${hidden} more item${hidden === 1 ? "" : "s"} — sell or equip to thin the bag"><div class="ibox">+${hidden}</div></div>`
        : "")
    : `<span class="bempty">empty — buy components, they wait here</span>`;
  renderShopDetail(s);
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

// Shelf: click a tile to inspect it (locked tiles too — that's the planner).
srShelf.addEventListener("click", (e) => {
  const tile = (e.target as HTMLElement).closest(".itile[data-id]") as HTMLElement | null;
  if (!tile) return;
  shopSel = { kind: "catalog", id: tile.dataset.id! };
  renderSafeRoom(state);
});

// Detail pane: BUY / SELL / EQUIP buttons + build-tree navigation.
srDetail.addEventListener("click", (e) => {
  const el = e.target as HTMLElement;
  const buyBtn = el.closest("button[data-buy]") as HTMLButtonElement | null;
  if (buyBtn && !buyBtn.disabled) {
    const id = buyBtn.dataset.buy!;
    audio.play("buy");
    if (net) net.buy(id);
    else {
      buyCatalogItem(state, me(state).id, id);
      flushFeedback(state);
      saveRun(state);
    }
    renderSafeRoom(state);
    return;
  }
  const sellBtn = el.closest("button[data-sell]") as HTMLButtonElement | null;
  if (sellBtn) {
    const idx = Number(sellBtn.dataset.sell);
    if (net) net.sell(idx);
    else {
      sellItem(state, me(state).id, idx);
      flushFeedback(state);
      saveRun(state);
    }
    shopSel = null;
    renderSafeRoom(state);
    return;
  }
  const equipBtn = el.closest("button[data-equip]") as HTMLButtonElement | null;
  if (equipBtn) {
    const idx = Number(equipBtn.dataset.equip);
    audio.play("equip");
    if (net) net.equip(idx);
    else {
      equipFromInventory(state, me(state).id, idx);
      flushFeedback(state);
      saveRun(state);
    }
    shopSel = null;
    renderSafeRoom(state);
    return;
  }
  const nav = el.closest(".itile[data-id]") as HTMLElement | null;
  if (nav) {
    shopSel = { kind: "catalog", id: nav.dataset.id! };
    renderSafeRoom(state);
  }
});

srEquipped.addEventListener("click", (e) => {
  const tile = (e.target as HTMLElement).closest(".itile[data-slot]") as HTMLElement | null;
  if (!tile) return;
  shopSel = { kind: "equipped", slot: tile.dataset.slot as "weapon" | "armor" | "trinket" };
  renderSafeRoom(state);
});

srBag.addEventListener("click", (e) => {
  const tile = (e.target as HTMLElement).closest(".itile[data-bag]") as HTMLElement | null;
  if (!tile) return;
  shopSel = { kind: "bag", idx: Number(tile.dataset.bag) };
  renderSafeRoom(state);
});

srTabStock.addEventListener("click", () => { shopView = "stock"; renderSafeRoom(state); });
srTabAll.addEventListener("click", () => { shopView = "all"; renderSafeRoom(state); });
srTabShop.addEventListener("click", () => { srTab = "shop"; renderSafeRoom(state); });
srTabAbil.addEventListener("click", () => { srTab = "abil"; renderSafeRoom(state); });
srTabAch.addEventListener("click", () => { srTab = "ach"; renderSafeRoom(state); });
srAbil.addEventListener("click", (e) => handleSlotClick(e, renderSafeRoom));

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

// The Five: skill bar rendered from the loadout (4 slots + ultimate + bench
// count). Structure rebuilds only when the loadout changes; cooldown fills
// update every frame.
const skillsEl = document.getElementById("skills")!;
const xpFill = document.querySelector("#xpbar > i") as HTMLElement;
let skillBarKey = "";
const CD_BASE: Partial<Record<AbilityId, number>> = {
  melee: CONFIG.playerAttackCooldown, dash: CONFIG.dashCooldown, bolt: CONFIG.boltCooldown,
  nova: CONFIG.novaCooldown, stance: CONFIG.stanceSwapCooldown,
  overcharge: CONFIG.overchargeCooldown,
  airstrike: CONFIG.ultAirstrikeCooldown,
  cataclysm: CONFIG.ultCataclysmCooldown, bullettime: CONFIG.ultBulletTimeCooldown,
};

function updateSkills(s: GameState): void {
  const p = me(s);
  const slotActions = ["slot1", "slot2", "slot3", "slot4", "ultimate"] as const;
  const entries: { ability: AbilityId | null; ult: boolean }[] = [
    ...p.abilities.slots.map((a) => ({ ability: a, ult: false })),
    { ability: p.abilities.ultimate, ult: true },
  ];
  const key = entries.map((e) => e.ability ?? "-").join("|") +
    `|${p.abilities.bench.length}|d${p.dashCharges}|f${p.flaskCharges}.${p.flaskKillProgress}|s${p.stance}|o${p.overcharged ? 1 : 0}`;
  if (key !== skillBarKey) {
    skillBarKey = key;
    skillsEl.innerHTML = entries
      .map((e, i) => {
        const bind = bindingLabel(bindings, slotActions[i]).split(" / ")[0];
        const label = e.ability
          ? (e.ability === "dash"
            ? `Dash ×${p.dashCharges}` // charge count in the chip
            : e.ability === "stance"
              ? (p.stance === "melee" ? "Brawler" : "Deadeye") // the chip IS the stance indicator
              : e.ability === "overcharge" && p.overcharged
                ? "CHARGED" // banked and waiting for the next attack
                : ABILITY_INFO[e.ability].name.split(" ").pop())
          : "";
        const cls = `skill${e.ult ? " ult" : ""}${e.ability ? "" : " empty"}`;
        // Icon by convention: /icons/<abilityId>.svg (game-icons.net, tinted via CSS mask).
        const icon = e.ability
          ? `<i class="icon" style="mask-image:url(/icons/${e.ability}.svg);-webkit-mask-image:url(/icons/${e.ability}.svg)"></i>`
          : `<i class="icon"></i>`;
        return `<div class="${cls}" data-i="${i}"><span class="key">${bind}</span>${icon}` +
          `<span class="label">${label}</span><span class="sweep"></span></div>`;
      })
      .join("") +
      // Flask chip (cockpit-style): charge count in the label; the radial
      // sweep shows progress toward the next charge (kills refill it).
      (CONFIG.flaskEnabled
        ? `<div class="skill${p.flaskCharges > 0 ? " ready" : " empty"}" id="flask-chip" ` +
          `style="--cd:${p.flaskCharges >= CONFIG.flaskMaxCharges ? 0 : (1 - p.flaskKillProgress / CONFIG.flaskKillsPerCharge).toFixed(3)}">` +
          `<span class="key">${bindingLabel(bindings, "flask").split(" / ")[0]}</span>` +
          `<i class="icon"></i>` +
          `<span class="label">Slurp ×${p.flaskCharges}</span><span class="sweep"></span>` +
          `</div>`
        : "") +
      (p.abilities.bench.length > 0
        ? `<div class="skill empty"><span class="bench-badge">bench ${p.abilities.bench.length}</span></div>`
        : "");
  }
  const chips = skillsEl.querySelectorAll(".skill[data-i]");
  entries.forEach((e, i) => {
    const chip = chips[i] as HTMLElement | undefined;
    if (!chip) return;
    if (!e.ability) return;
    const remaining = p.cd[e.ability] ?? 0;
    const base = CD_BASE[e.ability] ?? 1;
    // Dash runs on charges: cd.dash is only the NEXT charge's refill timer, so
    // the chip reads ready whenever a charge is banked (sweep shows the refill).
    const ready = e.ability === "dash" ? p.dashCharges > 0 : remaining === 0;
    const frac = e.ability === "dash" && p.dashCharges >= CONFIG.dashCharges
      ? 0
      : Math.max(0, Math.min(1, remaining / base));
    chip.style.setProperty("--cd", String(frac));
    chip.classList.toggle("ready", ready);
  });
  // XP strip (health lives in the top-left HUD).
  xpFill.style.width = `${Math.max(0, Math.min(1, p.xp / p.xpToNext)) * 100}%`;
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

// DCC "System" announcer, routed by priority + kind (backlog #9). High-priority
// lines get the exclusive center banner; everything else goes to the compact
// right-rail ticker, filtered by the player's verbosity setting. Every line is
// also in the HUD log, so filtering loses nothing.
const TICKER_MAX = 6; // visible ticker lines before the oldest is evicted
const TICKER_HOLD_MS = 4200;
const BANNER_HOLD_MS = 3400;

// What each verbosity tier lets through to the ticker (banners are unaffected).
const TICKER_KINDS: Record<NotifyLevel, readonly AnnouncementKind[]> = {
  all: ["boss", "progress", "levelup", "loot", "achievement", "show", "flavor"],
  normal: ["boss", "progress", "levelup", "loot", "achievement", "show"],
  critical: ["boss", "progress", "achievement"],
};

function showAnnouncement(a: Announcement): void {
  if (a.priority === "high") { showBanner(a); return; }
  if (!TICKER_KINDS[notifyLevel].includes(a.kind)) return; // HUD log still has it
  const el = document.createElement("div");
  el.className = `tk tk-${a.kind}`;
  el.textContent = a.text;
  tickerLayer.appendChild(el);
  while (tickerLayer.children.length > TICKER_MAX) tickerLayer.firstElementChild!.remove();
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 350);
  }, TICKER_HOLD_MS);
}

// Headline moments (boss down, new band, wipe): one at a time, front and center.
// #headline, NOT #banner — that id belongs to the keybinds strip at the top.
const bannerLayer = document.getElementById("headline")!;
const bannerQueue: Announcement[] = [];
let bannerActive = false;

function showBanner(a: Announcement): void {
  if (bannerActive) { bannerQueue.push(a); return; }
  bannerActive = true;
  const el = document.createElement("div");
  el.className = "ann banner";
  el.textContent = a.text;
  bannerLayer.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 400);
    bannerActive = false;
    const next = bannerQueue.shift();
    if (next) showBanner(next);
  }, BANNER_HOLD_MS);
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
    `<span style="color:${rc}">ATK ${p.attackPower} · MAG ${p.spellPower} (${p.weaponRarity})</span><br>` +
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
// Kill pop (solo only): a few frames of sim freeze on killing blows while the
// renderer keeps running, so particles fly through the freeze. Purely cosmetic —
// the deterministic sim just receives no steps for ~2-7 frames.
let hitStop = 0;

// Network mode: transient feedback arrives as an event stream, buffered here
// until the frame loop consumes it.
const netHits: HitEvent[] = [];
const netAnns: Announcement[] = [];
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
      showAnnouncement({ text: "CONNECTION LOST. The System apologizes for the technical difficulties.", kind: "flavor", priority: "high" });
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
    const frameAnns: Announcement[] = [];

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
      srTab = "shop"; // every safe room opens on today's shelf
      shopView = "stock";
      shopSel = null;
      renderSafeRoom(state);
      srEl.style.display = "flex";
    }
    if (srEl.style.display === "flex" && !inSafeRoom) srEl.style.display = "none";

    if (!net) {
      // Local sim. Panels/drafts/safe room pause it (a host UX choice — the
      // networked world never pauses for drafts); drop accumulated time.
      if (invOpen || abilOpen || kbOpen || draftPending || inSafeRoom) acc = 0;
      if (hitStop > 0) { hitStop = Math.max(0, hitStop - dt); acc = 0; } // kill pop
      while (acc >= SIM_DT) {
        step(state, sampleIntent(), SIM_DT);
        for (const e of state.events) log.push(e);
        frameHits.push(...state.hits);
        frameAnns.push(...state.announcements);
        acc -= SIM_DT;
        if (state.floor !== lastFloor) { lastFloor = state.floor; saveRun(state); }
        if (state.status !== lastStatus) { lastStatus = state.status; saveRun(state); }
      }
      // Killing blows schedule the next freeze: crits pop hardest, player deaths
      // hang for drama, ordinary kills get a couple of frames.
      for (const h of frameHits) {
        if (!h.killed) continue;
        hitStop = Math.min(0.12, hitStop + (h.kind === "crit" ? 0.06 : h.kind === "player" ? 0.09 : 0.035));
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
    updateBossBar(state);
    drawMinimap(state);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

void main();
