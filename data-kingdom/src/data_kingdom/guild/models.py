"""
Guild Models

Guilds are collections of specialized workers (Claude agents).
Each Guild member has a Craft (specialty) and works at a Post
(persistent workspace) on Campaign tasks.

Key concepts:
- Craft: The specialty of a guild member
- Post: Persistent workspace that survives agent crashes
- GuildMember: An active agent working on a task
- SummoningRecord: Ledger record of agent creation
- DismissalRecord: Ledger record of agent completion/termination
"""

from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


class Craft(str, Enum):
    """
    Crafts are the specializations of Guild members.

    Each craft has specific skills and is suited for
    different types of work.
    """

    LOGWRIGHT = "logwright"      # Logging, ingestion, event capture
    ENGINEER = "engineer"        # Transforms, infrastructure, pipelines
    SCHOLAR = "scholar"          # Analysis, semantics, golden questions
    SEER = "seer"                # ML models, forecasting, predictions
    CARTOGRAPHER = "cartographer"  # Dashboards, reports, visualizations
    WARDEN = "warden"            # Reliability, cost, privacy, compliance
    WITNESS = "witness"          # Progress tracking, summarization
    SCRIBE = "scribe"            # Documentation, contracts, treaties


# Craft descriptions for prompting
CRAFT_DESCRIPTIONS = {
    Craft.LOGWRIGHT: (
        "You are a Logwright - specialist in logging, ingestion, and event capture. "
        "You design and implement data collection systems, ensure data quality at "
        "the source, and manage event schemas."
    ),
    Craft.ENGINEER: (
        "You are an Engineer - specialist in data transforms and infrastructure. "
        "You build pipelines, optimize performance, manage data infrastructure, "
        "and ensure reliable data delivery."
    ),
    Craft.SCHOLAR: (
        "You are a Scholar - specialist in analysis and semantics. "
        "You investigate data quality issues, define semantic meanings, "
        "create golden questions, and validate that data means what we say it means."
    ),
    Craft.SEER: (
        "You are a Seer - specialist in ML and forecasting. "
        "You build predictive models, design features, evaluate model performance, "
        "and ensure ML systems are reliable and fair."
    ),
    Craft.CARTOGRAPHER: (
        "You are a Cartographer - specialist in visualization and reporting. "
        "You create dashboards, design reports, build BI solutions, "
        "and make data accessible to stakeholders."
    ),
    Craft.WARDEN: (
        "You are a Warden - specialist in reliability, cost, and compliance. "
        "You monitor system health, enforce policies, manage costs, "
        "and ensure privacy and security requirements are met."
    ),
    Craft.WITNESS: (
        "You are a Witness - specialist in tracking and summarization. "
        "You monitor campaign progress, summarize status for humans, "
        "and ensure visibility into ongoing work."
    ),
    Craft.SCRIBE: (
        "You are a Scribe - specialist in documentation and contracts. "
        "You write documentation, define treaties, create semantic contracts, "
        "and maintain institutional knowledge."
    ),
}


class MemberStatus(str, Enum):
    """Status of a guild member."""

    SUMMONING = "summoning"   # Being created
    ACTIVE = "active"         # Working on task
    IDLE = "idle"             # Waiting for work
    BLOCKED = "blocked"       # Waiting on dependency
    DISMISSED = "dismissed"   # Completed or terminated


class Post(BaseModel):
    """
    A Post is a persistent workspace for a Guild member.

    Posts survive agent crashes - when a new agent is summoned,
    it can resume from the Post's state. This is the key to
    reliable multi-agent work.

    Posts are stored in the .posts/ directory.
    """

    id: str = Field(..., description="Unique post ID")
    campaign_id: str = Field(..., description="Campaign this post belongs to")
    craft: Craft = Field(..., description="Craft of the member at this post")

    # Workspace
    path: str = Field(..., description="Filesystem path to post directory")
    session_id: Optional[str] = Field(
        default=None, description="Claude session ID for resume"
    )

    # State
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )
    last_active: Optional[datetime] = Field(default=None)

    # Task tracking
    current_task: Optional[str] = Field(default=None)
    completed_tasks: list[str] = Field(default_factory=list)

    # Notes (persistent memory across agent restarts)
    notes: list[str] = Field(
        default_factory=list,
        description="Notes left by agents for future agents",
    )


class GuildMember(BaseModel):
    """
    A GuildMember is an active agent working on a Campaign.

    Members are ephemeral - they may crash, timeout, or complete.
    Their work persists via the Ledger and their Post.
    """

    id: str = Field(..., description="Unique member ID")
    craft: Craft = Field(..., description="Member's craft/specialty")
    post_id: str = Field(..., description="ID of the Post this member occupies")
    campaign_id: str = Field(..., description="Campaign this member is working on")

    # Process info
    pid: Optional[int] = Field(default=None, description="Process ID if running")
    status: MemberStatus = Field(default=MemberStatus.SUMMONING)

    # Task
    task: str = Field(..., description="Current task description")
    task_started: Optional[datetime] = Field(default=None)

    # Metadata
    summoned_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )
    summoned_by: str = Field(default="system")
    metadata: dict[str, Any] = Field(default_factory=dict)


class SummoningRecord(BaseModel):
    """
    Ledger record of a Guild member being summoned.

    This is written to the Great Ledger when an agent is created,
    providing an audit trail of all agent activity.
    """

    id: str = Field(..., description="Record ID")
    record_type: Literal["summoning"] = "summoning"
    parent: Optional[str] = Field(default=None, description="Campaign ID")

    campaign_id: str = Field(..., description="Campaign the member is working on")
    craft: Craft = Field(..., description="Member's craft")
    post_id: str = Field(..., description="Post ID")
    task: str = Field(..., description="Task assigned")

    summoned_by: str = Field(default="system")
    summoned_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )

    metadata: dict[str, Any] = Field(default_factory=dict)


class DismissalRecord(BaseModel):
    """
    Ledger record of a Guild member being dismissed.

    Written when an agent completes, crashes, or is terminated.
    """

    id: str = Field(..., description="Record ID")
    record_type: Literal["dismissal"] = "dismissal"
    parent: Optional[str] = Field(default=None, description="Campaign ID")

    member_id: str = Field(..., description="ID of dismissed member")
    post_id: str = Field(..., description="Post ID")

    reason: str = Field(..., description="Why the member was dismissed")
    outcome: str = Field(
        default="unknown",
        description="completed, failed, crashed, timeout, manual",
    )

    # Results
    tasks_completed: list[str] = Field(default_factory=list)
    notes_left: list[str] = Field(default_factory=list)

    dismissed_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc)
    )

    metadata: dict[str, Any] = Field(default_factory=dict)
