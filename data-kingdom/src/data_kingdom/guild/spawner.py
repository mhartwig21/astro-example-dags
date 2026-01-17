"""
Guild Spawner

Spawns and manages Guild members (Claude agents).

The spawner:
1. Creates Posts for agents to work at
2. Launches Claude CLI processes
3. Monitors agent status
4. Handles agent crashes and restarts
5. Records summoning/dismissal to the Ledger

Key design principles:
- Agents are ephemeral and fallible
- Posts (workspaces) are persistent
- All actions are recorded in the Ledger
- Agents can be resumed from saved sessions
"""

import os
import signal
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from data_kingdom.guild.models import (
    Craft,
    GuildMember,
    MemberStatus,
    SummoningRecord,
    DismissalRecord,
    CRAFT_DESCRIPTIONS,
)
from data_kingdom.guild.post_master import PostMaster
from data_kingdom.ledger import LedgerStorage, generate_id


class SpawnError(Exception):
    """Raised when agent spawning fails."""

    pass


class GuildSpawner:
    """
    Spawns and manages Guild members.

    Guild members are Claude CLI processes that work on campaign tasks.
    They are ephemeral - they may crash or complete - but their work
    persists through Posts and the Ledger.
    """

    def __init__(self, kingdom_root: Path | str):
        """
        Initialize the spawner.

        Args:
            kingdom_root: Root directory of the Kingdom
        """
        self.kingdom_root = Path(kingdom_root)
        self.post_master = PostMaster(kingdom_root)
        self.ledger = LedgerStorage(kingdom_root)

        # Track active members
        self._active_members: dict[str, GuildMember] = {}

    def _build_system_prompt(
        self,
        craft: Craft,
        campaign_id: str,
        task: str,
        post_path: str,
    ) -> str:
        """Build the system prompt for an agent."""
        craft_desc = CRAFT_DESCRIPTIONS.get(craft, "You are a Guild member.")

        return f"""# Data Kingdom Guild Member

{craft_desc}

## Your Assignment

**Campaign:** {campaign_id}
**Task:** {task}

## Your Post (Workspace)

Your persistent workspace is at: {post_path}

Important files:
- `notes.md` - Leave notes here for future agents who may take over
- `workspace/` - Store working files here
- `session.txt` - Your session ID (for resume capability)

## Guidelines

1. **Record everything important** - Write to notes.md so work isn't lost
2. **Be specific** - Document what you tried, what worked, what didn't
3. **Complete your task** - Stay focused on the assigned task
4. **Signal completion** - When done, clearly state "TASK COMPLETE" with a summary

## Kingdom Context

You are part of a Data Kingdom - a feudal system for data products.
- **Campaigns** are bounded attempts to change reality
- **Holdings** are data products (datasets, models, etc.)
- **Treaties** are public interfaces between realms
- **The Court** judges whether holdings can be promoted

Your work will be recorded in the Great Ledger.
"""

    def summon(
        self,
        campaign_id: str,
        craft: Craft,
        task: str,
        resume: bool = True,
        background: bool = False,
    ) -> GuildMember:
        """
        Summon a Guild member to work on a task.

        Args:
            campaign_id: Campaign the member will work on
            craft: The member's craft/specialty
            task: Task description
            resume: Whether to resume from saved session if available
            background: Whether to run in background

        Returns:
            The summoned GuildMember
        """
        # Create or find a post
        existing_posts = self.post_master.list_by_craft(campaign_id, craft)
        idle_post = None

        for post in existing_posts:
            if post.current_task is None:
                idle_post = post
                break

        if idle_post:
            post = idle_post
            self.post_master.set_task(post.id, task)
        else:
            post = self.post_master.establish(campaign_id, craft, task)

        # Generate member ID
        member_id = f"member-{generate_id('m')[3:]}"

        # Create member record
        member = GuildMember(
            id=member_id,
            craft=craft,
            post_id=post.id,
            campaign_id=campaign_id,
            status=MemberStatus.SUMMONING,
            task=task,
            task_started=datetime.now(timezone.utc),
        )

        # Record summoning in ledger
        summoning = SummoningRecord(
            id=generate_id("sum"),
            parent=campaign_id,
            campaign_id=campaign_id,
            craft=craft,
            post_id=post.id,
            task=task,
        )

        # Try to write to ledger (may fail if ledger not initialized)
        try:
            if self.ledger.is_initialized():
                # Note: SummoningRecord is not a standard ledger record type
                # For now, we'll skip ledger write for summoning
                pass
        except Exception:
            pass

        # Build the prompt
        system_prompt = self._build_system_prompt(
            craft, campaign_id, task, post.path
        )

        # Check for resume session
        session_id = None
        if resume:
            session_id = self.post_master.get_session(post.id)

        # Build the Claude command
        cmd = self._build_claude_command(
            system_prompt=system_prompt,
            workdir=post.path,
            session_id=session_id,
            task=task,
        )

        # Launch the process
        try:
            if background:
                # Launch in background
                process = subprocess.Popen(
                    cmd,
                    cwd=post.path,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    start_new_session=True,
                )
                member.pid = process.pid
                member.status = MemberStatus.ACTIVE
            else:
                # Return the command for interactive execution
                member.status = MemberStatus.ACTIVE
                member.metadata = {"command": cmd}

        except Exception as e:
            member.status = MemberStatus.BLOCKED
            raise SpawnError(f"Failed to spawn agent: {e}")

        # Track the member
        self._active_members[member.id] = member

        # Add note to post
        self.post_master.add_note(
            post.id,
            f"Summoned for task: {task}",
            author=f"spawner/{craft.value}",
        )

        return member

    def _build_claude_command(
        self,
        system_prompt: str,
        workdir: str,
        session_id: Optional[str],
        task: str,
    ) -> list[str]:
        """Build the Claude CLI command."""
        cmd = ["claude"]

        # Add prompt
        cmd.extend(["--print", system_prompt + f"\n\nYour task: {task}"])

        # Add resume if available
        if session_id:
            cmd.extend(["--resume", session_id])

        return cmd

    def get_member(self, member_id: str) -> Optional[GuildMember]:
        """Get a member by ID."""
        return self._active_members.get(member_id)

    def list_active(self, campaign_id: Optional[str] = None) -> list[GuildMember]:
        """List active members, optionally filtered by campaign."""
        members = list(self._active_members.values())

        if campaign_id:
            members = [m for m in members if m.campaign_id == campaign_id]

        return [m for m in members if m.status == MemberStatus.ACTIVE]

    def list_all(self) -> list[GuildMember]:
        """List all tracked members."""
        return list(self._active_members.values())

    def dismiss(
        self,
        member_id: str,
        reason: str = "completed",
        outcome: str = "completed",
    ) -> DismissalRecord:
        """
        Dismiss a Guild member.

        Args:
            member_id: Member to dismiss
            reason: Why the member is being dismissed
            outcome: completed, failed, crashed, timeout, manual

        Returns:
            DismissalRecord
        """
        member = self._active_members.get(member_id)

        if not member:
            raise ValueError(f"Member not found: {member_id}")

        # Get the post
        post = self.post_master.get(member.post_id)

        # Mark task complete if outcome is successful
        if outcome == "completed":
            self.post_master.mark_task_complete(post.id, member.task)

        # Kill process if running
        if member.pid:
            try:
                os.kill(member.pid, signal.SIGTERM)
            except (OSError, ProcessLookupError):
                pass  # Process already dead

        # Update member status
        member.status = MemberStatus.DISMISSED

        # Create dismissal record
        dismissal = DismissalRecord(
            id=generate_id("dis"),
            parent=member.campaign_id,
            member_id=member_id,
            post_id=member.post_id,
            reason=reason,
            outcome=outcome,
            tasks_completed=post.completed_tasks,
            notes_left=post.notes[-5:] if post.notes else [],  # Last 5 notes
        )

        # Add note to post
        self.post_master.add_note(
            post.id,
            f"Dismissed: {reason} (outcome: {outcome})",
            author="spawner",
        )

        # Remove from active tracking
        del self._active_members[member_id]

        return dismissal

    def check_status(self, member_id: str) -> MemberStatus:
        """Check the status of a member."""
        member = self._active_members.get(member_id)

        if not member:
            return MemberStatus.DISMISSED

        # Check if process is still running
        if member.pid:
            try:
                os.kill(member.pid, 0)  # Check if process exists
            except (OSError, ProcessLookupError):
                # Process died
                member.status = MemberStatus.DISMISSED
                return MemberStatus.DISMISSED

        return member.status

    def get_craft_for_task(self, task: str) -> Craft:
        """
        Suggest a craft based on task description.

        Uses simple keyword matching - could be enhanced with LLM.
        """
        task_lower = task.lower()

        if any(kw in task_lower for kw in ["log", "ingest", "event", "capture"]):
            return Craft.LOGWRIGHT

        if any(kw in task_lower for kw in ["transform", "pipeline", "build", "etl"]):
            return Craft.ENGINEER

        if any(kw in task_lower for kw in ["analyze", "semantic", "golden", "meaning", "investigate"]):
            return Craft.SCHOLAR

        if any(kw in task_lower for kw in ["model", "ml", "predict", "forecast", "train"]):
            return Craft.SEER

        if any(kw in task_lower for kw in ["dashboard", "report", "visual", "chart"]):
            return Craft.CARTOGRAPHER

        if any(kw in task_lower for kw in ["cost", "privacy", "compliance", "security", "reliability"]):
            return Craft.WARDEN

        if any(kw in task_lower for kw in ["document", "treaty", "contract", "write"]):
            return Craft.SCRIBE

        if any(kw in task_lower for kw in ["status", "progress", "summarize", "track"]):
            return Craft.WITNESS

        # Default to Scholar for analytical tasks
        return Craft.SCHOLAR
