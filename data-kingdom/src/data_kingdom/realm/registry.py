"""
Realm Registry

Central registry for Realms and Treaties in a Kingdom.

The registry:
1. Loads all realms from the realms/ directory
2. Loads all treaties for each realm
3. Validates treaty access (border control)
4. Tracks dependencies between realms
"""

from pathlib import Path
from typing import Optional

from data_kingdom.realm.models import Realm, Treaty, Fief
from data_kingdom.realm.loader import (
    load_all_realms,
    load_realm_treaties,
    load_realm,
    load_treaty,
    RealmLoadError,
    TreatyLoadError,
)


class RealmNotFound(Exception):
    """Raised when a realm cannot be found."""

    pass


class TreatyNotFound(Exception):
    """Raised when a treaty cannot be found."""

    pass


class TreatyAccessDenied(Exception):
    """Raised when access to a treaty is denied."""

    pass


class RealmRegistry:
    """
    Registry for Realms and Treaties.

    Manages the feudal structure of the Kingdom and enforces
    border controls via treaties.
    """

    REALMS_DIR = "realms"

    def __init__(self, kingdom_root: Path | str):
        """
        Initialize the registry.

        Args:
            kingdom_root: Root directory of the Kingdom
        """
        self.kingdom_root = Path(kingdom_root)
        self.realms_dir = self.kingdom_root / self.REALMS_DIR
        self._realms: dict[str, Realm] = {}
        self._treaties: dict[str, dict[str, Treaty]] = {}  # realm -> {treaty_name -> Treaty}
        self._loaded = False

    def _ensure_loaded(self) -> None:
        """Load realms and treaties if not already loaded."""
        if self._loaded:
            return

        # Load all realms
        self._realms = load_all_realms(self.realms_dir)

        # Load treaties for each realm
        for realm_name in self._realms:
            realm_path = self.realms_dir / realm_name
            self._treaties[realm_name] = load_realm_treaties(realm_path)

        self._loaded = True

    # =========================================================================
    # Realm Operations
    # =========================================================================

    def get_realm(self, name: str) -> Realm:
        """Get a realm by name."""
        self._ensure_loaded()

        if name not in self._realms:
            raise RealmNotFound(
                f"Realm '{name}' not found. Available: {', '.join(self.list_realm_names())}"
            )

        return self._realms[name]

    def realm_exists(self, name: str) -> bool:
        """Check if a realm exists."""
        self._ensure_loaded()
        return name in self._realms

    def list_realm_names(self) -> list[str]:
        """List all realm names."""
        self._ensure_loaded()
        return sorted(self._realms.keys())

    def list_realms(self) -> list[Realm]:
        """List all realms."""
        self._ensure_loaded()
        return list(self._realms.values())

    # =========================================================================
    # Treaty Operations
    # =========================================================================

    def get_treaty(self, realm: str, treaty_name: str) -> Treaty:
        """Get a treaty by realm and name."""
        self._ensure_loaded()

        if realm not in self._treaties:
            raise RealmNotFound(f"Realm '{realm}' not found")

        if treaty_name not in self._treaties[realm]:
            available = list(self._treaties[realm].keys())
            raise TreatyNotFound(
                f"Treaty '{treaty_name}' not found in realm '{realm}'. "
                f"Available: {', '.join(available) if available else 'none'}"
            )

        return self._treaties[realm][treaty_name]

    def treaty_exists(self, realm: str, treaty_name: str) -> bool:
        """Check if a treaty exists."""
        self._ensure_loaded()
        return realm in self._treaties and treaty_name in self._treaties[realm]

    def list_treaties(self, realm: str) -> list[Treaty]:
        """List all treaties for a realm."""
        self._ensure_loaded()

        if realm not in self._treaties:
            return []

        return list(self._treaties[realm].values())

    def list_all_treaties(self) -> list[Treaty]:
        """List all treaties across all realms."""
        self._ensure_loaded()

        treaties = []
        for realm_treaties in self._treaties.values():
            treaties.extend(realm_treaties.values())

        return treaties

    # =========================================================================
    # Border Control
    # =========================================================================

    def check_access(
        self,
        requesting_realm: str,
        target_realm: str,
        treaty_name: str,
        requesting_fief: Optional[str] = None,
    ) -> tuple[bool, str]:
        """
        Check if a realm can access a treaty.

        This is the core border control function.

        Args:
            requesting_realm: Realm requesting access
            target_realm: Realm that owns the treaty
            treaty_name: Name of the treaty
            requesting_fief: Optional fief making the request

        Returns:
            Tuple of (allowed, reason)
        """
        # Same realm always has access to its own treaties
        if requesting_realm == target_realm:
            return True, "Same realm access"

        try:
            treaty = self.get_treaty(target_realm, treaty_name)
        except (RealmNotFound, TreatyNotFound) as e:
            return False, str(e)

        # Check if treaty grants access
        if treaty.is_granted_to(requesting_realm, requesting_fief):
            return True, "Treaty grants access"

        return False, (
            f"Access denied: Realm '{requesting_realm}' is not granted access to "
            f"treaty '{treaty_name}' from realm '{target_realm}'. "
            "Request a treaty grant from the realm ruler."
        )

    def require_access(
        self,
        requesting_realm: str,
        target_realm: str,
        treaty_name: str,
        requesting_fief: Optional[str] = None,
    ) -> Treaty:
        """
        Require access to a treaty, raising an exception if denied.

        Args:
            requesting_realm: Realm requesting access
            target_realm: Realm that owns the treaty
            treaty_name: Name of the treaty
            requesting_fief: Optional fief making the request

        Returns:
            The Treaty if access is granted

        Raises:
            TreatyAccessDenied: If access is not granted
        """
        allowed, reason = self.check_access(
            requesting_realm, target_realm, treaty_name, requesting_fief
        )

        if not allowed:
            raise TreatyAccessDenied(reason)

        return self.get_treaty(target_realm, treaty_name)

    # =========================================================================
    # Dependency Tracking
    # =========================================================================

    def get_realm_dependencies(self, realm: str) -> list[dict]:
        """
        Get the treaties a realm depends on.

        Returns:
            List of {realm, treaty, granted} dicts
        """
        self._ensure_loaded()

        realm_obj = self.get_realm(realm)
        deps = []

        for dep in realm_obj.dependencies:
            target_realm = dep.get("realm")
            treaty_name = dep.get("treaty")

            allowed, _ = self.check_access(realm, target_realm, treaty_name)

            deps.append({
                "realm": target_realm,
                "treaty": treaty_name,
                "granted": allowed,
            })

        return deps

    def get_treaty_dependents(self, realm: str, treaty_name: str) -> list[str]:
        """
        Get realms that depend on a treaty.

        Returns:
            List of realm names that have been granted access
        """
        self._ensure_loaded()

        try:
            treaty = self.get_treaty(realm, treaty_name)
        except TreatyNotFound:
            return []

        dependents = []

        if treaty.public:
            # All realms can depend on public treaties
            dependents = self.list_realm_names()
        else:
            for grant in treaty.granted_to:
                dependents.append(grant.realm)

        return dependents

    # =========================================================================
    # Initialization
    # =========================================================================

    def initialize_realm(self, name: str, ruler: str, description: str = "") -> Path:
        """
        Initialize a new realm directory structure.

        Args:
            name: Realm name
            ruler: Who rules the realm
            description: Realm description

        Returns:
            Path to the created realm directory
        """
        realm_path = self.realms_dir / name

        # Create directory structure
        (realm_path / "fiefs").mkdir(parents=True, exist_ok=True)
        (realm_path / "internal").mkdir(exist_ok=True)
        (realm_path / "treaties").mkdir(exist_ok=True)

        # Create realm.yaml
        realm_yaml = realm_path / "realm.yaml"
        if not realm_yaml.exists():
            import yaml

            realm_data = {
                "name": name,
                "description": description,
                "ruler": ruler,
                "status": "active",
                "fiefs": [],
                "laws": [],
                "dependencies": [],
            }

            with open(realm_yaml, "w") as f:
                yaml.dump(realm_data, f, default_flow_style=False, sort_keys=False)

        # Reload to pick up new realm
        self._loaded = False

        return realm_path

    def reload(self) -> None:
        """Force reload of all realms and treaties."""
        self._loaded = False
        self._realms = {}
        self._treaties = {}
        self._ensure_loaded()
