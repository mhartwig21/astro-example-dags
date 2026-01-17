"""
Realm and Treaty Loader

Loads Realms and Treaties from the filesystem.

Directory structure:
    realms/
    ├── analytics/
    │   ├── realm.yaml          # Realm definition
    │   ├── fiefs/
    │   │   └── metrics/
    │   ├── internal/           # Private data (no treaties here)
    │   └── treaties/           # Public interfaces
    │       └── dau_daily.yaml
    └── ads/
        ├── realm.yaml
        └── treaties/
            └── impressions.yaml
"""

from pathlib import Path
from typing import Optional

import yaml

from data_kingdom.realm.models import (
    Realm,
    Fief,
    Treaty,
    TreatyGrant,
    SchemaColumn,
    GoldenQuestion,
    Guarantees,
    DeprecatedVersion,
)


class RealmLoadError(Exception):
    """Raised when a realm cannot be loaded."""

    pass


class TreatyLoadError(Exception):
    """Raised when a treaty cannot be loaded."""

    pass


def load_realm(path: Path | str) -> Realm:
    """
    Load a Realm from a realm.yaml file.

    Args:
        path: Path to the realm.yaml file

    Returns:
        Realm instance
    """
    path = Path(path)

    if not path.exists():
        raise RealmLoadError(f"Realm file not found: {path}")

    try:
        with open(path) as f:
            data = yaml.safe_load(f)
    except yaml.YAMLError as e:
        raise RealmLoadError(f"Invalid YAML in {path}: {e}")

    if not data:
        raise RealmLoadError(f"Empty realm file: {path}")

    # Handle nested 'realm' key if present
    if "realm" in data:
        data = data["realm"]

    # Convert fiefs to Fief objects
    if "fiefs" in data:
        fiefs = []
        for fief_data in data["fiefs"]:
            if isinstance(fief_data, str):
                fiefs.append(Fief(name=fief_data))
            else:
                fiefs.append(Fief(**fief_data))
        data["fiefs"] = fiefs

    try:
        return Realm(**data)
    except Exception as e:
        raise RealmLoadError(f"Invalid realm structure in {path}: {e}")


def load_treaty(path: Path | str) -> Treaty:
    """
    Load a Treaty from a YAML file.

    Args:
        path: Path to the treaty YAML file

    Returns:
        Treaty instance
    """
    path = Path(path)

    if not path.exists():
        raise TreatyLoadError(f"Treaty file not found: {path}")

    try:
        with open(path) as f:
            data = yaml.safe_load(f)
    except yaml.YAMLError as e:
        raise TreatyLoadError(f"Invalid YAML in {path}: {e}")

    if not data:
        raise TreatyLoadError(f"Empty treaty file: {path}")

    # Handle nested 'treaty' key if present
    if "treaty" in data:
        data = data["treaty"]

    # Convert schema to SchemaColumn objects
    if "schema" in data:
        data["schema_columns"] = [SchemaColumn(**col) for col in data.pop("schema")]

    # Convert granted_to to TreatyGrant objects
    if "granted_to" in data:
        grants = []
        for grant_data in data["granted_to"]:
            if isinstance(grant_data, str):
                grants.append(TreatyGrant(realm=grant_data))
            elif isinstance(grant_data, dict):
                grants.append(TreatyGrant(**grant_data))
        data["granted_to"] = grants

    # Convert golden_questions to GoldenQuestion objects
    if "golden_questions" in data:
        data["golden_questions"] = [
            GoldenQuestion(**gq) for gq in data["golden_questions"]
        ]

    # Convert guarantees to Guarantees object
    if "guarantees" in data:
        data["guarantees"] = Guarantees(**data["guarantees"])

    # Convert deprecated_versions to DeprecatedVersion objects
    if "deprecated_versions" in data:
        data["deprecated_versions"] = [
            DeprecatedVersion(**dv) for dv in data["deprecated_versions"]
        ]

    try:
        return Treaty(**data)
    except Exception as e:
        raise TreatyLoadError(f"Invalid treaty structure in {path}: {e}")


def load_all_realms(realms_dir: Path | str) -> dict[str, Realm]:
    """
    Load all realms from a realms directory.

    Args:
        realms_dir: Path to the realms/ directory

    Returns:
        Dict mapping realm name to Realm
    """
    realms_dir = Path(realms_dir)
    realms = {}

    if not realms_dir.exists():
        return realms

    for realm_path in realms_dir.iterdir():
        if not realm_path.is_dir():
            continue

        realm_file = realm_path / "realm.yaml"
        if not realm_file.exists():
            realm_file = realm_path / "realm.yml"

        if realm_file.exists():
            try:
                realm = load_realm(realm_file)
                realms[realm.name] = realm
            except RealmLoadError:
                # Skip invalid realms, could log warning
                pass

    return realms


def load_realm_treaties(realm_dir: Path | str) -> dict[str, Treaty]:
    """
    Load all treaties for a realm.

    Args:
        realm_dir: Path to a realm directory (e.g., realms/analytics/)

    Returns:
        Dict mapping treaty name to Treaty
    """
    realm_dir = Path(realm_dir)
    treaties_dir = realm_dir / "treaties"
    treaties = {}

    if not treaties_dir.exists():
        return treaties

    for treaty_file in treaties_dir.glob("*.yaml"):
        try:
            treaty = load_treaty(treaty_file)
            treaties[treaty.name] = treaty
        except TreatyLoadError:
            pass

    for treaty_file in treaties_dir.glob("*.yml"):
        try:
            treaty = load_treaty(treaty_file)
            treaties[treaty.name] = treaty
        except TreatyLoadError:
            pass

    return treaties
