"""
Trials

Trials are the individual tests the Court runs to evaluate a Holding.
Each trial examines one aspect of quality and produces evidence.

Standard Trials:
1. SchemaIntegrityTrial - Does the schema match the treaty?
2. NullRateTrial - Are null rates within acceptable bounds?
3. RowCountBoundsTrial - Is row count within expected range?
4. GoldenQuestionsTrial - Do golden questions return expected answers?
5. FreshnessTrial - Is the data fresh enough?
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Optional
import hashlib
import json


@dataclass
class TrialResult:
    """The result of running a single trial."""

    name: str
    passed: bool
    details: dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None
    duration_ms: Optional[float] = None

    def to_evidence(self) -> dict:
        """Convert to evidence format for TrialRecord."""
        return {
            "name": self.name,
            "passed": self.passed,
            "details": self.details,
            "error": self.error,
        }


class Trial(ABC):
    """
    Base class for all trials.

    A Trial examines one aspect of a Holding and produces evidence.
    Trials are stateless - they receive all context at execution time.
    """

    name: str = "base_trial"
    description: str = "Base trial class"

    @abstractmethod
    def conduct(
        self,
        holding: Any,
        treaty: Optional[dict] = None,
        context: Optional[dict] = None,
    ) -> TrialResult:
        """
        Conduct the trial and return the result.

        Args:
            holding: The HoldingRecord being tried
            treaty: The treaty definition (if applicable)
            context: Additional context (previous runs, baselines, etc.)

        Returns:
            TrialResult with evidence
        """
        pass


class SchemaIntegrityTrial(Trial):
    """
    Verify the holding's schema matches its treaty definition.

    This trial checks:
    - All required columns are present
    - Column types match declared types
    - No unexpected columns (unless allowed)
    """

    name = "schema_integrity"
    description = "Verify schema matches treaty definition"

    def __init__(
        self,
        allow_extra_columns: bool = False,
        schema_provider: Optional[Callable[[Any], dict]] = None,
    ):
        self.allow_extra_columns = allow_extra_columns
        self.schema_provider = schema_provider or self._default_schema_provider

    def _default_schema_provider(self, holding: Any) -> dict:
        """
        Default schema provider - returns mock schema for demo.
        In production, this would query the actual data source.
        """
        # For MVP, return a mock schema based on holding metadata
        return holding.metadata.get("schema", {})

    def conduct(
        self,
        holding: Any,
        treaty: Optional[dict] = None,
        context: Optional[dict] = None,
    ) -> TrialResult:
        if not treaty:
            return TrialResult(
                name=self.name,
                passed=True,
                details={"reason": "No treaty defined, schema check skipped"},
            )

        expected_schema = treaty.get("schema", [])
        if not expected_schema:
            return TrialResult(
                name=self.name,
                passed=True,
                details={"reason": "No schema defined in treaty"},
            )

        actual_schema = self.schema_provider(holding)

        # Check for missing columns
        expected_columns = {col["name"] for col in expected_schema}
        actual_columns = set(actual_schema.keys()) if isinstance(actual_schema, dict) else set()

        missing = expected_columns - actual_columns
        extra = actual_columns - expected_columns if not self.allow_extra_columns else set()

        passed = len(missing) == 0 and len(extra) == 0

        return TrialResult(
            name=self.name,
            passed=passed,
            details={
                "expected_columns": list(expected_columns),
                "actual_columns": list(actual_columns),
                "missing_columns": list(missing),
                "extra_columns": list(extra),
            },
            error=f"Schema mismatch: missing={list(missing)}, extra={list(extra)}" if not passed else None,
        )


class NullRateTrial(Trial):
    """
    Verify null rates are within acceptable bounds.

    Checks that the percentage of null values in key columns
    doesn't exceed the defined thresholds.
    """

    name = "null_rate"
    description = "Verify null rates are within bounds"

    def __init__(
        self,
        default_threshold: float = 0.05,  # 5% default
        null_rate_provider: Optional[Callable[[Any, str], float]] = None,
    ):
        self.default_threshold = default_threshold
        self.null_rate_provider = null_rate_provider or self._default_null_rate_provider

    def _default_null_rate_provider(self, holding: Any, column: str) -> float:
        """Default provider - returns mock null rate for demo."""
        # In production, query actual data
        null_rates = holding.metadata.get("null_rates", {})
        return null_rates.get(column, 0.0)

    def conduct(
        self,
        holding: Any,
        treaty: Optional[dict] = None,
        context: Optional[dict] = None,
    ) -> TrialResult:
        context = context or {}
        thresholds = context.get("null_thresholds", {})
        columns_to_check = context.get("columns", [])

        # If no columns specified, check all columns in treaty schema
        if not columns_to_check and treaty:
            columns_to_check = [col["name"] for col in treaty.get("schema", [])]

        if not columns_to_check:
            return TrialResult(
                name=self.name,
                passed=True,
                details={"reason": "No columns to check"},
            )

        violations = []
        column_results = {}

        for column in columns_to_check:
            null_rate = self.null_rate_provider(holding, column)
            threshold = thresholds.get(column, self.default_threshold)

            column_results[column] = {
                "null_rate": null_rate,
                "threshold": threshold,
                "passed": null_rate <= threshold,
            }

            if null_rate > threshold:
                violations.append(f"{column}: {null_rate:.2%} > {threshold:.2%}")

        passed = len(violations) == 0

        return TrialResult(
            name=self.name,
            passed=passed,
            details={"column_results": column_results},
            error=f"Null rate violations: {violations}" if not passed else None,
        )


class RowCountBoundsTrial(Trial):
    """
    Verify row count is within expected bounds.

    Checks that the holding has a reasonable number of rows,
    either absolute bounds or relative to a baseline.
    """

    name = "row_count_bounds"
    description = "Verify row count is within expected bounds"

    def __init__(
        self,
        row_count_provider: Optional[Callable[[Any], int]] = None,
    ):
        self.row_count_provider = row_count_provider or self._default_row_count_provider

    def _default_row_count_provider(self, holding: Any) -> int:
        """Default provider - returns mock row count for demo."""
        return holding.metadata.get("row_count", 0)

    def conduct(
        self,
        holding: Any,
        treaty: Optional[dict] = None,
        context: Optional[dict] = None,
    ) -> TrialResult:
        context = context or {}

        actual_count = self.row_count_provider(holding)

        # Get bounds from context or use defaults
        min_rows = context.get("min_rows", 0)
        max_rows = context.get("max_rows", float("inf"))

        # Check relative bounds if baseline provided
        baseline = context.get("baseline_row_count")
        tolerance = context.get("tolerance", 0.2)  # 20% default

        if baseline:
            min_rows = max(min_rows, int(baseline * (1 - tolerance)))
            max_rows = min(max_rows, int(baseline * (1 + tolerance)))

        passed = min_rows <= actual_count <= max_rows

        return TrialResult(
            name=self.name,
            passed=passed,
            details={
                "actual_row_count": actual_count,
                "min_rows": min_rows,
                "max_rows": max_rows if max_rows != float("inf") else "unlimited",
                "baseline": baseline,
                "tolerance": tolerance if baseline else None,
            },
            error=f"Row count {actual_count} outside bounds [{min_rows}, {max_rows}]" if not passed else None,
        )


class GoldenQuestionsTrial(Trial):
    """
    Verify golden questions return expected answers.

    Golden questions are semantic tests - they verify that
    the data means what we say it means.
    """

    name = "golden_questions"
    description = "Verify golden questions return expected answers"

    def __init__(
        self,
        query_executor: Optional[Callable[[Any, str], Any]] = None,
    ):
        self.query_executor = query_executor or self._default_query_executor

    def _default_query_executor(self, holding: Any, question: str) -> Any:
        """Default executor - returns mock answers for demo."""
        answers = holding.metadata.get("golden_answers", {})
        return answers.get(question)

    def _values_match(self, actual: Any, expected: Any, tolerance: float) -> bool:
        """Check if values match within tolerance."""
        if actual is None:
            return expected is None

        if isinstance(expected, (int, float)) and isinstance(actual, (int, float)):
            if expected == 0:
                return actual == 0
            return abs(actual - expected) / abs(expected) <= tolerance

        return actual == expected

    def conduct(
        self,
        holding: Any,
        treaty: Optional[dict] = None,
        context: Optional[dict] = None,
    ) -> TrialResult:
        golden_questions = []

        # Get golden questions from treaty
        if treaty:
            golden_questions = treaty.get("golden_questions", [])

        # Or from context
        if not golden_questions and context:
            golden_questions = context.get("golden_questions", [])

        if not golden_questions:
            return TrialResult(
                name=self.name,
                passed=True,
                details={"reason": "No golden questions defined"},
            )

        results = []
        failures = []

        for gq in golden_questions:
            question = gq.get("question", "")
            expected = gq.get("expected")
            tolerance = gq.get("tolerance", 0.01)  # 1% default

            actual = self.query_executor(holding, question)
            matches = self._values_match(actual, expected, tolerance)

            result = {
                "question": question,
                "expected": expected,
                "actual": actual,
                "tolerance": tolerance,
                "passed": matches,
            }
            results.append(result)

            if not matches:
                failures.append(f"'{question}': expected {expected}, got {actual}")

        passed = len(failures) == 0

        return TrialResult(
            name=self.name,
            passed=passed,
            details={
                "questions_tested": len(golden_questions),
                "questions_passed": len(golden_questions) - len(failures),
                "results": results,
            },
            error=f"Golden question failures: {failures}" if not passed else None,
        )


class FreshnessTrial(Trial):
    """
    Verify the data is fresh enough according to SLO.

    Checks that the data was updated within the required window.
    """

    name = "freshness"
    description = "Verify data freshness meets SLO"

    def __init__(
        self,
        timestamp_provider: Optional[Callable[[Any], datetime]] = None,
    ):
        self.timestamp_provider = timestamp_provider or self._default_timestamp_provider

    def _default_timestamp_provider(self, holding: Any) -> datetime:
        """Default provider - returns mock timestamp for demo."""
        ts = holding.metadata.get("last_updated")
        if ts:
            return datetime.fromisoformat(ts)
        return holding.created_at

    def _parse_duration(self, duration_str: str) -> timedelta:
        """Parse duration string like '24h', '7d', '30m' into timedelta."""
        if not duration_str:
            return timedelta(hours=24)  # default

        unit = duration_str[-1].lower()
        value = int(duration_str[:-1])

        if unit == "h":
            return timedelta(hours=value)
        elif unit == "d":
            return timedelta(days=value)
        elif unit == "m":
            return timedelta(minutes=value)
        else:
            return timedelta(hours=value)  # assume hours

    def conduct(
        self,
        holding: Any,
        treaty: Optional[dict] = None,
        context: Optional[dict] = None,
    ) -> TrialResult:
        context = context or {}

        # Get freshness SLO
        freshness_slo = None
        if treaty:
            guarantees = treaty.get("guarantees", {})
            freshness_slo = guarantees.get("freshness")

        if not freshness_slo:
            freshness_slo = context.get("freshness_slo", "24h")

        max_age = self._parse_duration(freshness_slo)
        last_updated = self.timestamp_provider(holding)
        now = datetime.now(timezone.utc)

        # Ensure last_updated is timezone-aware
        if last_updated.tzinfo is None:
            last_updated = last_updated.replace(tzinfo=timezone.utc)

        age = now - last_updated
        passed = age <= max_age

        return TrialResult(
            name=self.name,
            passed=passed,
            details={
                "last_updated": last_updated.isoformat(),
                "age_hours": age.total_seconds() / 3600,
                "max_age_hours": max_age.total_seconds() / 3600,
                "freshness_slo": freshness_slo,
            },
            error=f"Data is {age} old, exceeds SLO of {freshness_slo}" if not passed else None,
        )


# Registry of standard trials
STANDARD_TRIALS = {
    "schema_integrity": SchemaIntegrityTrial,
    "null_rate": NullRateTrial,
    "row_count_bounds": RowCountBoundsTrial,
    "golden_questions": GoldenQuestionsTrial,
    "freshness": FreshnessTrial,
}


def get_trial(name: str, **kwargs) -> Trial:
    """Get a trial instance by name."""
    if name not in STANDARD_TRIALS:
        raise ValueError(f"Unknown trial: {name}. Available: {list(STANDARD_TRIALS.keys())}")
    return STANDARD_TRIALS[name](**kwargs)
