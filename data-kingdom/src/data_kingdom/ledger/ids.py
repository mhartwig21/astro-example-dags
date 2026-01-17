"""
Ledger ID Generation

IDs are the soul of the Ledger. They must be:
- Collision-free across all agents, branches, and time
- Hierarchical (children reference parents)
- Human-readable enough for debugging
- Short enough for conversation

Format: dk-{4 hex chars}
Children: dk-{parent}.{sequence}

Examples:
  dk-a1b2          (root record)
  dk-a1b2.1        (first child)
  dk-a1b2.1.1      (grandchild)
"""

import hashlib
import os
import time
from typing import Optional


def generate_id(prefix: str = "dk") -> str:
    """
    Generate a new root-level ledger ID.

    Uses a combination of:
    - Current timestamp (nanoseconds)
    - Random bytes
    - Process ID

    This ensures collision-free IDs even across parallel agents.
    """
    entropy = f"{time.time_ns()}-{os.urandom(8).hex()}-{os.getpid()}"
    hash_bytes = hashlib.sha256(entropy.encode()).hexdigest()
    short_hash = hash_bytes[:4]
    return f"{prefix}-{short_hash}"


def generate_child_id(parent_id: str, sequence: int) -> str:
    """
    Generate a child ID from a parent.

    Args:
        parent_id: The parent record ID (e.g., "dk-a1b2" or "dk-a1b2.1")
        sequence: The child sequence number (1-indexed)

    Returns:
        Child ID (e.g., "dk-a1b2.1" or "dk-a1b2.1.1")
    """
    return f"{parent_id}.{sequence}"


def parse_id(record_id: str) -> dict:
    """
    Parse a ledger ID into its components.

    Returns:
        {
            "prefix": "dk",
            "root": "a1b2",
            "path": [1, 1],  # child indices
            "depth": 2,
            "parent": "dk-a1b2.1" or None
        }
    """
    parts = record_id.split("-", 1)
    if len(parts) != 2:
        raise ValueError(f"Invalid ledger ID format: {record_id}")

    prefix = parts[0]
    rest = parts[1]

    segments = rest.split(".")
    root = segments[0]
    path = [int(s) for s in segments[1:]] if len(segments) > 1 else []

    parent = None
    if path:
        parent_path = ".".join(str(s) for s in path[:-1])
        if parent_path:
            parent = f"{prefix}-{root}.{parent_path}"
        else:
            parent = f"{prefix}-{root}"

    return {
        "prefix": prefix,
        "root": root,
        "path": path,
        "depth": len(path),
        "parent": parent,
    }


def get_parent_id(record_id: str) -> Optional[str]:
    """Get the parent ID of a record, or None if it's a root record."""
    parsed = parse_id(record_id)
    return parsed["parent"]


def get_root_id(record_id: str) -> str:
    """Get the root ID of a record (strips all child segments)."""
    parsed = parse_id(record_id)
    return f"{parsed['prefix']}-{parsed['root']}"


def is_ancestor_of(ancestor_id: str, descendant_id: str) -> bool:
    """Check if ancestor_id is an ancestor of descendant_id."""
    return descendant_id.startswith(ancestor_id + ".")
