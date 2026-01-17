"""
The Court

Progress is permitted. Promotion is earned.

The Court evaluates all work before it becomes law. It judges:
- Correctness (integrity, reconciliation)
- Meaning (semantics, golden questions)
- Safety (privacy, purpose)
- Performance (cost, freshness)
- Stability (rerun variance)

The Court does not debate. It rules.
"""

from data_kingdom.court.trials import (
    Trial,
    TrialResult,
    SchemaIntegrityTrial,
    NullRateTrial,
    RowCountBoundsTrial,
    GoldenQuestionsTrial,
    FreshnessTrial,
)
from data_kingdom.court.judge import Court

__all__ = [
    "Court",
    "Trial",
    "TrialResult",
    "SchemaIntegrityTrial",
    "NullRateTrial",
    "RowCountBoundsTrial",
    "GoldenQuestionsTrial",
    "FreshnessTrial",
]
