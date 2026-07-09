// Roam mode v1 (SETTLEMENTS.md): the settlement's one resident and its one
// quest. Deliberately minimal — no dialogue trees, no multi-quest system, no
// vendor. Dialogue rides state.events (not state.announcements, which
// VOICE.md reserves for the System's voice) so the NPC reads as its own
// register without touching that boundary.
import { generateItem } from "./items";
import type { GameState, Monster, Npc, Player, Quest, Reward, RoomRect } from "./types";
import { CONFIG } from "./config";

const TRIBE_LABELS: Record<string, string> = {
  drumline: "Drumline",
};

function roomCenter(r: RoomRect): { x: number; y: number } {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** Called once per Roam floor build, after monsters spawn. No-op on Race floors. */
export function spawnSettlement(state: GameState): void {
  const idx = state.map.settlementRoomIdx;
  if (idx < 0) {
    state.npc = null;
    state.quest = null;
    return;
  }
  const pos = roomCenter(state.map.rooms[idx]);
  const npc: Npc = { id: state.nextEntityId++, pos, name: "The Innkeep", kind: "settlement" };
  const quest: Quest = {
    id: state.nextEntityId++,
    tribe: CONFIG.roamTribeId,
    target: CONFIG.roamQuestTarget,
    killed: 0,
    state: "offered",
  };
  state.npc = npc;
  state.quest = quest;
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
  const q = state.quest;
  const npc = state.npc;
  if (!q || !npc) return;
  const tribeLabel = TRIBE_LABELS[q.tribe] ?? q.tribe;
  if (q.state === "offered") {
    q.state = "active";
    state.events.push(
      `${npc.name}: The ${tribeLabel} have been raiding this camp. Thin their numbers — ${q.target} kills — and I'll make it worth your while.`,
    );
    return;
  }
  if (q.state === "active") {
    if (q.killed >= q.target) {
      q.state = "complete";
      state.events.push(`${npc.name}: That's the last of them for now. Here — take your pick.`);
      p.pendingRewards = buildQuestRewards(state);
      return;
    }
    state.events.push(`${npc.name}: Still ${q.target - q.killed} of them out there. Go on.`);
    return;
  }
  state.events.push(`${npc.name}: Quiet for now. Thanks for that.`);
}

/** Called from reapDead in game.ts for every monster that just died. */
export function creditQuestKill(state: GameState, m: Monster): void {
  const q = state.quest;
  if (!q || q.state !== "active" || !m.tribe || m.tribe !== q.tribe) return;
  q.killed++;
}
