import { CONFIG } from "./config";
import { DISCOVERABLE_ABILITIES, UPGRADES, knows, rank } from "./abilities";
import type { GameState, Player } from "./types";

// DCC-style System achievements: absurd names, real rewards. Checked
// deterministically at the end of every step, per player, against sim state plus
// cheap per-step flags the sim sets while it works. Unlocks announce in the System
// voice and pay out gold + hype on the spot; each unlock also queues a loot
// box (Player.unclaimedAchievements) that waits for a Safe Room's
// ACHIEVEMENTS tab — loot boxes are achievement-exclusive, see openLootBox/
// claimAchievementLootBox in game.ts.

export interface AchievementDef {
  id: string;
  title: string;
  desc: string; // shown in the abilities panel; also the unlock hint
  gold: number; // payout
  hype: number;
  test: (s: GameState, p: Player) => boolean;
}

export const ACHIEVEMENTS: AchievementDef[] = [
  {
    id: "first_blood", title: "FIRST BLOOD", desc: "Kill your first monster.",
    gold: 10, hype: 5, test: (_s, p) => p.kills >= 1,
  },
  {
    id: "dirty_fighter", title: "DIRTY FIGHTER", desc: "Kill 3+ enemies in a single instant (floor 2+).",
    gold: 40, hype: 15, test: (s, p) => s.floor >= 2 && p.killsThisStep >= 3,
  },
  {
    id: "crumbs", title: "CRUMBS", desc: "Descend from a floor that is actively collapsing.",
    gold: 60, hype: 25, test: (s, p) => s.escapedCollapse && p.alive,
  },
  {
    id: "glass_cannon", title: "GLASS CANNON", desc: "Kill a monster while below 10% HP (floor 3+).",
    gold: 50, hype: 20, test: (s, p) => s.floor >= 3 && p.lowHpKill,
  },
  {
    id: "collector", title: "COLLECTOR'S EDITION", desc: "Learn every discoverable ability.",
    gold: 80, hype: 20,
    test: (_s, p) => DISCOVERABLE_ABILITIES.every((a) => knows(p, a)),
  },
  {
    id: "maxed", title: "FULLY OPERATIONAL", desc: "Max out any upgrade node.",
    gold: 60, hype: 15,
    test: (_s, p) => UPGRADES.some((u) => rank(p, u.id) >= u.maxRank),
  },
  {
    id: "shopping_spree", title: "RETAIL THERAPY", desc: "Spend 350 gold in safe-room shops.",
    gold: 50, hype: 10, test: (_s, p) => p.goldSpent >= 350,
  },
  {
    id: "pacifist", title: "CONSCIENTIOUS OBJECTOR", desc: "Reach floor 5 with fewer than 15 kills.",
    gold: 40, hype: 15, test: (s, p) => s.floor >= 5 && p.kills < 15,
  },
  {
    id: "funded", title: "SELLOUT", desc: "Hold 3 sponsors at once.",
    gold: 100, hype: 0, test: (_s, p) => p.sponsors >= 3,
  },
  {
    id: "deep_dive", title: "BASEMENT DWELLER", desc: `Reach floor ${Math.floor(CONFIG.finalFloor / 2)}.`,
    gold: 120, hype: 30, test: (s) => s.floor >= Math.floor(CONFIG.finalFloor / 2),
  },
  {
    id: "hoarder", title: "LIQUIDITY EVENT", desc: "Hold 900 gold at once.",
    gold: 0, hype: 25, test: (_s, p) => p.gold >= 900,
  },
  {
    id: "untouchable", title: "UNTOUCHABLE", desc: "Clear a floor's monsters without dropping below 90% HP (floor 2+).",
    gold: 70, hype: 20,
    test: (s, p) => s.floor >= 2 && s.monsters.length === 0 && p.kills > 0 && p.hp >= p.maxHp * 0.9,
  },
  {
    id: "final_descent", title: "SEASON FINALE", desc: `Escape the dungeon (reach floor ${CONFIG.finalFloor}).`,
    gold: 250, hype: 60, test: (s) => s.floor >= CONFIG.finalFloor,
  },
];

const BY_ID = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));

export function achievementDef(id: string): AchievementDef | undefined {
  return BY_ID.get(id);
}

export function isUnlocked(p: Player, id: string): boolean {
  return p.achievements.includes(id);
}
