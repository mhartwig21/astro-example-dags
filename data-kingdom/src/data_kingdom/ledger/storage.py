"""
Ledger Storage

Git-backed, append-only storage for the Great Ledger.

Design principles:
1. Every write is a Git commit (history is immutable)
2. Records are stored as JSONL (one JSON object per line)
3. Files are organized by record type for efficient querying
4. The ledger can be reconstructed from any point in Git history

Storage layout:
    .ledger/
    ├── petitions.jsonl
    ├── campaigns.jsonl
    ├── holdings.jsonl
    ├── trials.jsonl
    ├── coronations.jsonl
    └── index.json  # Quick lookup index
"""

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator, Optional

from git import Repo
from git.exc import InvalidGitRepositoryError

from data_kingdom.ledger.records import (
    AnyRecord,
    CampaignRecord,
    CoronationRecord,
    HoldingRecord,
    LedgerRecord,
    PetitionRecord,
    TrialRecord,
    record_from_dict,
)


class LedgerError(Exception):
    """Base exception for ledger operations."""

    pass


class LedgerNotInitialized(LedgerError):
    """Raised when trying to use a ledger that hasn't been initialized."""

    pass


class RecordNotFound(LedgerError):
    """Raised when a record cannot be found."""

    pass


class LedgerStorage:
    """
    Git-backed storage for the Great Ledger.

    If it is not written in the Ledger, it did not happen.
    """

    LEDGER_DIR = ".ledger"
    RECORD_FILES = {
        "petition": "petitions.jsonl",
        "campaign": "campaigns.jsonl",
        "holding": "holdings.jsonl",
        "trial": "trials.jsonl",
        "coronation": "coronations.jsonl",
    }

    def __init__(self, root_path: str | Path):
        """
        Initialize storage with a root path.

        Args:
            root_path: The root directory of the Data Kingdom
        """
        self.root = Path(root_path).resolve()
        self.ledger_path = self.root / self.LEDGER_DIR
        self._repo: Optional[Repo] = None
        self._index: dict[str, dict] = {}

    @property
    def repo(self) -> Repo:
        """Get the Git repository, initializing connection if needed."""
        if self._repo is None:
            try:
                self._repo = Repo(self.root)
            except InvalidGitRepositoryError:
                raise LedgerNotInitialized(
                    f"No Git repository found at {self.root}. "
                    "Run 'dk init --git' to initialize."
                )
        return self._repo

    def is_initialized(self) -> bool:
        """Check if the ledger has been initialized."""
        return self.ledger_path.exists() and (self.ledger_path / "index.json").exists()

    def initialize(self, use_git: bool = True) -> None:
        """
        Initialize a new ledger.

        Args:
            use_git: Whether to initialize Git repository if not present
        """
        # Create ledger directory
        self.ledger_path.mkdir(parents=True, exist_ok=True)

        # Create empty record files
        for filename in self.RECORD_FILES.values():
            filepath = self.ledger_path / filename
            if not filepath.exists():
                filepath.touch()

        # Create index
        index_path = self.ledger_path / "index.json"
        if not index_path.exists():
            self._index = {
                "created_at": datetime.now(timezone.utc).isoformat(),
                "version": "1.0.0",
                "records": {},
            }
            self._write_index()

        # Initialize Git if requested
        if use_git:
            try:
                self.repo
            except LedgerNotInitialized:
                Repo.init(self.root)
                self._repo = Repo(self.root)

            # Add .gitignore for common patterns
            gitignore_path = self.root / ".gitignore"
            if not gitignore_path.exists():
                gitignore_path.write_text(
                    "# Python\n"
                    "__pycache__/\n"
                    "*.py[cod]\n"
                    ".venv/\n"
                    "venv/\n"
                    "\n"
                    "# IDE\n"
                    ".idea/\n"
                    ".vscode/\n"
                    "\n"
                    "# Local\n"
                    ".env\n"
                    "*.local\n"
                )

            # Initial commit
            self.repo.index.add([str(self.ledger_path.relative_to(self.root))])
            if gitignore_path.exists():
                self.repo.index.add([".gitignore"])
            self.repo.index.commit("Initialize the Great Ledger")

    def _get_file_path(self, record_type: str) -> Path:
        """Get the file path for a record type."""
        if record_type not in self.RECORD_FILES:
            raise ValueError(f"Unknown record type: {record_type}")
        return self.ledger_path / self.RECORD_FILES[record_type]

    def _load_index(self) -> dict:
        """Load the index from disk."""
        index_path = self.ledger_path / "index.json"
        if index_path.exists():
            self._index = json.loads(index_path.read_text())
        return self._index

    def _write_index(self) -> None:
        """Write the index to disk."""
        index_path = self.ledger_path / "index.json"
        index_path.write_text(json.dumps(self._index, indent=2, default=str))

    def write(self, record: LedgerRecord, commit_message: Optional[str] = None) -> str:
        """
        Write a record to the ledger.

        This is the fundamental operation. Every write is persisted
        and committed to Git history.

        Args:
            record: The record to write
            commit_message: Optional custom commit message

        Returns:
            The record ID
        """
        if not self.is_initialized():
            raise LedgerNotInitialized("Ledger not initialized. Run 'dk init' first.")

        # Serialize record
        record_json = record.model_dump_json()

        # Append to appropriate file
        filepath = self._get_file_path(record.record_type)
        with open(filepath, "a") as f:
            f.write(record_json + "\n")

        # Update index
        self._load_index()
        self._index["records"][record.id] = {
            "type": record.record_type,
            "created_at": record.created_at.isoformat(),
            "parent": record.parent,
        }
        self._write_index()

        # Commit to Git
        message = commit_message or f"Record {record.record_type}: {record.id}"
        self.repo.index.add([
            str(filepath.relative_to(self.root)),
            str((self.ledger_path / "index.json").relative_to(self.root)),
        ])
        self.repo.index.commit(message)

        return record.id

    def read(self, record_id: str) -> AnyRecord:
        """
        Read a single record by ID.

        Args:
            record_id: The record ID to look up

        Returns:
            The record

        Raises:
            RecordNotFound: If the record doesn't exist
        """
        if not self.is_initialized():
            raise LedgerNotInitialized("Ledger not initialized.")

        # Check index for record type
        self._load_index()
        if record_id not in self._index.get("records", {}):
            raise RecordNotFound(f"Record not found: {record_id}")

        record_type = self._index["records"][record_id]["type"]

        # Scan the appropriate file
        filepath = self._get_file_path(record_type)
        for line in filepath.read_text().strip().split("\n"):
            if not line:
                continue
            data = json.loads(line)
            if data.get("id") == record_id:
                return record_from_dict(data)

        raise RecordNotFound(f"Record in index but not in file: {record_id}")

    def query(
        self,
        record_type: Optional[str] = None,
        parent: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> Iterator[AnyRecord]:
        """
        Query records from the ledger.

        Args:
            record_type: Filter by record type
            parent: Filter by parent ID
            limit: Maximum number of records to return

        Yields:
            Matching records
        """
        if not self.is_initialized():
            raise LedgerNotInitialized("Ledger not initialized.")

        count = 0
        files_to_scan = (
            [self._get_file_path(record_type)]
            if record_type
            else [self.ledger_path / f for f in self.RECORD_FILES.values()]
        )

        for filepath in files_to_scan:
            if not filepath.exists():
                continue

            for line in filepath.read_text().strip().split("\n"):
                if not line:
                    continue

                if limit and count >= limit:
                    return

                data = json.loads(line)

                # Apply filters
                if parent and data.get("parent") != parent:
                    continue

                yield record_from_dict(data)
                count += 1

    def get_children(self, parent_id: str) -> list[AnyRecord]:
        """Get all direct children of a record."""
        return list(self.query(parent=parent_id))

    def get_descendants(self, ancestor_id: str) -> list[AnyRecord]:
        """Get all descendants of a record (recursive)."""
        descendants = []
        children = self.get_children(ancestor_id)
        for child in children:
            descendants.append(child)
            descendants.extend(self.get_descendants(child.id))
        return descendants

    def count(self, record_type: Optional[str] = None) -> int:
        """Count records, optionally filtered by type."""
        return sum(1 for _ in self.query(record_type=record_type))

    def get_latest_by_type(self, record_type: str, limit: int = 10) -> list[AnyRecord]:
        """Get the most recent records of a given type."""
        records = list(self.query(record_type=record_type))
        # Sort by created_at descending
        records.sort(key=lambda r: r.created_at, reverse=True)
        return records[:limit]

    def find_campaigns_by_status(self, status: str) -> list[CampaignRecord]:
        """Find all campaigns with a given status."""
        campaigns = []
        for record in self.query(record_type="campaign"):
            if isinstance(record, CampaignRecord) and record.status == status:
                campaigns.append(record)
        return campaigns

    def find_holding_by_name(
        self, name: str, version: Optional[str] = None
    ) -> Optional[HoldingRecord]:
        """Find a holding by name and optionally version."""
        for record in self.query(record_type="holding"):
            if isinstance(record, HoldingRecord) and record.name == name:
                if version is None or record.version == version:
                    return record
        return None

    def get_trial_for_holding(self, holding_id: str) -> Optional[TrialRecord]:
        """Get the most recent trial for a holding."""
        trials = []
        for record in self.query(record_type="trial"):
            if isinstance(record, TrialRecord) and record.holding == holding_id:
                trials.append(record)

        if not trials:
            return None

        # Return most recent
        trials.sort(key=lambda t: t.created_at, reverse=True)
        return trials[0]

    def get_history(self, limit: int = 50) -> list[AnyRecord]:
        """Get recent ledger history across all types."""
        all_records = list(self.query(limit=limit * 5))  # Over-fetch then sort
        all_records.sort(key=lambda r: r.created_at, reverse=True)
        return all_records[:limit]
