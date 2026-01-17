"""
Realm and Treaty Models

Realms are feudal territories - major domains like Analytics, Ads, Integrity.
Each Realm is sovereign internally but subject to Crown law.

Treaties are the only legal way data crosses borders.
A Treaty defines what is shared, what it means, how reliable it is,
and how it evolves.

No treaty, no dependency.
"""

from datetime import datetime
from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, Field


class RealmStatus(str, Enum):
    """Status of a realm."""

    ACTIVE = "active"
    DEPRECATED = "deprecated"
    ARCHIVED = "archived"


class Fief(BaseModel):
    """
    A Fief is a sub-territory within a Realm.

    Fiefs are smaller territories aligned to teams or products.
    They may share internal roads with sibling fiefs but
    may NOT expose internals outside the Realm.
    """

    name: str = Field(..., description="Fief name (e.g., 'metrics', 'experiments')")
    description: Optional[str] = Field(default=None, description="What this fief manages")
    owner: Optional[str] = Field(default=None, description="Team or person who owns this fief")

    # Access control
    can_access_siblings: bool = Field(
        default=True,
        description="Whether this fief can access sibling fiefs' internal data",
    )


class Realm(BaseModel):
    """
    A Realm is a feudal territory.

    Each Realm:
    - owns its internal lands (private data)
    - governs its vassals (sub-domains/fiefs)
    - issues treaties (public interfaces)
    - is subject to Crown law (kingdom standards)
    """

    name: str = Field(..., description="Realm name (e.g., 'analytics', 'ads')")
    description: Optional[str] = Field(default=None, description="What this realm governs")
    status: RealmStatus = Field(default=RealmStatus.ACTIVE)

    # Governance
    ruler: str = Field(..., description="Team or person who rules this realm")
    stewards: list[str] = Field(
        default_factory=list,
        description="Additional people with governance authority",
    )

    # Structure
    fiefs: list[Fief] = Field(
        default_factory=list,
        description="Sub-territories within this realm",
    )

    # Laws (realm-specific standards beyond Crown law)
    laws: list[str] = Field(
        default_factory=list,
        description="Realm-specific standards and requirements",
    )

    # Dependencies on other realms (via treaties)
    dependencies: list[dict[str, str]] = Field(
        default_factory=list,
        description="Treaties this realm depends on from other realms",
    )

    # Metadata
    created_at: Optional[datetime] = Field(default=None)
    tags: list[str] = Field(default_factory=list)

    def has_fief(self, fief_name: str) -> bool:
        """Check if a fief exists in this realm."""
        return any(f.name == fief_name for f in self.fiefs)

    def get_fief(self, fief_name: str) -> Optional[Fief]:
        """Get a fief by name."""
        for fief in self.fiefs:
            if fief.name == fief_name:
                return fief
        return None


class SchemaColumn(BaseModel):
    """A column in a treaty's schema definition."""

    name: str = Field(..., description="Column name")
    type: str = Field(..., description="Data type (string, int, date, etc.)")
    description: Optional[str] = Field(default=None, description="What this column means")
    nullable: bool = Field(default=True, description="Whether nulls are allowed")
    enum: Optional[list[str]] = Field(default=None, description="Allowed values if enumerated")
    example: Optional[Any] = Field(default=None, description="Example value")


class GoldenQuestion(BaseModel):
    """A semantic test question for a treaty."""

    question: str = Field(..., description="The question to answer")
    expected: Any = Field(..., description="Expected answer")
    tolerance: float = Field(default=0.01, description="Acceptable variance (for numeric)")
    query: Optional[str] = Field(default=None, description="SQL or reference to compute answer")


class Guarantees(BaseModel):
    """SLOs and guarantees for a treaty."""

    freshness: str = Field(default="24h", description="Maximum data age")
    availability: str = Field(default="99.9%", description="Uptime guarantee")
    backfill_policy: Optional[str] = Field(
        default=None,
        description="Policy for historical backfills",
    )


class TreatyGrant(BaseModel):
    """Defines who can depend on a treaty."""

    realm: str = Field(..., description="Realm granted access")
    fief: Optional[str] = Field(default=None, description="Specific fief, if limited")
    granted_at: Optional[datetime] = Field(default=None)
    granted_by: Optional[str] = Field(default=None)


class DeprecatedVersion(BaseModel):
    """A deprecated version of a treaty."""

    version: str = Field(..., description="Version being deprecated")
    sunset_date: str = Field(..., description="When this version will be removed")
    migration_guide: Optional[str] = Field(
        default=None,
        description="Path to migration documentation",
    )


class Treaty(BaseModel):
    """
    A Treaty is the only legal way data crosses borders.

    It defines:
    - what is shared
    - what it means (semantics)
    - how reliable it is (SLOs)
    - how dangerous it is (blast radius)
    - how it evolves (versioning, deprecation)

    No treaty, no dependency.
    """

    # Identity
    name: str = Field(..., description="Treaty name (e.g., 'dau_daily')")
    version: str = Field(..., description="Semantic version")
    realm: str = Field(..., description="Realm that owns this treaty")
    fief: Optional[str] = Field(default=None, description="Fief within the realm")

    description: Optional[str] = Field(default=None, description="What this treaty provides")

    # Access control
    granted_to: list[TreatyGrant] = Field(
        default_factory=list,
        description="Who is allowed to depend on this treaty",
    )
    public: bool = Field(
        default=False,
        description="If true, any realm can depend on this treaty",
    )

    # Schema definition
    schema_columns: list[SchemaColumn] = Field(
        default_factory=list,
        description="The schema of data provided",
    )

    # Semantic definition (the most important part)
    definition: str = Field(
        ...,
        description="Plain-language definition of what this data means",
    )

    # Semantic tests
    golden_questions: list[GoldenQuestion] = Field(
        default_factory=list,
        description="Questions that verify the data means what we say",
    )

    # Guarantees
    guarantees: Guarantees = Field(
        default_factory=Guarantees,
        description="SLOs and reliability guarantees",
    )

    # Versioning
    breaking_change_policy: str = Field(
        default="Require new major version and 30-day deprecation",
        description="How breaking changes are handled",
    )
    deprecated_versions: list[DeprecatedVersion] = Field(
        default_factory=list,
        description="Previous versions still honored",
    )

    # Metadata
    owner: Optional[str] = Field(default=None, description="Team or person responsible")
    created_at: Optional[datetime] = Field(default=None)
    tags: list[str] = Field(default_factory=list)

    def is_granted_to(self, realm: str, fief: Optional[str] = None) -> bool:
        """Check if a realm (and optionally fief) has access to this treaty."""
        if self.public:
            return True

        for grant in self.granted_to:
            if grant.realm == realm:
                if fief is None or grant.fief is None or grant.fief == fief:
                    return True

        return False

    def get_schema_as_dict(self) -> dict[str, dict]:
        """Get schema as a dictionary for validation."""
        return {
            col.name: {
                "type": col.type,
                "nullable": col.nullable,
                "enum": col.enum,
            }
            for col in self.schema_columns
        }
