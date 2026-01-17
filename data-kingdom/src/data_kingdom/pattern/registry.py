"""
Pattern Registry

Central registry for Pattern Books in a Kingdom.

The registry:
1. Loads built-in patterns
2. Loads custom patterns from pattern-books/
3. Allows pattern lookup by name
4. Validates pattern usage
"""

from pathlib import Path
from typing import Optional

from data_kingdom.pattern.models import PatternBook
from data_kingdom.pattern.loader import (
    load_all_patterns,
    BUILTIN_PATTERNS,
    PatternLoadError,
)


class PatternNotFound(Exception):
    """Raised when a pattern cannot be found."""

    pass


class PatternRegistry:
    """
    Registry for Pattern Books.

    Manages both built-in patterns and custom patterns
    from the pattern-books/ directory.
    """

    PATTERN_DIR = "pattern-books"

    def __init__(self, kingdom_root: Path | str):
        """
        Initialize the registry.

        Args:
            kingdom_root: Root directory of the Kingdom
        """
        self.kingdom_root = Path(kingdom_root)
        self.pattern_dir = self.kingdom_root / self.PATTERN_DIR
        self._patterns: dict[str, PatternBook] = {}
        self._loaded = False

    def _ensure_loaded(self) -> None:
        """Load patterns if not already loaded."""
        if self._loaded:
            return

        # Start with built-in patterns
        self._patterns = dict(BUILTIN_PATTERNS)

        # Override with custom patterns from pattern-books/
        if self.pattern_dir.exists():
            custom_patterns = load_all_patterns(self.pattern_dir)
            self._patterns.update(custom_patterns)

        self._loaded = True

    def get(self, name: str) -> PatternBook:
        """
        Get a pattern by name.

        Args:
            name: Pattern name

        Returns:
            PatternBook

        Raises:
            PatternNotFound: If pattern doesn't exist
        """
        self._ensure_loaded()

        if name not in self._patterns:
            raise PatternNotFound(
                f"Pattern '{name}' not found. "
                f"Available: {', '.join(self.list_names())}"
            )

        return self._patterns[name]

    def exists(self, name: str) -> bool:
        """Check if a pattern exists."""
        self._ensure_loaded()
        return name in self._patterns

    def list_names(self) -> list[str]:
        """List all available pattern names."""
        self._ensure_loaded()
        return sorted(self._patterns.keys())

    def list_all(self) -> list[PatternBook]:
        """List all available patterns."""
        self._ensure_loaded()
        return list(self._patterns.values())

    def list_by_tag(self, tag: str) -> list[PatternBook]:
        """List patterns with a specific tag."""
        self._ensure_loaded()
        return [p for p in self._patterns.values() if tag in p.tags]

    def list_by_holding_type(self, holding_type: str) -> list[PatternBook]:
        """List patterns that produce a specific holding type."""
        self._ensure_loaded()
        return [p for p in self._patterns.values() if p.holding_type == holding_type]

    def register(self, pattern: PatternBook) -> None:
        """
        Register a pattern programmatically.

        Args:
            pattern: PatternBook to register
        """
        self._ensure_loaded()
        self._patterns[pattern.name] = pattern

    def validate_for_realm(self, pattern_name: str, realm: str) -> tuple[bool, str]:
        """
        Check if a pattern can be used in a realm.

        Args:
            pattern_name: Pattern to check
            realm: Realm attempting to use it

        Returns:
            Tuple of (allowed, reason)
        """
        try:
            pattern = self.get(pattern_name)
        except PatternNotFound as e:
            return False, str(e)

        if pattern.allowed_realms and realm not in pattern.allowed_realms:
            return False, (
                f"Pattern '{pattern_name}' is not allowed in realm '{realm}'. "
                f"Allowed realms: {', '.join(pattern.allowed_realms)}"
            )

        return True, "Allowed"

    def get_summary(self, name: str) -> dict:
        """Get a summary of a pattern for display."""
        pattern = self.get(name)

        return {
            "name": pattern.name,
            "version": pattern.version,
            "description": pattern.description,
            "holding_type": pattern.holding_type,
            "workshops": len(pattern.workshops),
            "mandatory_trials": len(pattern.mandatory_trials),
            "requires_treaty": pattern.requires_treaty,
            "requires_golden_questions": pattern.requires_golden_questions,
            "tags": pattern.tags,
        }

    def reload(self) -> None:
        """Force reload of all patterns."""
        self._loaded = False
        self._patterns = {}
        self._ensure_loaded()
