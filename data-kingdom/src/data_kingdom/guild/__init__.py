"""
Guilds

Work does not happen by "roles." It happens by Guilds.

Each Guild specializes in a craft:
- Logwrights (logging & ingestion)
- Engineers (transforms & infrastructure)
- Scholars (analysis & semantics)
- Seers (ML & forecasting)
- Cartographers (dashboards & BI)
- Wardens (reliability, cost, privacy)

Guild members work in parallel, bound by campaign law.
Agents are cattle. Beads are immortal.
"""

from data_kingdom.guild.models import (
    Craft,
    GuildMember,
    Post,
    SummoningRecord,
    DismissalRecord,
)
from data_kingdom.guild.spawner import GuildSpawner
from data_kingdom.guild.post_master import PostMaster

__all__ = [
    "Craft",
    "GuildMember",
    "Post",
    "SummoningRecord",
    "DismissalRecord",
    "GuildSpawner",
    "PostMaster",
]
