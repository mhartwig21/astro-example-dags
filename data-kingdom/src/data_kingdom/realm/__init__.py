"""
Realms and Treaties

Data does not live in a flat system.
It lives in territories, governed by lords, protected by law,
and connected by treaties.

Realms are feudal territories (e.g., Analytics, Ads, Integrity).
Treaties are the only legal way data crosses borders.

No treaty, no dependency.
"""

from data_kingdom.realm.models import (
    Realm,
    Fief,
    Treaty,
    TreatyGrant,
    SchemaColumn,
    GoldenQuestion,
    Guarantees,
)
from data_kingdom.realm.registry import RealmRegistry
from data_kingdom.realm.loader import load_realm, load_treaty, load_all_realms

__all__ = [
    "Realm",
    "Fief",
    "Treaty",
    "TreatyGrant",
    "SchemaColumn",
    "GoldenQuestion",
    "Guarantees",
    "RealmRegistry",
    "load_realm",
    "load_treaty",
    "load_all_realms",
]
