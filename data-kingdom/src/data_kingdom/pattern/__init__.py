"""
Pattern Books

The Kingdom maintains Pattern Books - blessed construction patterns
that encode institutional memory.

Examples:
- "How to establish a public fact table"
- "How to issue a forecasting treaty"
- "How to perform a historical backfill"
- "How to respond to drift"

Pattern Books define:
- Required steps (workshops)
- Mandatory trials
- Acceptable risk
- Promotion path
- Rollback behavior

This is how the Kingdom learns.
"""

from data_kingdom.pattern.models import (
    PatternBook,
    Workshop,
    PromotionPath,
    RollbackConfig,
)
from data_kingdom.pattern.registry import PatternRegistry
from data_kingdom.pattern.loader import load_pattern_book, load_all_patterns

__all__ = [
    "PatternBook",
    "Workshop",
    "PromotionPath",
    "RollbackConfig",
    "PatternRegistry",
    "load_pattern_book",
    "load_all_patterns",
]
