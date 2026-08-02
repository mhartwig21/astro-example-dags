// Roam mode (SETTLEMENTS.md): settlements, residents, dialogue, and quests.
// Dialogue rides state.dialogue — its own channel, NOT state.announcements,
// which VOICE.md reserves for the System's voice. Settlement voices are the
// third register: civilians of the System's bureaucratic universe (civic
// satire in the names, weary pragmatism in the lines), never the announcer.
//
// Everything here is plain serializable data + deterministic selection
// (state.rng at build time; a hashed per-NPC rng for dialogue flavor), so
// snapshot.ts needs nothing and replays reproduce every line.
import { generateItem } from "./items";
import { CATALOG } from "./catalog";
import { createRng, nextInt, pick, type Rng } from "./rng";
import { isWalkable, settlementRoomAt } from "./floor";
import type {
  DialogueChoice, DialogueLine, GameState, Monster, Npc, NpcRole,
  Player, Quest, QuestObjective, Reward, RoomRect, SafeRoom, Settlement, Vec2,
} from "./types";
import { CONFIG, FLOOR_BANDS, floorBand, roamTribeId } from "./config";
import { dhypot } from "./dmath";

// Tribe flavor names double as the actual PACK_TEMPLATES flagship for that
// band — a Drumline quest is quite literally about Drum Sergeant packs.
const TRIBE_LABELS: Record<string, string> = {
  undercroft: "The Reception",
  sewers: "The Drumline",
  garden: "The Hook Squad",
  ruins: "The Procession",
  ironworks: "The Assembly Line",
  approach: "The Entourage",
};

// Settlement names, banded — the civic-satire register (SETTLEMENTS.md §1:
// the System's bureaucratic universe leaking into place names).
const SETTLEMENT_NAMES: string[][] = [
  ["The Waiting Room", "Coat Check", "Lobby Annex", "Front Desk Commons"], // undercroft
  ["Overflow Commons", "Sump Terrace", "Runoff Row", "The Grate Society"], // sewers
  ["The Allotments", "Trellis Court", "Compost Row", "Pergola Commons"], // garden
  ["Probate Court", "The Escrow", "Landmark District", "Condemned Plaza"], // ruins
  ["Union Hall", "Shift Change", "Payroll Row", "The Foundry Canteen"], // ironworks
  ["Last Exit", "Departures", "Checkout Lane", "The Mezzanine"], // approach
];

const NPC_NAMES: Record<Exclude<NpcRole, "guide">, string[]> = {
  trader: ["Fee-Simple Fran", "Discount Dmitri", "Markup Marla", "Two-Receipts Tobin"],
  quartermaster: ["Requisitions Brill", "Quartermaster Sorrel", "Inventory Ines", "Depot Warden Kesh"],
  rumor: ["Hearsay Hollis", "Footnote Fen", "The Subscriber", "Rumor-Monger Rill"],
  elder: ["Alderman Root", "Elder Pomp", "Chairwoman Vess", "The Long Tenant"],
};

// Guide (Mordecai) first-time tips — once EVER per crawler, gated through the
// same tipsSeen ledger the System's rule tips use (persisted with the save).
const GUIDE_TIPS: { id: string; text: string }[] = [
  { id: "roam.sanctuary", text: "Monsters won't set foot in a settlement. The System calls it a 'no-liability zone.' Catch your breath inside the walls — nothing follows you in." },
  { id: "roam.services", text: "Every settlement runs a shop and a patch-up service, and you can re-slot your abilities inside the walls. Out here the safe room comes to you." },
  { id: "roam.quests", text: "Residents post work. Take a job, do the job, come back — the payouts ride the same draft the sponsors use, and nobody down here checks your ratings." },
  { id: "roam.clock", text: "No collapse sprint out here — the clock is long. Doesn't mean it's kind. Deeper floors send meaner tribes; leave before you're the payout." },
];

const DELIVERY_CARGO = [
  "a crate of unlicensed seasoning",
  "a sealed complaint, notarized twice",
  "a replacement kettle (the good one)",
  "a ledger nobody wants audited",
  "medical supplies, only slightly expired",
];

function dist(a: Vec2, b: Vec2): number {
  return dhypot(a.x - b.x, a.y - b.y);
}

function roomCenter(r: RoomRect): Vec2 {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** All NPCs on the floor (v1 snapshots only carried the singular field). */
export function npcsOf(state: GameState): Npc[] {
  return state.npcs ?? (state.npc ? [state.npc] : []);
}

/** The settlement whose room this position is inside (no pad), or null. */
export function settlementAt(state: GameState, pos: Vec2): Settlement | null {
  const roomIdx = settlementRoomAt(state.map, pos.x, pos.y, 0);
  if (roomIdx < 0) return null;
  return (state.settlements ?? []).find((s) => s.roomIdx === roomIdx) ?? null;
}

/** True when the player stands inside any settlement room (sanctuary). */
export function playerInSettlement(state: GameState, p: Player): boolean {
  return state.runKind === "roam" && settlementRoomAt(state.map, p.pos.x, p.pos.y, 0) >= 0;
}

/** The settlement shop the player is standing in (shopRoomFor's Roam leg). */
export function settlementShopFor(state: GameState, p: Player): SafeRoom | null {
  if (state.runKind !== "roam") return null;
  return settlementAt(state, p.pos)?.shop ?? null;
}

/** A stable per-(floor, npc) rng for dialogue flavor: re-talking shows the
 * same greeting, different floors/NPCs get different ones, and the main
 * stream is never consumed by chatter. */
function flavorRng(state: GameState, npcId: number): Rng {
  const h = (Math.imul(state.seed ^ (state.floor * 0x9e3779b1), 0x85ebca6b) ^ Math.imul(npcId + 1, 0xc2b2ae35)) >>> 0;
  return createRng(h);
}

/** A walkable spot inside the room near a preferred offset from center. */
function npcSpot(state: GameState, r: RoomRect, slot: number): Vec2 {
  const c = roomCenter(r);
  const offsets: [number, number][] = [[0, 0], [-2, -1], [2, 1], [1, -2], [-2, 2], [2, -2], [-1, 1]];
  for (let i = slot; i < slot + offsets.length; i++) {
    const [dx, dy] = offsets[i % offsets.length];
    const x = c.x + dx, y = c.y + dy;
    if (x > r.x + 0.5 && x < r.x + r.w - 0.5 && y > r.y + 0.5 && y < r.y + r.h - 0.5 && isWalkable(state.map, x, y)) {
      return { x, y };
    }
  }
  return c;
}

/** Roll a settlement vendor's shelf: consumables that make sense mid-floor
 * plus a seeded slice of the gear catalog (deeper floors stock deeper tiers).
 * Same catalog, settlement-flavored stock — the System franchises. */
function rollSettlementShelf(state: GameState, rng: Rng): string[] {
  const available: string[] = ["field_ration", "plating_kit", "system_favor"];
  const tiers = state.floor >= 6 ? ["starter", "basic", "advanced"] : ["starter", "basic"];
  const pool = CATALOG.filter((e) => tiers.includes(e.tier));
  const picks = new Set<string>();
  const n = Math.min(CONFIG.roamVendorGearStock, pool.length);
  while (picks.size < n) picks.add(pick(rng, pool).id);
  // Catalog order keeps the shelf layout stable settlement to settlement.
  available.push(...CATALOG.filter((e) => picks.has(e.id)).map((e) => e.id));
  return available;
}

function questDone(state: GameState, q: Quest): boolean {
  const o = q.objective;
  switch (o.kind) {
    case "killTribe": return o.killed >= o.target;
    case "clearStronghold": return state.strongholdCleared;
    case "cache": return o.recovered;
    case "delivery": return o.delivered;
    case "beacons": return o.spots.every((s) => s.lit);
  }
}

/**
 * Called once per Roam floor build, after monsters spawn. Builds every
 * settlement (residents, vendor shelves) and the floor's quest board.
 * No-op on Race floors. Deterministic: state.rng in build sequence.
 */
export function spawnSettlement(state: GameState): void {
  const idxs = state.map.settlementRoomIdxs ?? (state.map.settlementRoomIdx >= 0 ? [state.map.settlementRoomIdx] : []);
  state.npcs = [];
  state.settlements = [];
  state.quests = [];
  state.dialogue = null;
  state.npc = null;
  if (idxs.length === 0) return;

  const rng = state.rng;
  const band = floorBand(state.floor);
  const namePool = [...SETTLEMENT_NAMES[band]];
  const rolePools: Record<Exclude<NpcRole, "guide">, string[]> = {
    trader: [...NPC_NAMES.trader],
    quartermaster: [...NPC_NAMES.quartermaster],
    rumor: [...NPC_NAMES.rumor],
    elder: [...NPC_NAMES.elder],
  };
  const draw = (role: Exclude<NpcRole, "guide">): string => {
    const pool = rolePools[role];
    if (pool.length === 0) return NPC_NAMES[role][0];
    return pool.splice(nextInt(rng, 0, pool.length - 1), 1)[0];
  };

  idxs.forEach((roomIdx, i) => {
    const r = state.map.rooms[roomIdx];
    const entrance = i === 0;
    const settlement: Settlement = {
      id: state.nextEntityId++,
      name: namePool.length > 0 ? namePool.splice(nextInt(rng, 0, namePool.length - 1), 1)[0] : `Annex ${i + 1}`,
      roomIdx,
      entrance,
      npcIds: [],
      shop: {
        nextFloor: state.floor, // price basis: the floor you're standing on
        available: rollSettlementShelf(state, rng),
        tip: "",
        ready: [],
        purchased: {},
      },
    };
    // Residents: every settlement gets a working vendor (trader) + the
    // safe-room service (quartermaster); the entrance one houses the guide,
    // outlying ones alternate rumor-mongers and tribe elders.
    const roles: NpcRole[] = entrance
      ? ["guide", "trader", "quartermaster", "elder"]
      : ["trader", "quartermaster", i % 2 === 1 ? "rumor" : "elder"];
    roles.forEach((role, slot) => {
      const npc: Npc = {
        id: state.nextEntityId++,
        pos: npcSpot(state, r, slot * 2),
        name: role === "guide" ? "Mordecai" : draw(role),
        kind: "settlement",
        role,
        settlementId: settlement.id,
        portraitId: role === "guide" ? "mordecai" : role,
      };
      state.npcs!.push(npc);
      settlement.npcIds.push(npc.id);
      if (role === "guide") state.npc = npc; // legacy singular field: the guide
    });
    state.settlements!.push(settlement);
  });

  buildQuestBoard(state);
}

/** The floor's quest board: killTribe anchors it (v1), plus 1-2 extra
 * archetypes, every quest from a DIFFERENT resident. */
function buildQuestBoard(state: GameState): void {
  const rng = state.rng;
  const npcs = state.npcs!;
  const settlements = state.settlements!;
  const giverFor = (role: NpcRole, avoid: Set<number>): Npc => {
    const cands = npcs.filter((n) => n.role === role && !avoid.has(n.id));
    return cands.length > 0 ? pick(rng, cands) : npcs.filter((n) => !avoid.has(n.id))[0] ?? npcs[0];
  };
  const used = new Set<number>();

  // 1) The anchor: thin the floor's tribe. Giver: a tribe elder.
  const cullGiver = giverFor("elder", used);
  used.add(cullGiver.id);
  state.quests.push({
    id: state.nextEntityId++,
    key: "cull",
    giverNpcId: cullGiver.id,
    title: "Pest Control",
    objective: { kind: "killTribe", tribe: roamTribeId(state.floor), target: CONFIG.roamQuestTarget, killed: 0 },
    state: "offered",
  });

  // 2) Extra archetypes, rotated by floor so campaigns see variety. Only
  // archetypes the floor supports (a vault for the cache, a second
  // settlement for the delivery).
  const vaultIdx = state.map.roles.indexOf("vault");
  const order: ("cache" | "delivery" | "beacons")[] = ["cache", "delivery", "beacons"];
  for (let k = 0; k < state.floor % 3; k++) order.push(order.shift()!);
  const extras = nextInt(rng, CONFIG.roamQuestsPerFloorMin, CONFIG.roamQuestsPerFloorMax) - 1;
  let added = 0;
  for (const kind of order) {
    if (added >= extras) break;
    if (kind === "cache") {
      if (vaultIdx < 0) continue;
      const giver = giverFor("quartermaster", used);
      used.add(giver.id);
      state.quests.push({
        id: state.nextEntityId++,
        key: "cache",
        giverNpcId: giver.id,
        title: "Repossession Notice",
        objective: { kind: "cache", roomIdx: vaultIdx, recovered: false },
        state: "offered",
      });
      added++;
    } else if (kind === "delivery") {
      if (settlements.length < 2) continue;
      const giver = giverFor("trader", used);
      used.add(giver.id);
      const giverSettlement = giver.settlementId;
      const targets = npcs.filter((n) => n.settlementId !== giverSettlement && n.role !== "guide" && !used.has(n.id));
      if (targets.length === 0) continue;
      const to = pick(rng, targets);
      state.quests.push({
        id: state.nextEntityId++,
        key: "delivery",
        giverNpcId: giver.id,
        title: "Final Notice, Hand-Delivered",
        objective: {
          kind: "delivery", toNpcId: to.id, toName: to.name,
          toSettlementId: to.settlementId ?? -1, cargo: pick(rng, DELIVERY_CARGO), delivered: false,
        },
        state: "offered",
      });
      added++;
    } else {
      // Beacons: far-apart combat-room centers.
      const cands = state.map.rooms
        .map((r, i) => ({ r, i }))
        .filter(({ i }) => state.map.roles[i] === "combat")
        .map(({ r }) => roomCenter(r));
      if (cands.length === 0) continue;
      const spots: { x: number; y: number; lit: boolean }[] = [];
      const minSep = Math.min(state.map.w, state.map.h) / 5;
      while (spots.length < CONFIG.roamBeaconCount && cands.length > 0) {
        const c = cands.splice(nextInt(rng, 0, cands.length - 1), 1)[0];
        if (spots.some((s) => dhypot(s.x - c.x, s.y - c.y) < minSep)) continue;
        spots.push({ x: c.x, y: c.y, lit: false });
      }
      if (spots.length === 0) continue;
      const giver = giverFor("rumor", used);
      used.add(giver.id);
      state.quests.push({
        id: state.nextEntityId++,
        key: "beacons",
        giverNpcId: giver.id,
        title: "Municipal Lighting Initiative",
        objective: { kind: "beacons", spots },
        state: "offered",
      });
      added++;
    }
  }
}

function buildQuestRewards(state: GameState): Reward[] {
  const floor = state.floor;
  const goldAmt = Math.round(40 + floor * 10);
  const item = generateItem(state.rng, floor, () => state.nextEntityId++);
  return [
    { id: state.nextEntityId++, kind: "gold", title: "Bounty Purse", desc: `+${goldAmt} gold`, amount: goldAmt, source: "quest" },
    {
      id: state.nextEntityId++, kind: "materials", title: "Settlement Cache",
      desc: "+1 Elite Trophy", amount: 1, material: "elite_trophy", source: "quest",
    },
    { id: state.nextEntityId++, kind: "item", title: item.name, desc: `${item.rarity} ${item.slot}`, amount: 0, item, source: "quest" },
  ];
}

// ---- Dialogue ----

function greetingFor(state: GameState, npc: Npc, settlement: Settlement | null): string {
  const rng = flavorRng(state, npc.id);
  const where = settlement?.name ?? "this camp";
  const tribe = TRIBE_LABELS[roamTribeId(state.floor)] ?? "the locals";
  switch (npc.role ?? "elder") {
    case "guide":
      return pick(rng, [
        `Made it in one piece. Good. ${where} is the closest thing to safe this floor offers — ask me what's out there before you wander.`,
        `You again. Sit, drink something. The dungeon will still be trying to kill you in five minutes.`,
        `Welcome to ${where}. I keep the lights on and the odds honest. Mostly the lights.`,
      ]);
    case "trader":
      return pick(rng, [
        `Everything's for sale, everything's marked up, everything's final. Welcome to ${where}.`,
        `Stock's fresh. Well — stocked, anyway. What do you need?`,
        `The System franchises, I retail. Browse all you like.`,
      ]);
    case "quartermaster":
      return pick(rng, [
        `You look like a liability report. I can patch that, for a fee.`,
        `Bandages, splints, and no questions. That's the service.`,
        `Requisitions are closed. Repairs are open. Which are you?`,
      ]);
    case "rumor":
      return pick(rng, [
        `I hear things. Doors, stairs, who's camping where. Hearing them back costs.`,
        `Everything on this floor leaves a rumor. I collect. You buy.`,
        `Psst. The stairs aren't where you think. For a price, they are.`,
      ]);
    default:
      return pick(rng, [
        `${tribe} press us a little harder every season. We hold. Barely.`,
        `We were here before the show found this floor. We'll be here after, if the ledgers allow.`,
        `Speak your business, crawler. The camp's watching either way.`,
      ]);
  }
}

function offerLine(q: Quest): string {
  const o = q.objective;
  switch (o.kind) {
    case "killTribe":
      return `${TRIBE_LABELS[o.tribe] ?? o.tribe} have been raiding this camp. Thin their numbers — ${o.target} of them — and I'll make it worth your while.`;
    case "clearStronghold":
      return `There's a camp holding ground nearby — ${o.leaderName} runs it. Deal with their leader and I'll make it worth your while.`;
    case "cache":
      return `A supply cache of ours ended up in the old vault. Legally it's still ours. Practically, it's guarded. Fetch it back.`;
    case "delivery":
      return `I need ${o.cargo} carried to ${o.toName}, next settlement over. Hand it to them PERSONALLY — the last courier is a line item now.`;
    case "beacons":
      return `The floor's beacons have gone dark and the maintenance contract died with the maintenance crew. Light all ${o.spots.length} and the camp breathes easier.`;
  }
}

function nudgeLine(q: Quest): string {
  const o = q.objective;
  switch (o.kind) {
    case "killTribe":
      return `Still ${Math.max(0, o.target - o.killed)} of ${TRIBE_LABELS[o.tribe] ?? o.tribe} out there. Go on.`;
    case "clearStronghold":
      return `${o.leaderName}'s still out there holding that camp.`;
    case "cache":
      return `The cache is still sitting in that vault, gathering interest for somebody else.`;
    case "delivery":
      return `${o.toName} is still waiting on ${o.cargo}.`;
    case "beacons": {
      const lit = o.spots.filter((s) => s.lit).length;
      return `${lit} of ${o.spots.length} beacons lit. The dark ones are the problem.`;
    }
  }
}

function turnInLine(q: Quest): string {
  switch (q.objective.kind) {
    case "killTribe": return "That's the last of them for now. Here — take your pick.";
    case "clearStronghold": return `${q.objective.leaderName} down? Good riddance. Here — take your pick.`;
    case "cache": return "Our property, returned. The paperwork writes itself. Take your pick.";
    case "delivery": return "Delivered, signed, witnessed. You're hired if you ever quit dying for a living. Take your pick.";
    case "beacons": return "Lights on across the district. Almost looks like a neighborhood. Take your pick.";
  }
}

/** Choices this NPC offers this player right now. */
function buildChoices(state: GameState, npc: Npc): DialogueChoice[] {
  const choices: DialogueChoice[] = [];
  for (const q of state.quests) {
    if (q.state === "offered" && q.giverNpcId === npc.id) {
      choices.push({ id: `accept:${q.key ?? q.id}`, label: `Take the job: ${q.title ?? "the work"}`, effect: "acceptQuest", questKey: q.key });
    } else if (q.state === "active") {
      const o = q.objective;
      if (o.kind === "delivery" && o.toNpcId === npc.id && !o.delivered) {
        choices.push({ id: `turnin:${q.key ?? q.id}`, label: `Hand over ${o.cargo}`, effect: "turnIn", questKey: q.key });
      } else if (q.giverNpcId === npc.id && o.kind !== "delivery" && questDone(state, q)) {
        choices.push({ id: `turnin:${q.key ?? q.id}`, label: `Settle up: ${q.title ?? "the job"}`, effect: "turnIn", questKey: q.key });
      }
    }
  }
  const role = npc.role ?? "elder";
  if (role === "guide") {
    choices.push({ id: "orient", label: "What's out there?", effect: "orient" });
    choices.push({ id: "tip", label: "Any advice?", effect: "tip" });
  }
  if (role === "trader") {
    choices.push({ id: "vendor", label: "Show me the stock", effect: "vendor" });
  }
  if (role === "quartermaster") {
    choices.push({ id: "heal", label: "Patch me up", effect: "heal", price: healPrice(state) });
    choices.push({ id: "reslot", label: "I need to rework my kit", effect: "reslot" });
  }
  if (role === "rumor") {
    choices.push({ id: "rumor", label: "What have you heard?", effect: "rumor", price: rumorPrice(state) });
  }
  choices.push({ id: "farewell", label: "Farewell", effect: "farewell" });
  return choices;
}

function healPrice(state: GameState): number {
  return CONFIG.roamHealCostBase + state.floor * CONFIG.roamHealCostPerFloor;
}

function rumorPrice(state: GameState): number {
  return CONFIG.roamRumorCostBase + state.floor * CONFIG.roamRumorCostPerFloor;
}

/** Open a dialogue session with an NPC (the interact seam in game.ts). */
export function startDialogue(state: GameState, p: Player, npc: Npc): void {
  const settlement = (state.settlements ?? []).find((s) => s.id === npc.settlementId) ?? null;
  const lines: DialogueLine[] = [{ speaker: npc.name, text: greetingFor(state, npc, settlement) }];
  // Quest status flavor: the giver mentions ongoing business up front.
  for (const q of state.quests) {
    if (q.giverNpcId !== npc.id) continue;
    if (q.state === "offered") lines.push({ speaker: npc.name, text: offerLine(q) });
    else if (q.state === "active" && !questDone(state, q)) lines.push({ speaker: npc.name, text: nudgeLine(q) });
  }
  state.dialogue = {
    id: state.nextEntityId++,
    playerId: p.id,
    npcId: npc.id,
    npcName: npc.name,
    portraitId: npc.portraitId ?? npc.role ?? "elder",
    settlementId: npc.settlementId ?? -1,
    lines,
    choices: buildChoices(state, npc),
  };
}

/** Close the active session (host ESC / walked away). */
export function closeDialogue(state: GameState, playerId: number): void {
  if (state.dialogue && state.dialogue.playerId === playerId) state.dialogue = null;
}

/** Reveal explored ground in a radius (Mordecai's orientation, rumors). */
function revealArea(state: GameState, cx: number, cy: number, radius: number): void {
  const { w, h } = state.map;
  const r2 = radius * radius;
  for (let y = Math.max(0, Math.floor(cy - radius)); y <= Math.min(h - 1, Math.ceil(cy + radius)); y++) {
    for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(w - 1, Math.ceil(cx + radius)); x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r2) state.explored[y * w + x] = 1;
    }
  }
  state.exploredVersion++;
}

function compass(from: Vec2, to: Vec2): string {
  const dx = to.x - from.x, dy = to.y - from.y;
  const ns = dy < 0 ? "north" : "south";
  const ew = dx < 0 ? "west" : "east";
  return Math.abs(dx) > 2 * Math.abs(dy) ? ew : Math.abs(dy) > 2 * Math.abs(dx) ? ns : `${ns}${ew}`;
}

/** Apply a dialogue choice. Hosts call this with the choice id. */
export function chooseDialogue(state: GameState, playerId: number, choiceId: string): void {
  const session = state.dialogue;
  if (!session || session.playerId !== playerId || session.done) return;
  const p = state.players.find((pl) => pl.id === playerId);
  const npc = npcsOf(state).find((n) => n.id === session.npcId);
  if (!p || !npc) return;
  // Re-derive the choice list at answer time: quest progress may have moved
  // since the panel opened (a kill mid-conversation, a pickup), and the
  // valid answers are a fact of the STATE, not of the stale panel.
  session.choices = buildChoices(state, npc);
  const choice = session.choices.find((c) => c.id === choiceId);
  if (!choice) return;
  session.open = undefined;

  const say = (text: string) => { session.lines = [{ speaker: npc.name, text }]; };

  switch (choice.effect) {
    case "farewell": {
      state.dialogue = null;
      return;
    }
    case "vendor": {
      session.open = "vendor";
      say("Take your time. The prices won't improve, but they won't chase you either.");
      break;
    }
    case "reslot": {
      session.open = "reslot";
      say("Bench's yours. Rework the kit — nothing bites in here.");
      break;
    }
    case "heal": {
      const price = healPrice(state);
      if (p.gold < price) {
        say(`That's ${price} gold. Come back when the bounty clears.`);
        break;
      }
      p.gold -= price;
      p.goldSpent += price;
      p.hp = p.maxHp;
      p.statuses = [];
      state.hits.push({ pos: { x: p.pos.x, y: p.pos.y }, amount: p.maxHp, kind: "heal" });
      state.events.push(`${p.name} paid ${price} gold for a patch-up. Good as new.`);
      say("Good as new. Try to keep the new parts longer than the old ones.");
      break;
    }
    case "rumor": {
      const price = rumorPrice(state);
      if (p.gold < price) {
        say(`Rumors run ${price} gold. Silence is free.`);
        break;
      }
      p.gold -= price;
      p.goldSpent += price;
      const stairs = state.map.stairs;
      revealArea(state, stairs.x, stairs.y, 7);
      state.pings.push({ id: state.nextEntityId++, pos: { x: stairs.x, y: stairs.y }, byId: p.id, t: 90, total: 90 });
      state.events.push(`${p.name} bought a rumor: the stairway is marked.`);
      say(`The stairway down sits ${compass(npc.pos, stairs)} of here. I've marked it. You didn't hear it from me — you PAID for it from me.`);
      break;
    }
    case "orient": {
      const band = FLOOR_BANDS[floorBand(state.floor)];
      const tribe = TRIBE_LABELS[roamTribeId(state.floor)] ?? "the locals";
      const settlements = state.settlements ?? [];
      for (const s of settlements) {
        const c = roomCenter(state.map.rooms[s.roomIdx]);
        revealArea(state, c.x, c.y, 9);
      }
      const others = settlements.filter((s) => !s.entrance).map((s) => `${s.name} (${compass(npc.pos, roomCenter(state.map.rooms[s.roomIdx]))})`);
      const stairsDir = compass(npc.pos, state.map.stairs);
      say(
        `This stretch is ${band.name.toLowerCase()} country — ${tribe} run it, and they don't sublet. ` +
        (others.length > 0 ? `Besides us there's ${others.join(", ")} — I've marked them for you. ` : "") +
        `The stairway down is somewhere ${stairsDir}; the rumor trade sells the exact spot. Don't die between here and there.`,
      );
      break;
    }
    case "tip": {
      const seen = new Set(p.tipsSeen ?? []);
      const tip = GUIDE_TIPS.find((t) => !seen.has(t.id));
      if (tip) {
        p.tipsSeen = [...(p.tipsSeen ?? []), tip.id];
        say(tip.text);
      } else {
        say("Advice? You've had all of mine. Now it's just nagging: eat, sleep, don't fight anything with a title.");
      }
      break;
    }
    case "acceptQuest": {
      const q = state.quests.find((qq) => qq.key === choice.questKey && qq.state === "offered");
      if (!q) break;
      q.state = "active";
      if (q.objective.kind === "cache") spawnCacheProp(state, q.objective);
      state.events.push(`Quest accepted: ${q.title ?? q.key}.`);
      say(offerLine(q));
      break;
    }
    case "turnIn": {
      const q = state.quests.find((qq) => qq.key === choice.questKey && qq.state === "active");
      if (!q) break;
      const o = q.objective;
      const isDelivery = o.kind === "delivery" && o.toNpcId === npc.id && !o.delivered;
      if (!isDelivery && !questDone(state, q)) break;
      if (p.pendingRewards.length > 0) {
        say("Settle your other business first — I'm not stacking invoices.");
        break;
      }
      if (o.kind === "delivery") o.delivered = true;
      q.state = "complete";
      p.pendingRewards = buildQuestRewards(state);
      state.events.push(`Quest complete: ${q.title ?? q.key}.`);
      say(turnInLine(q));
      // The kill-tribe quest turning in points the camp at its stronghold —
      // only once, and only if one exists (v1 arc, kept).
      if (
        o.kind === "killTribe" &&
        state.map.strongholdRoomIdx >= 0 &&
        !state.quests.some((qq) => qq.objective.kind === "clearStronghold")
      ) {
        state.quests.push({
          id: state.nextEntityId++,
          key: "stronghold",
          giverNpcId: q.giverNpcId,
          title: "Eviction Proceedings",
          objective: { kind: "clearStronghold", leaderName: state.strongholdLeaderName || "their leader" },
          state: "offered",
        });
      }
      break;
    }
  }
  session.choices = buildChoices(state, npc);
}

/** The cache quest's prop: spawned on accept (and on save-restore of an
 * accepted-but-unrecovered quest). Sits in the vault room. */
function spawnCacheProp(state: GameState, o: Extract<QuestObjective, { kind: "cache" }>): void {
  const r = state.map.rooms[o.roomIdx];
  if (!r) return;
  const c = roomCenter(r);
  const spot = isWalkable(state.map, c.x, c.y) ? c : npcSpot(state, r, 1);
  state.loot.push({ id: state.nextEntityId++, pos: spot, kind: "cache", amount: 0 });
}

/** collectLoot's cache leg: mark the active cache quest recovered. */
export function creditCachePickup(state: GameState, p: Player): void {
  const q = state.quests.find((qq) => qq.state === "active" && qq.objective.kind === "cache");
  if (q && q.objective.kind === "cache" && !q.objective.recovered) {
    q.objective.recovered = true;
    state.events.push(`${p.name} recovered the cache. Someone in a settlement wants it back.`);
  }
}

/** Called from reapDead in game.ts for every monster that just died. */
export function creditQuestKill(state: GameState, m: Monster): void {
  if (!m.tribe) return;
  const q = state.quests.find(
    (qq) => qq.state === "active" && qq.objective.kind === "killTribe" && qq.objective.tribe === m.tribe,
  );
  if (q && q.objective.kind === "killTribe") q.objective.killed++;
}

/**
 * Per-step Roam upkeep (cheap; early-outs on Race floors): beacon lighting
 * by proximity, and auto-closing a dialogue whose player walked away.
 */
export function updateRoam(state: GameState): void {
  if (state.runKind !== "roam") return;
  const session = state.dialogue;
  if (session) {
    const p = state.players.find((pl) => pl.id === session.playerId);
    const npc = npcsOf(state).find((n) => n.id === session.npcId);
    if (!p || !p.alive || !npc || dist(p.pos, npc.pos) > 3) state.dialogue = null;
  }
  for (const q of state.quests) {
    if (q.state !== "active" || q.objective.kind !== "beacons") continue;
    for (const s of q.objective.spots) {
      if (s.lit) continue;
      const lighter = state.players.find((p) => p.alive && dhypot(p.pos.x - s.x, p.pos.y - s.y) <= 1.4);
      if (!lighter) continue;
      s.lit = true;
      const left = q.objective.spots.filter((sp) => !sp.lit).length;
      state.events.push(
        left > 0
          ? `${lighter.name} lit a beacon. ${left} still dark.`
          : `${lighter.name} lit the last beacon. The district glows.`,
      );
      state.hits.push({ pos: { x: s.x, y: s.y }, amount: 0, kind: "weapon" });
    }
  }
}

// ---- Persistence (BACKLOG #11 + #25) ----

/** Position key for a breakable — stable across rebuilds of the same
 * (seed, floor), unlike entity ids, which depend on run history. */
export function breakablePosKey(pos: Vec2): string {
  return `${pos.x.toFixed(2)},${pos.y.toFixed(2)}`;
}

/** Roam campaign state that must survive a save/load (quest progress,
 * consumed vendor stock, smashed hoards). Quest identity rides `key` —
 * generation is deterministic per (seed, floor), so keys match across
 * rebuilds even though entity ids don't. */
export interface RoamSaveState {
  quests?: {
    key: string;
    state: Quest["state"];
    killed?: number;
    recovered?: boolean;
    delivered?: boolean;
    lit?: number[]; // indices of lit beacon spots
  }[];
  purchased?: Record<string, number>[]; // per settlement, in spawn order
  strongholdCleared?: boolean;
  smashed?: string[]; // breakablePosKey of consumed breakables (#25)
}

export function toRoamSave(state: GameState): RoamSaveState {
  return {
    quests: state.quests
      .filter((q) => q.key)
      .map((q) => {
        const o = q.objective;
        return {
          key: q.key!,
          state: q.state,
          killed: o.kind === "killTribe" ? o.killed : undefined,
          recovered: o.kind === "cache" ? o.recovered : undefined,
          delivered: o.kind === "delivery" ? o.delivered : undefined,
          lit: o.kind === "beacons"
            ? o.spots.map((s, i) => (s.lit ? i : -1)).filter((i) => i >= 0)
            : undefined,
        };
      }),
    purchased: (state.settlements ?? []).map((s) => ({ ...s.shop.purchased })),
    strongholdCleared: state.strongholdCleared,
    smashed: [...(state.roamSmashed ?? [])],
  };
}

/** Overlay a saved Roam campaign onto a freshly rebuilt floor (restoreGame).
 * Must run AFTER buildFloor — it matches quests by key, settlements by spawn
 * order, and breakables by position. */
export function applyRoamSave(state: GameState, rs: RoamSaveState): void {
  if (rs.strongholdCleared) {
    state.strongholdCleared = true;
    // The leader is already dead in this campaign: remove the respawned copy
    // silently (no XP, no loot — the payout already happened).
    if (state.strongholdLeaderId >= 0) {
      state.monsters = state.monsters.filter((m) => m.id !== state.strongholdLeaderId);
    }
  }
  for (const sq of rs.quests ?? []) {
    let q = state.quests.find((qq) => qq.key === sq.key);
    if (!q && sq.key === "stronghold") {
      // Appended dynamically after the cull turns in — recreate it.
      q = {
        id: state.nextEntityId++,
        key: "stronghold",
        title: "Eviction Proceedings",
        objective: { kind: "clearStronghold", leaderName: state.strongholdLeaderName || "their leader" },
        state: sq.state,
      };
      state.quests.push(q);
    }
    if (!q) continue;
    q.state = sq.state;
    const o = q.objective;
    if (o.kind === "killTribe" && sq.killed !== undefined) o.killed = Math.min(o.target, sq.killed);
    if (o.kind === "cache") {
      o.recovered = sq.recovered ?? false;
      if (q.state === "active" && !o.recovered) spawnCacheProp(state, o);
    }
    if (o.kind === "delivery") o.delivered = sq.delivered ?? false;
    if (o.kind === "beacons" && sq.lit) {
      for (const i of sq.lit) if (o.spots[i]) o.spots[i].lit = true;
    }
  }
  (rs.purchased ?? []).forEach((bought, i) => {
    const s = state.settlements?.[i];
    if (s) s.shop.purchased = { ...bought };
  });
  if (rs.smashed && rs.smashed.length > 0) {
    const gone = new Set(rs.smashed);
    state.roamSmashed = [...rs.smashed];
    state.breakables = (state.breakables ?? []).filter((b) => {
      if (!gone.has(breakablePosKey(b.pos))) return true;
      // Blocking furniture opens its lane again, exactly as if smashed live.
      if (b.footprint && state.map.blocked) {
        for (const ti of b.footprint) state.map.blocked[ti] = 0;
      }
      return false;
    });
  }
}
