import { CONFIG } from "./config";
import { DISCOVERABLE_ABILITIES, UPGRADES, knows, rank } from "./abilities";
import type { GameState } from "./types";

// DCC-style System achievements: absurd names, real rewards. Checked
// deterministically at the end of every step against sim state (plus a few cheap
// per-step flags the sim sets while it works). Unlocks announce in the System
// voice and pay out gold + hype on the spot.

export interface AchievementDef {
  id: string;
  title: string;
  desc: string; // shown in the abilities panel; also the unlock hint
  gold: number; // payout
  hype: number;
  test: (s: GameState) => boolean;
}

export const ACHIEVEMENTS: AchievementDef[] = [
  {
    id: "first_blood", title: "FIRST BLOOD", desc: "Kill your first monster.",
    gold: 10, hype: 5, test: (s) => s.killCount >= 1,
  },
  {
    id: "dirty_fighter", title: "DIRTY FIGHTER", desc: "Kill 3+ enemies in a single instant.",
    gold: 40, hype: 15, test: (s) => s.killsThisStep >= 3,
  },
  {
    id: "crumbs", title: "CRUMBS", desc: "Descend from a floor that is actively collapsing.",
    gold: 60, hype: 25, test: (s) => s.escapedCollapse,
  },
  {
    id: "glass_cannon", title: "GLASS CANNON", desc: "Kill a monster while below 10% HP.",
    gold: 50, hype: 20, test: (s) => s.lowHpKill,
  },
  {
    id: "collector", title: "COLLECTOR'S EDITION", desc: "Learn every discoverable ability.",
    gold: 80, hype: 20,
    test: (s) => DISCOVERABLE_ABILITIES.every((a) => knows(s.player, a)),
  },
  {
    id: "maxed", title: "FULLY OPERATIONAL", desc: "Max out any upgrade node.",
    gold: 60, hype: 15,
    test: (s) => UPGRADES.some((u) => rank(s.player, u.id) >= u.maxRank),
  },
  {
    id: "shopping_spree", title: "RETAIL THERAPY", desc: "Spend 200 gold in safe-room shops.",
    gold: 50, hype: 10, test: (s) => s.goldSpent >= 200,
  },
  {
    id: "pacifist", title: "CONSCIENTIOUS OBJECTOR", desc: "Reach floor 3 with fewer than 10 kills.",
    gold: 40, hype: 15, test: (s) => s.floor >= 3 && s.killCount < 10,
  },
  {
    id: "funded", title: "SELLOUT", desc: "Hold 3 sponsors at once.",
    gold: 100, hype: 0, test: (s) => s.sponsors >= 3,
  },
  {
    id: "deep_dive", title: "BASEMENT DWELLER", desc: `Reach floor ${Math.floor(CONFIG.finalFloor / 2)}.`,
    gold: 120, hype: 30, test: (s) => s.floor >= Math.floor(CONFIG.finalFloor / 2),
  },
  {
    id: "hoarder", title: "LIQUIDITY EVENT", desc: "Hold 500 gold at once.",
    gold: 0, hype: 25, test: (s) => s.player.gold >= 500,
  },
  {
    id: "untouchable", title: "UNTOUCHABLE", desc: "Clear a floor's monsters without dropping below 90% HP.",
    gold: 70, hype: 20,
    test: (s) => s.monsters.length === 0 && s.killCount > 0 && s.player.hp >= s.player.maxHp * 0.9,
  },
];

const BY_ID = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));

export function achievementDef(id: string): AchievementDef | undefined {
  return BY_ID.get(id);
}

export function isUnlocked(s: GameState, id: string): boolean {
  return s.achievements.includes(id);
}
