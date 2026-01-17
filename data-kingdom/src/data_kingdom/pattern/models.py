"""
Pattern Book Models

A Pattern Book is a blessed template for how work should be done.
It encodes institutional knowledge about:
- What steps are required
- What trials must pass
- How promotion works
- What to do when things fail

Pattern Books are the difference between tribal knowledge
and institutional memory.
"""

from enum import Enum
from typing import Any, Optional

from pydantic import BaseModel, Field


class WorkshopType(str, Enum):
    """Types of workshops that can be invoked."""

    BUILD = "build"
    VALIDATE = "validate"
    TRANSFORM = "transform"
    TEST = "test"
    DEPLOY = "deploy"
    CUSTOM = "custom"


class Workshop(BaseModel):
    """
    A Workshop is a step in a Pattern Book.

    Workshops are executed in order to produce holdings.
    Each workshop has a type and configuration.
    """

    name: str = Field(..., description="Unique name for this workshop step")
    type: WorkshopType = Field(..., description="Type of workshop")
    description: Optional[str] = Field(default=None, description="What this workshop does")

    # Execution configuration
    command: Optional[str] = Field(
        default=None, description="Command to run (for custom workshops)"
    )
    config: dict[str, Any] = Field(
        default_factory=dict, description="Workshop-specific configuration"
    )

    # Dependencies
    depends_on: list[str] = Field(
        default_factory=list, description="Workshop names this depends on"
    )

    # Trial requirements
    trials_after: list[str] = Field(
        default_factory=list,
        description="Trials to run after this workshop completes",
    )

    # Failure behavior
    continue_on_failure: bool = Field(
        default=False, description="Continue to next workshop if this fails"
    )
    retry_count: int = Field(default=0, description="Number of retries on failure")


class RollbackTrigger(str, Enum):
    """Events that can trigger a rollback."""

    TRIAL_FAILURE = "trial_failure"
    TRIAL_FAILURE_IN_PRODUCTION = "trial_failure_in_production"
    CHRONICLE_DECLARED = "chronicle_declared"
    MANUAL = "manual"
    COST_OVERRUN = "cost_overrun"
    FRESHNESS_VIOLATION = "freshness_violation"


class RollbackStrategy(str, Enum):
    """Strategies for rolling back."""

    RESTORE_PREVIOUS = "restore_previous"
    REVERT_TO_VERSION = "revert_to_version"
    DISABLE = "disable"
    MANUAL_INTERVENTION = "manual_intervention"


class RollbackConfig(BaseModel):
    """Configuration for rollback behavior."""

    triggers: list[RollbackTrigger] = Field(
        default_factory=lambda: [RollbackTrigger.TRIAL_FAILURE_IN_PRODUCTION],
        description="Events that trigger automatic rollback",
    )
    strategy: RollbackStrategy = Field(
        default=RollbackStrategy.RESTORE_PREVIOUS,
        description="How to perform rollback",
    )
    notify: list[str] = Field(
        default_factory=list, description="Who to notify on rollback"
    )
    require_approval: bool = Field(
        default=False, description="Require human approval before rollback"
    )


class PromotionPath(BaseModel):
    """
    Defines the path a holding takes through stations.

    Each station may have specific requirements before
    promotion can occur.
    """

    stations: list[str] = Field(
        default_factory=lambda: ["development", "staging", "canary", "production"],
        description="Ordered list of stations",
    )

    # Per-station requirements
    staging_requires: list[str] = Field(
        default_factory=list, description="Trials required for staging promotion"
    )
    canary_requires: list[str] = Field(
        default_factory=list, description="Trials required for canary promotion"
    )
    production_requires: list[str] = Field(
        default_factory=list, description="Trials required for production promotion"
    )

    # Canary configuration
    canary_duration: Optional[str] = Field(
        default="24h", description="How long to run in canary"
    )
    canary_percentage: Optional[int] = Field(
        default=5, description="Percentage of traffic in canary"
    )


class PatternBook(BaseModel):
    """
    A Pattern Book is a blessed template for producing holdings.

    It defines the complete lifecycle:
    1. What workshops to run
    2. What trials must pass
    3. How promotion works
    4. What to do on failure

    Pattern Books are how the Kingdom encodes institutional knowledge.
    """

    # Identity
    name: str = Field(..., description="Unique pattern name (e.g., 'public-holding')")
    version: str = Field(default="1.0.0", description="Pattern version")
    description: str = Field(..., description="What this pattern is for")

    # What it produces
    holding_type: str = Field(
        default="dataset", description="Type of holding this produces"
    )

    # Required inputs
    required_inputs: list[str] = Field(
        default_factory=list,
        description="Inputs that must be provided when using this pattern",
    )
    optional_inputs: list[str] = Field(
        default_factory=list, description="Optional inputs with defaults"
    )

    # Workshops (execution steps)
    workshops: list[Workshop] = Field(
        default_factory=list, description="Workshops to execute in order"
    )

    # Trials
    mandatory_trials: list[str] = Field(
        default_factory=lambda: [
            "schema_integrity",
            "null_rate",
            "row_count_bounds",
            "golden_questions",
            "freshness",
        ],
        description="Trials that must pass before any promotion",
    )
    optional_trials: list[str] = Field(
        default_factory=list, description="Trials that are recommended but not required"
    )

    # Promotion path
    promotion: PromotionPath = Field(
        default_factory=PromotionPath, description="How holdings are promoted"
    )

    # Rollback behavior
    rollback: RollbackConfig = Field(
        default_factory=RollbackConfig, description="What to do when things fail"
    )

    # Governance
    requires_treaty: bool = Field(
        default=True, description="Whether a treaty definition is required"
    )
    requires_golden_questions: bool = Field(
        default=True, description="Whether golden questions are required"
    )
    allowed_realms: list[str] = Field(
        default_factory=list,
        description="Realms allowed to use this pattern (empty = all)",
    )

    # Metadata
    tags: list[str] = Field(default_factory=list, description="Tags for categorization")
    owner: Optional[str] = Field(default=None, description="Who owns this pattern")

    def get_workshop(self, name: str) -> Optional[Workshop]:
        """Get a workshop by name."""
        for workshop in self.workshops:
            if workshop.name == name:
                return workshop
        return None

    def get_ordered_workshops(self) -> list[Workshop]:
        """Get workshops in dependency order."""
        # Simple topological sort
        ordered = []
        remaining = list(self.workshops)
        completed = set()

        while remaining:
            for workshop in remaining[:]:
                deps_met = all(dep in completed for dep in workshop.depends_on)
                if deps_met:
                    ordered.append(workshop)
                    completed.add(workshop.name)
                    remaining.remove(workshop)
                    break
            else:
                # Circular dependency or missing dependency
                raise ValueError(
                    f"Cannot resolve workshop dependencies. Remaining: {[w.name for w in remaining]}"
                )

        return ordered

    def get_trials_for_station(self, station: str) -> list[str]:
        """Get trials required before promoting to a station."""
        base_trials = self.mandatory_trials.copy()

        if station == "staging":
            base_trials.extend(self.promotion.staging_requires)
        elif station == "canary":
            base_trials.extend(self.promotion.canary_requires)
        elif station == "production":
            base_trials.extend(self.promotion.production_requires)

        return list(set(base_trials))  # Deduplicate
