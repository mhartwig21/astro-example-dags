"""
Ledger Records

These are the canonical record types that make up the Great Ledger.
A human can reconstruct the entire kingdom's history by reading these records.

MVP Record Types:
1. PetitionRecord - "We want this to exist"
2. CampaignRecord - "We are attempting to make it so"
3. HoldingRecord - "This thing now exists"
4. TrialRecord - "The Court examined it"
5. CoronationRecord - "It is now law"
"""

from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal, Optional

from pydantic import BaseModel, Field


class RecordStatus(str, Enum):
    """Status of any ledger record."""

    ACTIVE = "active"
    COMPLETED = "completed"
    ABANDONED = "abandoned"
    SUPERSEDED = "superseded"


class CampaignStatus(str, Enum):
    """Specific status for campaigns."""

    ACTIVE = "active"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    ABANDONED = "abandoned"
    BLOCKED = "blocked"


class TrialVerdict(str, Enum):
    """Verdict from the Court."""

    APPROVED = "approved"
    APPROVED_WITH_CONDITIONS = "approved_with_conditions"
    REJECTED = "rejected"
    PENDING = "pending"


class Station(str, Enum):
    """Promotion stations (environments)."""

    DEVELOPMENT = "development"
    STAGING = "staging"
    CANARY = "canary"
    PRODUCTION = "production"


class LedgerRecord(BaseModel):
    """
    Base class for all ledger records.

    Every record has:
    - A unique ID
    - A type identifier
    - Creation timestamp
    - Optional parent reference (for hierarchy)
    """

    id: str = Field(..., description="Unique record ID (e.g., dk-a1b2)")
    record_type: str = Field(..., description="Type discriminator")
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        description="When this record was created",
    )
    parent: Optional[str] = Field(
        default=None, description="Parent record ID for hierarchy"
    )
    metadata: dict[str, Any] = Field(
        default_factory=dict, description="Arbitrary metadata"
    )

    class Config:
        use_enum_values = True


class PetitionRecord(LedgerRecord):
    """
    A Petition declares intent.

    "We want this to exist."

    Petitions are the origin of all work. They come from humans
    and express a desire for some outcome. Campaigns are launched
    to fulfill petitions.
    """

    record_type: Literal["petition"] = "petition"
    petitioner: str = Field(..., description="Who filed this petition")
    request: str = Field(..., description="What is being requested")
    realm: str = Field(..., description="Which realm this petition targets")
    justification: Optional[str] = Field(
        default=None, description="Why this is needed"
    )
    priority: Optional[str] = Field(
        default="normal", description="Priority level"
    )
    status: RecordStatus = Field(default=RecordStatus.ACTIVE)


class CampaignScope(BaseModel):
    """Defines the boundaries of a campaign."""

    realms_affected: list[str] = Field(
        default_factory=list, description="Which realms this campaign touches"
    )
    treaties_affected: list[str] = Field(
        default_factory=list, description="Which treaties are created/modified"
    )
    holdings_affected: list[str] = Field(
        default_factory=list, description="Which holdings are touched"
    )


class CampaignRecord(LedgerRecord):
    """
    A Campaign is a bounded attempt to change reality.

    "We are attempting to make it so."

    Campaigns pursue goals, have scope and limits, may succeed partially,
    and always leave records. They replace "projects," "pipelines," and "releases."
    """

    record_type: Literal["campaign"] = "campaign"
    objective: str = Field(..., description="What this campaign aims to achieve")
    status: CampaignStatus = Field(default=CampaignStatus.ACTIVE)
    scope: CampaignScope = Field(
        default_factory=CampaignScope, description="Boundaries of this campaign"
    )
    blast_radius: str = Field(
        default="unknown", description="Human-readable impact description"
    )
    retreat_plan: Optional[str] = Field(
        default=None, description="What to do if this fails"
    )
    pattern_book: Optional[str] = Field(
        default=None, description="Which pattern book this follows"
    )
    workshops_completed: list[str] = Field(
        default_factory=list, description="Workshops that have finished"
    )
    workshops_pending: list[str] = Field(
        default_factory=list, description="Workshops still to run"
    )


class HoldingRecord(LedgerRecord):
    """
    A Holding is a produced asset.

    "This thing now exists."

    Holdings are the outputs of campaigns - datasets, models, dashboards,
    contracts. They are versioned and may be promoted through stations.
    """

    record_type: Literal["holding"] = "holding"
    holding_type: str = Field(
        ..., description="Type: dataset, model, dashboard, contract, etc."
    )
    name: str = Field(..., description="Name of the holding")
    version: str = Field(..., description="Version identifier")
    location: Optional[str] = Field(
        default=None, description="Where this holding lives (URI)"
    )
    treaty: Optional[str] = Field(
        default=None, description="Path to treaty definition if public"
    )
    constructed_by: Optional[str] = Field(
        default=None, description="Which workshop produced this"
    )
    current_station: Station = Field(
        default=Station.DEVELOPMENT, description="Current promotion station"
    )
    schema_hash: Optional[str] = Field(
        default=None, description="Hash of the schema for drift detection"
    )


class TrialEvidence(BaseModel):
    """Evidence from a single trial."""

    name: str = Field(..., description="Name of the trial")
    passed: bool = Field(..., description="Whether it passed")
    details: dict[str, Any] = Field(
        default_factory=dict, description="Trial-specific details"
    )
    error: Optional[str] = Field(
        default=None, description="Error message if failed"
    )


class TrialRecord(LedgerRecord):
    """
    A Trial is an examination by the Court.

    "The Court examined it."

    Trials evaluate holdings against the standards required by their
    pattern book. The Court's verdict determines whether a holding
    may be promoted.
    """

    record_type: Literal["trial"] = "trial"
    holding: str = Field(..., description="ID of the holding being tried")
    trials_run: list[TrialEvidence] = Field(
        default_factory=list, description="Individual trial results"
    )
    verdict: TrialVerdict = Field(
        default=TrialVerdict.PENDING, description="Overall verdict"
    )
    rejection_reasons: list[str] = Field(
        default_factory=list, description="Why it was rejected, if applicable"
    )
    conditions: list[str] = Field(
        default_factory=list, description="Conditions if approved with conditions"
    )


class CoronationRecord(LedgerRecord):
    """
    A Coronation marks promotion to a new station.

    "It is now law."

    When a holding passes judgment, it is crowned - promoted from
    one station to another. Coronations are ceremonial, reversible,
    and recorded.
    """

    record_type: Literal["coronation"] = "coronation"
    holding: str = Field(..., description="ID of the holding being crowned")
    from_station: Station = Field(..., description="Previous station")
    to_station: Station = Field(..., description="New station")
    verdict: str = Field(..., description="ID of the trial that approved this")
    crowned_by: str = Field(
        default="court", description="Who performed the coronation"
    )
    witnesses: list[str] = Field(
        default_factory=list, description="Who witnessed this coronation"
    )


# Type alias for any record type
AnyRecord = PetitionRecord | CampaignRecord | HoldingRecord | TrialRecord | CoronationRecord


def record_from_dict(data: dict) -> AnyRecord:
    """Deserialize a record from a dictionary based on record_type."""
    record_type = data.get("record_type")

    type_map = {
        "petition": PetitionRecord,
        "campaign": CampaignRecord,
        "holding": HoldingRecord,
        "trial": TrialRecord,
        "coronation": CoronationRecord,
    }

    if record_type not in type_map:
        raise ValueError(f"Unknown record type: {record_type}")

    return type_map[record_type](**data)
