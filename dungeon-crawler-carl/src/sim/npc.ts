// Roam mode (SETTLEMENTS.md): the settlement's one resident and its quest
// board. Deliberately minimal — no dialogue trees, no vendor. Dialogue rides
// state.events (not state.announcements, which VOICE.md reserves for the
// System's voice) so the NPC reads as its own register without touching
// that boundary.
import { generateItem } from "./items";
import type { GameState, Monster, Npc, Player, Quest, QuestObjective, Reward, RoomRect } from "./types";
import { CONFIG, roamTribeId } from "./config";

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

function roomCenter(r: RoomRect): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** Called once per Roam floor build, after monsters spawn. No-op on Race floors. */
export function spawnSettlement(state: GameState): void {
  const idx = state.map.settlementRoomIdx;
  if (idx < 0) {
    state.npc = null;
    state.quests = [];
    return;
  }
  const pos = roomCenter(state.map.rooms[idx]);
  const npc: Npc = { id: state.nextEntityId++, pos, name: "The Innkeep", kind: "settlement" };
  const killTribe: Quest = {
    id: state.nextEntityId++,
    objective: { kind: "killTribe", tribe: roamTribeId(state.floor), target: CONFIG.roamQuestTarget, killed: 0 },
    state: "offered",
  };
  // clearStronghold isn't seeded here — it's appended once killTribe turns
  // in, framed as "the settlement pointing you at a nearby camp."
  state.npc = npc;
  state.quests = [killTribe];
}

function objectiveDone(state: GameState, o: QuestObjective): boolean {
  return o.kind === "killTribe" ? o.killed >= o.target : state.strongholdCleared;
}

function offerLine(npc: Npc, o: QuestObjective): string {
  if (o.kind === "killTribe") {
    const label = TRIBE_LABELS[o.tribe] ?? o.tribe;
    return `${npc.name}: ${label} have been raiding this camp. Thin their numbers — ${o.target} kills — and I'll make it worth your while.`;
  }
  return `${npc.name}: There's a camp holding ground nearby — ${o.leaderName} runs it. Deal with their leader and I'll make it worth your while.`;
}

function nudgeLine(npc: Npc, o: QuestObjective): string {
  if (o.kind === "killTribe") {
    const label = TRIBE_LABELS[o.tribe] ?? o.tribe;
    return `${npc.name}: Still ${o.target - o.killed} of ${label} out there. Go on.`;
  }
  return `${npc.name}: ${o.leaderName}'s still out there holding that camp.`;
}

function completeLine(npc: Npc, o: QuestObjective): string {
  if (o.kind === "killTribe") return `${npc.name}: That's the last of them for now. Here — take your pick.`;
  return `${npc.name}: ${o.leaderName} down? Good riddance. Here — take your pick.`;
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

/** Dispatched when a player interacts with the settlement NPC (see game.ts step()). */
export function talkToNpc(state: GameState, p: Player): void {
  const npc = state.npc;
  if (!npc) return;
  const q = state.quests.find((qq) => qq.state !== "complete");
  if (!q) {
    state.events.push(`${npc.name}: Quiet for now. Thanks for that.`);
    return;
  }
  if (q.state === "offered") {
    q.state = "active";
    state.events.push(offerLine(npc, q.objective));
    return;
  }
  if (!objectiveDone(state, q.objective)) {
    state.events.push(nudgeLine(npc, q.objective));
    return;
  }
  q.state = "complete";
  state.events.push(completeLine(npc, q.objective));
  p.pendingRewards = buildQuestRewards(state);
  // The kill-tribe quest turning in is what points the settlement at its
  // nearby stronghold — only offered once, and only if one exists.
  if (
    q.objective.kind === "killTribe" &&
    state.map.strongholdRoomIdx >= 0 &&
    !state.quests.some((qq) => qq.objective.kind === "clearStronghold")
  ) {
    state.quests.push({
      id: state.nextEntityId++,
      objective: { kind: "clearStronghold", leaderName: state.strongholdLeaderName || "their leader" },
      state: "offered",
    });
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
