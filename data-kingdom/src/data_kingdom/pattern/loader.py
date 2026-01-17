"""
Pattern Book Loader

Loads Pattern Books from YAML files.

Pattern Books are stored in the `pattern-books/` directory
of a Data Kingdom, with one file per pattern.

Example file: pattern-books/public-holding.yaml
"""

import os
from pathlib import Path
from typing import Optional

import yaml

from data_kingdom.pattern.models import PatternBook, Workshop, PromotionPath, RollbackConfig


class PatternLoadError(Exception):
    """Raised when a pattern cannot be loaded."""

    pass


def load_pattern_book(path: Path | str) -> PatternBook:
    """
    Load a Pattern Book from a YAML file.

    Args:
        path: Path to the YAML file

    Returns:
        PatternBook instance

    Raises:
        PatternLoadError: If the file cannot be loaded or parsed
    """
    path = Path(path)

    if not path.exists():
        raise PatternLoadError(f"Pattern file not found: {path}")

    try:
        with open(path) as f:
            data = yaml.safe_load(f)
    except yaml.YAMLError as e:
        raise PatternLoadError(f"Invalid YAML in {path}: {e}")

    if not data:
        raise PatternLoadError(f"Empty pattern file: {path}")

    try:
        return PatternBook(**data)
    except Exception as e:
        raise PatternLoadError(f"Invalid pattern structure in {path}: {e}")


def load_all_patterns(directory: Path | str) -> dict[str, PatternBook]:
    """
    Load all Pattern Books from a directory.

    Args:
        directory: Path to the pattern-books directory

    Returns:
        Dict mapping pattern name to PatternBook
    """
    directory = Path(directory)
    patterns = {}

    if not directory.exists():
        return patterns

    for file_path in directory.glob("*.yaml"):
        try:
            pattern = load_pattern_book(file_path)
            patterns[pattern.name] = pattern
        except PatternLoadError:
            # Skip invalid patterns, but could log warning
            pass

    for file_path in directory.glob("*.yml"):
        try:
            pattern = load_pattern_book(file_path)
            patterns[pattern.name] = pattern
        except PatternLoadError:
            pass

    return patterns


# ============================================================================
# Built-in Pattern Books
# ============================================================================

# These are the standard patterns that come with the Data Kingdom.
# They can be overridden by placing a file with the same name in pattern-books/

PUBLIC_HOLDING_PATTERN = PatternBook(
    name="public-holding",
    version="1.0.0",
    description="Standard pattern for producing a public dataset with treaty",
    holding_type="dataset",
    required_inputs=["holding_name", "realm", "treaty"],
    optional_inputs=["source_query", "partition_key", "freshness_slo"],
    workshops=[
        Workshop(
            name="construct",
            type="build",
            description="Build the dataset from source",
            config={"output_format": "parquet"},
        ),
        Workshop(
            name="validate_schema",
            type="validate",
            description="Validate schema matches treaty",
            depends_on=["construct"],
            trials_after=["schema_integrity"],
        ),
        Workshop(
            name="validate_semantics",
            type="validate",
            description="Run golden questions",
            depends_on=["construct"],
            trials_after=["golden_questions"],
        ),
        Workshop(
            name="validate_quality",
            type="validate",
            description="Check data quality metrics",
            depends_on=["construct"],
            trials_after=["null_rate", "row_count_bounds"],
        ),
    ],
    mandatory_trials=[
        "schema_integrity",
        "null_rate",
        "row_count_bounds",
        "golden_questions",
        "freshness",
    ],
    promotion=PromotionPath(
        stations=["development", "staging", "canary", "production"],
        staging_requires=["schema_integrity", "null_rate"],
        canary_requires=["golden_questions"],
        production_requires=["freshness"],
        canary_duration="24h",
        canary_percentage=5,
    ),
    rollback=RollbackConfig(
        triggers=["trial_failure_in_production", "chronicle_declared"],
        strategy="restore_previous",
        notify=["data-platform-oncall"],
    ),
    requires_treaty=True,
    requires_golden_questions=True,
    tags=["dataset", "public", "treaty"],
    owner="data-platform",
)

INTERNAL_DATASET_PATTERN = PatternBook(
    name="internal-dataset",
    version="1.0.0",
    description="Pattern for internal datasets (no treaty required)",
    holding_type="dataset",
    required_inputs=["holding_name", "realm"],
    optional_inputs=["source_query", "retention_days"],
    workshops=[
        Workshop(
            name="construct",
            type="build",
            description="Build the dataset",
        ),
        Workshop(
            name="validate_quality",
            type="validate",
            description="Basic quality checks",
            depends_on=["construct"],
            trials_after=["null_rate", "row_count_bounds"],
        ),
    ],
    mandatory_trials=["null_rate", "row_count_bounds"],
    optional_trials=["schema_integrity", "freshness"],
    promotion=PromotionPath(
        stations=["development", "staging", "production"],
        staging_requires=["null_rate"],
        production_requires=["row_count_bounds"],
    ),
    rollback=RollbackConfig(
        triggers=["trial_failure_in_production"],
        strategy="restore_previous",
    ),
    requires_treaty=False,
    requires_golden_questions=False,
    tags=["dataset", "internal"],
)

BACKFILL_PATTERN = PatternBook(
    name="backfill",
    version="1.0.0",
    description="Pattern for historical data backfills",
    holding_type="dataset",
    required_inputs=["holding_name", "realm", "start_date", "end_date"],
    optional_inputs=["batch_size", "parallelism"],
    workshops=[
        Workshop(
            name="validate_range",
            type="validate",
            description="Validate backfill date range",
        ),
        Workshop(
            name="construct_batches",
            type="build",
            description="Build data in batches",
            depends_on=["validate_range"],
            config={"batch_size": "1d"},
        ),
        Workshop(
            name="reconcile",
            type="validate",
            description="Reconcile against source",
            depends_on=["construct_batches"],
            trials_after=["row_count_bounds"],
        ),
    ],
    mandatory_trials=["row_count_bounds"],
    optional_trials=["schema_integrity"],
    promotion=PromotionPath(
        stations=["development", "staging", "production"],
        # Backfills can skip canary
    ),
    rollback=RollbackConfig(
        triggers=["trial_failure"],
        strategy="manual_intervention",
        require_approval=True,
    ),
    requires_treaty=False,
    requires_golden_questions=False,
    tags=["backfill", "historical"],
)

ML_MODEL_PATTERN = PatternBook(
    name="ml-model",
    version="1.0.0",
    description="Pattern for ML model training and deployment",
    holding_type="model",
    required_inputs=["model_name", "realm", "training_data", "target_metric"],
    optional_inputs=["hyperparameters", "validation_split"],
    workshops=[
        Workshop(
            name="prepare_features",
            type="build",
            description="Prepare feature datasets",
        ),
        Workshop(
            name="train",
            type="build",
            description="Train the model",
            depends_on=["prepare_features"],
        ),
        Workshop(
            name="evaluate",
            type="validate",
            description="Evaluate model performance",
            depends_on=["train"],
        ),
        Workshop(
            name="validate_fairness",
            type="validate",
            description="Check for bias and fairness",
            depends_on=["train"],
        ),
    ],
    mandatory_trials=["schema_integrity"],  # For model artifacts
    optional_trials=["freshness"],
    promotion=PromotionPath(
        stations=["development", "staging", "canary", "production"],
        canary_duration="48h",
        canary_percentage=1,
    ),
    rollback=RollbackConfig(
        triggers=["trial_failure_in_production", "chronicle_declared"],
        strategy="restore_previous",
        require_approval=True,
    ),
    requires_treaty=False,
    requires_golden_questions=False,
    tags=["ml", "model"],
)

# Registry of built-in patterns
BUILTIN_PATTERNS = {
    "public-holding": PUBLIC_HOLDING_PATTERN,
    "internal-dataset": INTERNAL_DATASET_PATTERN,
    "backfill": BACKFILL_PATTERN,
    "ml-model": ML_MODEL_PATTERN,
}
