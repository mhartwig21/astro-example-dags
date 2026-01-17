"""
Campaign Coordinator

Orchestrates campaigns by connecting:
- Pattern Books (what to do)
- Guilds (who does it)
- The Ledger (record of all actions)
- The Court (validation and promotion)

The coordinator launches campaigns based on patterns, summons
guild members for each workshop, and tracks progress.
"""

from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from data_kingdom.guild import GuildSpawner, PostMaster, Craft
from data_kingdom.guild.models import MemberStatus
from data_kingdom.ledger import LedgerStorage, generate_id, generate_child_id
from data_kingdom.ledger.records import (
    CampaignRecord,
    CampaignScope,
    CampaignStatus,
    HoldingRecord,
    Station,
)
from data_kingdom.pattern import PatternRegistry
from data_kingdom.pattern.models import PatternBook, Workshop


# Default craft mapping based on workshop type
WORKSHOP_CRAFT_MAP = {
    "build": Craft.ENGINEER,
    "transform": Craft.ENGINEER,
    "validate": Craft.SCHOLAR,
    "test": Craft.SCHOLAR,
    "deploy": Craft.WARDEN,
    "custom": Craft.ENGINEER,
}


class CampaignCoordinator:
    """
    Coordinates campaigns, patterns, and guilds.

    The coordinator is the central brain that:
    1. Launches campaigns from pattern books
    2. Assigns guild members to workshops
    3. Monitors progress
    4. Handles handoffs between workshops
    5. Reports status
    """

    def __init__(self, kingdom_root: Path | str):
        """
        Initialize the coordinator.

        Args:
            kingdom_root: Root directory of the Kingdom
        """
        self.kingdom_root = Path(kingdom_root)
        self.ledger = LedgerStorage(kingdom_root)
        self.spawner = GuildSpawner(kingdom_root)
        self.post_master = PostMaster(kingdom_root)
        self.patterns = PatternRegistry(kingdom_root)

    def launch_from_pattern(
        self,
        petition_id: str,
        pattern_name: str,
        holding_name: str,
        description: str = "",
        auto_summon: bool = False,
        inputs: Optional[dict] = None,
    ) -> CampaignRecord:
        """
        Launch a campaign based on a pattern book.

        Args:
            petition_id: ID of the petition this campaign fulfills
            pattern_name: Name of the pattern book to use
            holding_name: Name of the holding to produce
            description: Campaign description
            auto_summon: Whether to auto-summon guild members
            inputs: Pattern inputs

        Returns:
            The created CampaignRecord
        """
        # Load the pattern
        pattern = self.patterns.get(pattern_name)
        if not pattern:
            raise ValueError(f"Pattern not found: {pattern_name}")

        # Validate required inputs
        inputs = inputs or {}
        missing_inputs = [
            inp for inp in pattern.required_inputs if inp not in inputs
        ]
        if missing_inputs:
            raise ValueError(f"Missing required inputs: {missing_inputs}")

        # Get realm from inputs
        realm = inputs.get("realm", "unknown")

        # Create the campaign
        campaign_id = generate_child_id(petition_id, 1)
        campaign = CampaignRecord(
            id=campaign_id,
            parent=petition_id,
            objective=description or f"Produce {holding_name} using {pattern_name} pattern",
            scope=CampaignScope(
                realms_affected=[realm],
                holdings_affected=[holding_name],
            ),
            pattern_book=pattern_name,
            workshops_pending=[w.name for w in pattern.get_ordered_workshops()],
            status=CampaignStatus.ACTIVE,
            metadata={
                "pattern_inputs": inputs,
            },
        )

        # Write to ledger
        self.ledger.write(campaign)

        # Create the holding record
        holding_id = generate_child_id(campaign_id, 1)
        holding = HoldingRecord(
            id=holding_id,
            parent=campaign_id,
            name=holding_name,
            version="1.0.0",  # Initial version
            holding_type=pattern.holding_type,
            campaign_id=campaign_id,
            current_station=Station.DEVELOPMENT,
            metadata={
                "pattern": pattern_name,
                "inputs": inputs,
            },
        )
        self.ledger.write(holding)

        # Auto-summon guild members for each workshop if requested
        if auto_summon:
            self._summon_for_workshops(campaign_id, pattern)

        return campaign

    def _summon_for_workshops(
        self,
        campaign_id: str,
        pattern: PatternBook,
    ) -> list:
        """Summon guild members for pattern workshops."""
        summoned = []
        ordered_workshops = pattern.get_ordered_workshops()

        for workshop in ordered_workshops:
            # Determine craft for this workshop
            craft = self._get_craft_for_workshop(workshop)

            # Build task description
            task = self._build_workshop_task(workshop, pattern)

            # Summon a member
            try:
                member = self.spawner.summon(
                    campaign_id=campaign_id,
                    craft=craft,
                    task=task,
                    background=True,  # Run in background
                )
                summoned.append({
                    "workshop": workshop.name,
                    "member_id": member.id,
                    "craft": craft.value,
                    "status": member.status.value,
                })
            except Exception as e:
                summoned.append({
                    "workshop": workshop.name,
                    "error": str(e),
                })

        return summoned

    def _get_craft_for_workshop(self, workshop: Workshop) -> Craft:
        """Determine which craft should handle a workshop."""
        # Check if workshop has explicit craft assignment
        if workshop.craft:
            try:
                return Craft(workshop.craft)
            except ValueError:
                pass  # Fall through to default

        # Use default mapping based on workshop type
        return WORKSHOP_CRAFT_MAP.get(workshop.type.value, Craft.ENGINEER)

    def _build_workshop_task(
        self,
        workshop: Workshop,
        pattern: PatternBook,
    ) -> str:
        """Build a task description for a workshop."""
        task = f"Execute workshop '{workshop.name}' from pattern '{pattern.name}'.\n\n"

        if workshop.description:
            task += f"Workshop purpose: {workshop.description}\n\n"

        if workshop.command:
            task += f"Command to run: {workshop.command}\n\n"

        if workshop.config:
            task += f"Configuration: {workshop.config}\n\n"

        if workshop.depends_on:
            task += f"Dependencies: {', '.join(workshop.depends_on)}\n\n"

        if workshop.trials_after:
            task += f"Run these trials after completion: {', '.join(workshop.trials_after)}\n"

        return task

    def get_campaign_status(self, campaign_id: str) -> dict:
        """
        Get detailed status of a campaign.

        Returns dict with:
        - campaign: The campaign record
        - holdings: Holdings produced
        - posts: Active posts
        - members: Active guild members
        - workshops: Workshop completion status (if pattern-based)
        """
        campaign = self.ledger.read(campaign_id)
        holdings = self.ledger.get_children(campaign_id)
        posts = self.post_master.list_for_campaign(campaign_id)
        members = self.spawner.list_active(campaign_id)

        # Check for pattern info
        pattern_name = getattr(campaign, 'pattern_book', None)
        workshop_status = None

        if pattern_name:
            try:
                pattern = self.patterns.get(pattern_name)
                if pattern:
                    workshop_status = self._get_workshop_status(campaign_id, pattern, posts)
            except Exception:
                pass

        return {
            "campaign": campaign,
            "holdings": [h for h in holdings if h.record_type == "holding"],
            "posts": posts,
            "active_members": members,
            "workshop_status": workshop_status,
        }

    def _get_workshop_status(
        self,
        campaign_id: str,
        pattern: PatternBook,
        posts: list,
    ) -> list:
        """Get completion status for each workshop in a pattern."""
        status = []

        for workshop in pattern.get_ordered_workshops():
            # Check if there's a post working on this workshop
            workshop_posts = [
                p for p in posts
                if p.current_task and workshop.name in p.current_task
            ]

            completed_posts = [
                p for p in posts
                if any(workshop.name in task for task in p.completed_tasks)
            ]

            if completed_posts:
                state = "completed"
            elif workshop_posts:
                state = "in_progress"
            else:
                state = "pending"

            status.append({
                "workshop": workshop.name,
                "type": workshop.type.value,
                "craft": workshop.craft or WORKSHOP_CRAFT_MAP.get(workshop.type.value, Craft.ENGINEER).value,
                "state": state,
            })

        return status

    def summon_for_workshop(
        self,
        campaign_id: str,
        workshop_name: str,
        pattern_name: Optional[str] = None,
    ):
        """
        Summon a guild member for a specific workshop.

        Args:
            campaign_id: Campaign ID
            workshop_name: Name of the workshop
            pattern_name: Pattern to use (auto-detected from campaign if not specified)
        """
        # Get pattern from campaign if not specified
        if not pattern_name:
            campaign = self.ledger.read(campaign_id)
            pattern_name = getattr(campaign, 'pattern_book', None)

        if not pattern_name:
            raise ValueError("Pattern not specified and not found in campaign")

        pattern = self.patterns.get(pattern_name)
        if not pattern:
            raise ValueError(f"Pattern not found: {pattern_name}")

        workshop = pattern.get_workshop(workshop_name)
        if not workshop:
            raise ValueError(f"Workshop not found: {workshop_name}")

        craft = self._get_craft_for_workshop(workshop)
        task = self._build_workshop_task(workshop, pattern)

        return self.spawner.summon(
            campaign_id=campaign_id,
            craft=craft,
            task=task,
        )

    def complete_workshop(
        self,
        campaign_id: str,
        workshop_name: str,
        member_id: str,
        notes: Optional[str] = None,
    ) -> dict:
        """
        Mark a workshop as complete and handle handoff.

        Args:
            campaign_id: Campaign ID
            workshop_name: Completed workshop name
            member_id: Member who completed it
            notes: Notes to leave for next workshop

        Returns:
            Dict with next workshop info (if any)
        """
        # Dismiss the member
        self.spawner.dismiss(member_id, f"Completed workshop: {workshop_name}", "completed")

        # Get pattern to find next workshop
        campaign = self.ledger.read(campaign_id)
        pattern_name = getattr(campaign, 'pattern_book', None)

        if not pattern_name:
            return {"next": None}

        pattern = self.patterns.get(pattern_name)
        if not pattern:
            return {"next": None}

        # Find next workshop
        ordered = pattern.get_ordered_workshops()
        current_idx = next(
            (i for i, w in enumerate(ordered) if w.name == workshop_name),
            -1,
        )

        if current_idx < 0 or current_idx >= len(ordered) - 1:
            return {"next": None, "status": "campaign_complete"}

        next_workshop = ordered[current_idx + 1]
        return {
            "next": next_workshop.name,
            "craft": self._get_craft_for_workshop(next_workshop).value,
            "description": next_workshop.description,
        }
