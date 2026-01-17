"""
The Court

The Court is not advisory. It is law.

It evaluates holdings against the standards required by their treaties
and pattern books. The Court's verdict determines whether a holding
may be promoted (crowned).

No trial, no crown. No exceptions.
"""

import time
from datetime import datetime, timezone
from typing import Optional

from data_kingdom.ledger import (
    CoronationRecord,
    HoldingRecord,
    LedgerStorage,
    Station,
    TrialEvidence,
    TrialRecord,
    TrialVerdict,
    generate_child_id,
)
from data_kingdom.court.trials import (
    Trial,
    TrialResult,
    STANDARD_TRIALS,
    get_trial,
)


class CoronationDenied(Exception):
    """Raised when a holding cannot be crowned."""

    pass


class Court:
    """
    The Court evaluates all work before promotion.

    It judges correctness, meaning, safety, performance, and stability.
    Its output is a Verdict: Approved, Approved with Conditions, or Rejected.

    The Court does not debate. It rules.
    """

    # The promotion path - stations in order
    STATION_ORDER = [
        Station.DEVELOPMENT,
        Station.STAGING,
        Station.CANARY,
        Station.PRODUCTION,
    ]

    def __init__(self, ledger: LedgerStorage):
        self.ledger = ledger
        self.trial_registry: dict[str, Trial] = {}

        # Register standard trials
        for name, trial_cls in STANDARD_TRIALS.items():
            self.trial_registry[name] = trial_cls()

    def register_trial(self, name: str, trial: Trial) -> None:
        """Register a custom trial."""
        self.trial_registry[name] = trial

    def _load_treaty(self, holding: HoldingRecord) -> Optional[dict]:
        """Load the treaty definition for a holding."""
        if not holding.treaty:
            return None

        # For MVP, treaty is stored in holding metadata
        # In production, this would load from the filesystem
        return holding.metadata.get("treaty_data")

    def hold_trial(
        self,
        holding: HoldingRecord,
        trials: Optional[list[str]] = None,
        context: Optional[dict] = None,
    ) -> TrialRecord:
        """
        Conduct all trials for a holding and return a TrialRecord.

        Args:
            holding: The holding to evaluate
            trials: List of trial names to run (default: all standard trials)
            context: Additional context for trials

        Returns:
            A TrialRecord with the verdict
        """
        context = context or {}
        trials_to_run = trials or list(self.trial_registry.keys())

        treaty = self._load_treaty(holding)
        evidence_list: list[TrialEvidence] = []
        all_passed = True

        for trial_name in trials_to_run:
            if trial_name not in self.trial_registry:
                evidence_list.append(
                    TrialEvidence(
                        name=trial_name,
                        passed=False,
                        error=f"Unknown trial: {trial_name}",
                    )
                )
                all_passed = False
                continue

            trial = self.trial_registry[trial_name]

            start_time = time.time()
            try:
                result = trial.conduct(holding, treaty, context)
                duration_ms = (time.time() - start_time) * 1000

                evidence_list.append(
                    TrialEvidence(
                        name=result.name,
                        passed=result.passed,
                        details={
                            **result.details,
                            "duration_ms": duration_ms,
                        },
                        error=result.error,
                    )
                )

                if not result.passed:
                    all_passed = False

            except Exception as e:
                evidence_list.append(
                    TrialEvidence(
                        name=trial_name,
                        passed=False,
                        error=f"Trial failed with exception: {str(e)}",
                    )
                )
                all_passed = False

        # Determine verdict
        if all_passed:
            verdict = TrialVerdict.APPROVED
        else:
            # Check if any failures are blocking vs warnings
            blocking_failures = [e for e in evidence_list if not e.passed and not e.details.get("warning_only")]
            if blocking_failures:
                verdict = TrialVerdict.REJECTED
            else:
                verdict = TrialVerdict.APPROVED_WITH_CONDITIONS

        # Get campaign ID for hierarchy
        campaign_id = holding.parent

        # Count existing children to get sequence
        existing_children = self.ledger.get_children(campaign_id) if campaign_id else []
        sequence = len(existing_children) + 1

        trial_id = generate_child_id(campaign_id, sequence) if campaign_id else f"trial-{holding.id}"

        rejection_reasons = [
            e.error for e in evidence_list if not e.passed and e.error
        ]

        trial_record = TrialRecord(
            id=trial_id,
            parent=campaign_id,
            holding=holding.id,
            trials_run=evidence_list,
            verdict=verdict,
            rejection_reasons=rejection_reasons,
        )

        # Write to ledger
        self.ledger.write(
            trial_record,
            f"Trial for {holding.name}: {verdict.value}",
        )

        return trial_record

    def get_trial_for_holding(self, holding_id: str) -> Optional[TrialRecord]:
        """Get the most recent trial for a holding."""
        return self.ledger.get_trial_for_holding(holding_id)

    def _normalize_station(self, station) -> Station:
        """Convert a station value to Station enum."""
        if isinstance(station, Station):
            return station
        if isinstance(station, str):
            return Station(station)
        raise ValueError(f"Invalid station value: {station}")

    def may_crown(self, holding: HoldingRecord, to_station: Station) -> tuple[bool, str]:
        """
        Check if a holding may be promoted to a station.

        Returns:
            Tuple of (allowed, reason)
        """
        # Must have a passing trial
        trial = self.get_trial_for_holding(holding.id)

        if not trial:
            return False, "No trial on record. Run 'dk court try' first."

        if trial.verdict == TrialVerdict.REJECTED:
            return False, f"Trial rejected: {', '.join(trial.rejection_reasons)}"

        # Normalize stations for comparison
        current_station = self._normalize_station(holding.current_station)
        target_station = self._normalize_station(to_station)

        # Check station progression
        current_idx = self.STATION_ORDER.index(current_station)
        target_idx = self.STATION_ORDER.index(target_station)

        if target_idx <= current_idx:
            return False, f"Cannot demote from {current_station.value} to {target_station.value}"

        if target_idx > current_idx + 1:
            return False, f"Cannot skip stations. Must promote to {self.STATION_ORDER[current_idx + 1].value} first."

        # Production requires canary success (if coming from canary)
        if target_station == Station.PRODUCTION and current_station == Station.CANARY:
            canary_context = holding.metadata.get("canary_results", {})
            if not canary_context.get("success", False):
                return False, "Canary must succeed before production promotion"

        return True, "Approved"

    def crown(
        self,
        holding: HoldingRecord,
        to_station: Station,
        witnesses: Optional[list[str]] = None,
    ) -> CoronationRecord:
        """
        Crown a holding - promote it to a new station.

        Args:
            holding: The holding to promote
            to_station: The target station
            witnesses: Who witnessed this coronation

        Returns:
            A CoronationRecord

        Raises:
            CoronationDenied: If the holding cannot be promoted
        """
        allowed, reason = self.may_crown(holding, to_station)

        if not allowed:
            raise CoronationDenied(f"Coronation denied for {holding.id}: {reason}")

        # Get the trial that approved this
        trial = self.get_trial_for_holding(holding.id)

        # Get campaign ID for hierarchy
        campaign_id = holding.parent

        # Count existing children to get sequence
        existing_children = self.ledger.get_children(campaign_id) if campaign_id else []
        sequence = len(existing_children) + 1

        coronation_id = generate_child_id(campaign_id, sequence) if campaign_id else f"coronation-{holding.id}"

        # Normalize stations
        current_station = self._normalize_station(holding.current_station)
        target_station = self._normalize_station(to_station)

        coronation = CoronationRecord(
            id=coronation_id,
            parent=campaign_id,
            holding=holding.id,
            from_station=current_station,
            to_station=target_station,
            verdict=trial.id if trial else "manual",
            crowned_by="court",
            witnesses=witnesses or [],
        )

        # Write coronation to ledger
        self.ledger.write(
            coronation,
            f"Coronation: {holding.name} promoted to {target_station.value}",
        )

        return coronation

    def get_next_station(self, current: Station) -> Optional[Station]:
        """Get the next station in the promotion path."""
        current_idx = self.STATION_ORDER.index(current)
        if current_idx >= len(self.STATION_ORDER) - 1:
            return None
        return self.STATION_ORDER[current_idx + 1]

    def summarize_trial(self, trial: TrialRecord) -> dict:
        """Generate a human-readable summary of a trial."""
        passed = sum(1 for e in trial.trials_run if e.passed)
        total = len(trial.trials_run)

        return {
            "verdict": trial.verdict.value,
            "passed": passed,
            "total": total,
            "pass_rate": f"{passed}/{total}",
            "failures": [
                {"name": e.name, "error": e.error}
                for e in trial.trials_run
                if not e.passed
            ],
        }
