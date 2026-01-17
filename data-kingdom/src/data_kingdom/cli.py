"""
The Decree Kit (dk)

Command-line interface for the Data Kingdom.

Usage:
    dk init [--git]           Initialize a new kingdom
    dk petition <request>     File a new petition
    dk campaign launch        Launch a campaign from a petition
    dk campaign inspect       View campaign status (War Room)
    dk ledger show            Show ledger history
    dk ledger query           Query specific records
"""

import os
from pathlib import Path
from typing import Optional

import click
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.tree import Tree

from data_kingdom.ledger import (
    CampaignRecord,
    CampaignScope,
    CampaignStatus,
    CoronationRecord,
    HoldingRecord,
    LedgerStorage,
    PetitionRecord,
    RecordStatus,
    TrialRecord,
    TrialVerdict,
    generate_child_id,
    generate_id,
)
from data_kingdom.ledger.storage import LedgerNotInitialized, RecordNotFound

console = Console()


def get_kingdom_root() -> Path:
    """Find the kingdom root by looking for .ledger directory."""
    current = Path.cwd()

    # Walk up looking for .ledger
    for parent in [current] + list(current.parents):
        if (parent / ".ledger").exists():
            return parent

    # Default to current directory
    return current


def get_storage() -> LedgerStorage:
    """Get a LedgerStorage instance for the current kingdom."""
    return LedgerStorage(get_kingdom_root())


@click.group()
@click.version_option(version="0.1.0", prog_name="Data Kingdom")
def main():
    """
    The Data Kingdom - A feudal operating system for data products.

    If it is not written in the Ledger, it did not happen.
    """
    pass


# =============================================================================
# INIT COMMAND
# =============================================================================


@main.command()
@click.option("--git/--no-git", default=True, help="Initialize Git repository")
@click.option("--path", type=click.Path(), default=".", help="Path to initialize")
def init(git: bool, path: str):
    """Initialize a new Data Kingdom."""
    root = Path(path).resolve()

    storage = LedgerStorage(root)

    if storage.is_initialized():
        console.print(f"[yellow]Kingdom already initialized at {root}[/yellow]")
        return

    storage.initialize(use_git=git)

    console.print(
        Panel(
            f"[green]The Data Kingdom has been established at:[/green]\n"
            f"[bold]{root}[/bold]\n\n"
            f"[dim]The Great Ledger awaits your petitions.[/dim]",
            title="Kingdom Initialized",
            border_style="green",
        )
    )


# =============================================================================
# PETITION COMMANDS
# =============================================================================


@main.command()
@click.argument("request")
@click.option("--realm", "-r", required=True, help="Target realm for this petition")
@click.option("--petitioner", "-p", default=None, help="Who is filing (default: current user)")
@click.option("--justification", "-j", default=None, help="Why this is needed")
@click.option("--priority", type=click.Choice(["low", "normal", "high", "urgent"]), default="normal")
def petition(request: str, realm: str, petitioner: Optional[str], justification: Optional[str], priority: str):
    """File a new petition to the Kingdom."""
    storage = get_storage()

    if not storage.is_initialized():
        console.print("[red]No kingdom found. Run 'dk init' first.[/red]")
        return

    # Generate ID and create petition
    petition_id = generate_id()
    record = PetitionRecord(
        id=petition_id,
        petitioner=petitioner or os.environ.get("USER", "unknown"),
        request=request,
        realm=realm,
        justification=justification,
        priority=priority,
    )

    storage.write(record, f"Petition filed: {request[:50]}")

    console.print(
        Panel(
            f"[bold]Petition ID:[/bold] {petition_id}\n"
            f"[bold]Request:[/bold] {request}\n"
            f"[bold]Realm:[/bold] {realm}\n"
            f"[bold]Priority:[/bold] {priority}",
            title="Petition Filed",
            border_style="blue",
        )
    )


# =============================================================================
# CAMPAIGN COMMANDS
# =============================================================================


@main.group()
def campaign():
    """Manage campaigns (bounded attempts to change reality)."""
    pass


@campaign.command("launch")
@click.argument("petition_id")
@click.option("--objective", "-o", default=None, help="Campaign objective (default: from petition)")
@click.option("--pattern", "-p", default=None, help="Pattern book to follow")
@click.option("--blast-radius", "-b", default=None, help="Impact description")
@click.option("--retreat-plan", "-r", default=None, help="What to do if this fails")
def campaign_launch(
    petition_id: str,
    objective: Optional[str],
    pattern: Optional[str],
    blast_radius: Optional[str],
    retreat_plan: Optional[str],
):
    """Launch a new campaign from a petition."""
    storage = get_storage()

    try:
        petition_record = storage.read(petition_id)
    except RecordNotFound:
        console.print(f"[red]Petition not found: {petition_id}[/red]")
        return

    if not isinstance(petition_record, PetitionRecord):
        console.print(f"[red]{petition_id} is not a petition[/red]")
        return

    # Count existing campaigns under this petition to get sequence number
    existing = storage.get_children(petition_id)
    sequence = len([c for c in existing if isinstance(c, CampaignRecord)]) + 1

    campaign_id = generate_child_id(petition_id, sequence)

    record = CampaignRecord(
        id=campaign_id,
        parent=petition_id,
        objective=objective or petition_record.request,
        status=CampaignStatus.ACTIVE,
        scope=CampaignScope(realms_affected=[petition_record.realm]),
        blast_radius=blast_radius or f"{petition_record.realm} realm",
        retreat_plan=retreat_plan,
        pattern_book=pattern,
    )

    storage.write(record, f"Campaign launched: {campaign_id}")

    console.print(
        Panel(
            f"[bold]Campaign ID:[/bold] {campaign_id}\n"
            f"[bold]Objective:[/bold] {record.objective}\n"
            f"[bold]Pattern:[/bold] {pattern or 'none'}\n"
            f"[bold]Status:[/bold] [green]ACTIVE[/green]",
            title="Campaign Launched",
            border_style="green",
        )
    )


@campaign.command("inspect")
@click.argument("campaign_id")
def campaign_inspect(campaign_id: str):
    """Inspect a campaign (the War Room view)."""
    storage = get_storage()

    try:
        record = storage.read(campaign_id)
    except RecordNotFound:
        console.print(f"[red]Campaign not found: {campaign_id}[/red]")
        return

    if not isinstance(record, CampaignRecord):
        console.print(f"[red]{campaign_id} is not a campaign[/red]")
        return

    # Get children (holdings, trials, etc.)
    children = storage.get_descendants(campaign_id)
    holdings = [c for c in children if isinstance(c, HoldingRecord)]
    trials = [c for c in children if isinstance(c, TrialRecord)]
    coronations = [c for c in children if isinstance(c, CoronationRecord)]

    # Build status color
    status_colors = {
        "active": "green",
        "succeeded": "blue",
        "failed": "red",
        "abandoned": "yellow",
        "blocked": "red",
    }
    status_color = status_colors.get(record.status, "white")

    # Build the display
    console.print()
    console.print(Panel(
        f"[bold]Objective:[/bold] {record.objective}",
        title=f"CAMPAIGN {campaign_id}",
        subtitle=f"[{status_color}]{record.status.upper()}[/{status_color}]",
        border_style=status_color,
    ))

    # Holdings table
    if holdings:
        table = Table(title="Holdings", show_header=True)
        table.add_column("ID", style="cyan")
        table.add_column("Name")
        table.add_column("Version")
        table.add_column("Station")
        table.add_column("Trial")

        for h in holdings:
            trial = storage.get_trial_for_holding(h.id)
            trial_status = "pending"
            if trial:
                trial_status = "[green]passed[/green]" if trial.verdict == "approved" else "[red]failed[/red]"

            table.add_row(
                h.id,
                h.name,
                h.version,
                h.current_station,
                trial_status,
            )

        console.print(table)
    else:
        console.print("[dim]No holdings yet[/dim]")

    # Scope and blast radius
    console.print()
    console.print(f"[bold]Blast Radius:[/bold] {record.blast_radius}")
    console.print(f"[bold]Realms:[/bold] {', '.join(record.scope.realms_affected)}")
    if record.retreat_plan:
        console.print(f"[bold]Retreat Plan:[/bold] {record.retreat_plan}")


@campaign.command("list")
@click.option("--status", "-s", type=click.Choice(["active", "succeeded", "failed", "abandoned", "blocked"]), default=None)
@click.option("--limit", "-n", default=20, help="Maximum campaigns to show")
def campaign_list(status: Optional[str], limit: int):
    """List campaigns."""
    storage = get_storage()

    if status:
        campaigns = storage.find_campaigns_by_status(status)
    else:
        campaigns = list(storage.query(record_type="campaign", limit=limit))

    if not campaigns:
        console.print("[dim]No campaigns found[/dim]")
        return

    table = Table(title="Campaigns", show_header=True)
    table.add_column("ID", style="cyan")
    table.add_column("Objective")
    table.add_column("Status")
    table.add_column("Created")

    status_colors = {
        "active": "green",
        "succeeded": "blue",
        "failed": "red",
        "abandoned": "yellow",
        "blocked": "red",
    }

    for c in campaigns[:limit]:
        if isinstance(c, CampaignRecord):
            color = status_colors.get(c.status, "white")
            table.add_row(
                c.id,
                c.objective[:50] + "..." if len(c.objective) > 50 else c.objective,
                f"[{color}]{c.status}[/{color}]",
                c.created_at.strftime("%Y-%m-%d %H:%M"),
            )

    console.print(table)


@campaign.command("execute")
@click.argument("petition_id")
@click.option("--pattern", "-p", required=True, help="Pattern book to follow")
@click.option("--holding", "-h", required=True, help="Name for the holding to produce")
@click.option("--description", "-d", default="", help="Campaign description")
@click.option("--auto-summon", "-a", is_flag=True, help="Auto-summon guild members for workshops")
@click.option("--input", "-i", "inputs", multiple=True, type=(str, str), help="Pattern inputs (key value)")
def campaign_execute(
    petition_id: str,
    pattern: str,
    holding: str,
    description: str,
    auto_summon: bool,
    inputs: tuple,
):
    """Execute a campaign from a pattern book with guild orchestration."""
    from data_kingdom.campaign import CampaignCoordinator

    storage = get_storage()

    # Verify petition exists
    try:
        petition = storage.read(petition_id)
    except RecordNotFound:
        console.print(f"[red]Petition not found: {petition_id}[/red]")
        return

    if not isinstance(petition, PetitionRecord):
        console.print(f"[red]{petition_id} is not a petition[/red]")
        return

    # Convert inputs to dict
    input_dict = {k: v for k, v in inputs}

    # Launch the campaign
    coordinator = CampaignCoordinator(get_kingdom_root())

    try:
        campaign = coordinator.launch_from_pattern(
            petition_id=petition_id,
            pattern_name=pattern,
            holding_name=holding,
            description=description,
            auto_summon=auto_summon,
            inputs=input_dict,
        )

        console.print(Panel(
            f"[bold]Campaign ID:[/bold] {campaign.id}\n"
            f"[bold]Pattern:[/bold] {pattern}\n"
            f"[bold]Holding:[/bold] {holding}\n"
            f"[bold]Auto-summon:[/bold] {'Yes' if auto_summon else 'No'}\n"
            f"[bold]Status:[/bold] [green]{campaign.status.value if hasattr(campaign.status, 'value') else campaign.status}[/green]",
            title="Campaign Executing",
            border_style="green",
        ))

        if auto_summon:
            console.print("\n[bold]Guild members summoned for workshops.[/bold]")
            console.print("Use 'dk campaign status' to monitor progress.")

    except ValueError as e:
        console.print(f"[red]Error: {e}[/red]")
    except Exception as e:
        console.print(f"[red]Failed to launch campaign: {e}[/red]")


@campaign.command("status")
@click.argument("campaign_id")
def campaign_status(campaign_id: str):
    """Show detailed campaign status with guild and workshop info."""
    from data_kingdom.campaign import CampaignCoordinator

    storage = get_storage()

    try:
        storage.read(campaign_id)
    except RecordNotFound:
        console.print(f"[red]Campaign not found: {campaign_id}[/red]")
        return

    coordinator = CampaignCoordinator(get_kingdom_root())

    try:
        status = coordinator.get_campaign_status(campaign_id)
    except Exception as e:
        console.print(f"[red]Error getting status: {e}[/red]")
        return

    campaign = status["campaign"]

    # Campaign overview
    status_colors = {
        "active": "green",
        "succeeded": "blue",
        "failed": "red",
        "abandoned": "yellow",
        "blocked": "red",
        "planned": "dim",
    }
    # Handle both enum and string status
    status_val = campaign.status.value if hasattr(campaign.status, 'value') else campaign.status
    status_color = status_colors.get(status_val, "white")

    # Get pattern from pattern_book field or metadata
    pattern_name = getattr(campaign, 'pattern_book', None)
    if not pattern_name and campaign.metadata:
        pattern_name = campaign.metadata.get('pattern')

    console.print(Panel(
        f"[bold]ID:[/bold] {campaign.id}\n"
        f"[bold]Objective:[/bold] {campaign.objective}\n"
        f"[bold]Status:[/bold] [{status_color}]{status_val.upper()}[/{status_color}]\n"
        f"[bold]Pattern:[/bold] {pattern_name or 'none'}",
        title="Campaign Status",
        border_style=status_color,
    ))

    # Holdings table
    holdings = status.get("holdings", [])
    if holdings:
        table = Table(title="Holdings", show_header=True)
        table.add_column("ID", style="cyan")
        table.add_column("Name")
        table.add_column("Type")
        table.add_column("Station")

        for h in holdings:
            station = h.current_station.value if hasattr(h.current_station, 'value') else h.current_station
            table.add_row(h.id, h.name, h.holding_type, station)

        console.print(table)

    # Workshop status
    workshop_status = status.get("workshop_status")
    if workshop_status:
        console.print()
        table = Table(title="Workshop Progress", show_header=True)
        table.add_column("Workshop", style="cyan")
        table.add_column("Type")
        table.add_column("Craft")
        table.add_column("State")

        state_colors = {
            "completed": "green",
            "in_progress": "yellow",
            "pending": "dim",
        }

        for ws in workshop_status:
            color = state_colors.get(ws["state"], "white")
            table.add_row(
                ws["workshop"],
                ws["type"],
                ws["craft"],
                f"[{color}]{ws['state']}[/{color}]",
            )

        console.print(table)

    # Active guild members
    members = status.get("active_members", [])
    if members:
        console.print()
        table = Table(title="Active Guild Members", show_header=True)
        table.add_column("ID", style="magenta")
        table.add_column("Craft")
        table.add_column("Task")
        table.add_column("Status")

        for m in members:
            status_val = m.status.value if hasattr(m.status, 'value') else m.status
            table.add_row(
                m.id,
                m.craft.value if hasattr(m.craft, 'value') else m.craft,
                m.task[:40] + "..." if len(m.task) > 40 else m.task,
                f"[green]{status_val}[/green]",
            )

        console.print(table)

    # Posts
    posts = status.get("posts", [])
    if posts:
        console.print()
        console.print(f"[dim]Posts: {len(posts)} workspace(s) established[/dim]")


@campaign.command("summon-workshop")
@click.argument("campaign_id")
@click.argument("workshop_name")
def campaign_summon_workshop(campaign_id: str, workshop_name: str):
    """Summon a guild member for a specific workshop in a pattern-based campaign."""
    from data_kingdom.campaign import CampaignCoordinator

    coordinator = CampaignCoordinator(get_kingdom_root())

    try:
        member = coordinator.summon_for_workshop(campaign_id, workshop_name)

        console.print(Panel(
            f"[bold]Member ID:[/bold] {member.id}\n"
            f"[bold]Craft:[/bold] {member.craft.value}\n"
            f"[bold]Workshop:[/bold] {workshop_name}\n"
            f"[bold]Post:[/bold] {member.post_id}",
            title="Guild Member Summoned for Workshop",
            border_style="magenta",
        ))

    except ValueError as e:
        console.print(f"[red]Error: {e}[/red]")
    except Exception as e:
        console.print(f"[red]Failed to summon: {e}[/red]")


# =============================================================================
# LEDGER COMMANDS
# =============================================================================


@main.group()
def ledger():
    """Query and inspect the Great Ledger."""
    pass


@ledger.command("show")
@click.argument("record_id")
def ledger_show(record_id: str):
    """Show details of a specific record."""
    storage = get_storage()

    try:
        record = storage.read(record_id)
    except RecordNotFound:
        console.print(f"[red]Record not found: {record_id}[/red]")
        return

    # Pretty print the record
    console.print(Panel(
        record.model_dump_json(indent=2),
        title=f"{record.record_type.upper()}: {record_id}",
        border_style="cyan",
    ))


@ledger.command("history")
@click.option("--limit", "-n", default=20, help="Maximum records to show")
@click.option("--type", "-t", "record_type", default=None, help="Filter by record type")
def ledger_history(limit: int, record_type: Optional[str]):
    """Show recent ledger history."""
    storage = get_storage()

    if not storage.is_initialized():
        console.print("[red]No kingdom found. Run 'dk init' first.[/red]")
        return

    if record_type:
        records = storage.get_latest_by_type(record_type, limit=limit)
    else:
        records = storage.get_history(limit=limit)

    if not records:
        console.print("[dim]The ledger is empty[/dim]")
        return

    table = Table(title="Ledger History", show_header=True)
    table.add_column("ID", style="cyan")
    table.add_column("Type")
    table.add_column("Created")
    table.add_column("Summary")

    type_colors = {
        "petition": "blue",
        "campaign": "green",
        "holding": "yellow",
        "trial": "magenta",
        "coronation": "cyan",
    }

    for record in records:
        color = type_colors.get(record.record_type, "white")

        # Generate summary based on type
        summary = ""
        if isinstance(record, PetitionRecord):
            summary = record.request[:40]
        elif isinstance(record, CampaignRecord):
            summary = record.objective[:40]
        elif isinstance(record, HoldingRecord):
            summary = f"{record.name} v{record.version}"
        elif isinstance(record, TrialRecord):
            summary = f"verdict: {record.verdict}"
        elif isinstance(record, CoronationRecord):
            summary = f"{record.from_station} → {record.to_station}"

        table.add_row(
            record.id,
            f"[{color}]{record.record_type}[/{color}]",
            record.created_at.strftime("%Y-%m-%d %H:%M"),
            summary,
        )

    console.print(table)


@ledger.command("tree")
@click.argument("root_id")
def ledger_tree(root_id: str):
    """Show a record and all its descendants as a tree."""
    storage = get_storage()

    try:
        root = storage.read(root_id)
    except RecordNotFound:
        console.print(f"[red]Record not found: {root_id}[/red]")
        return

    def build_tree(record, tree_node):
        children = storage.get_children(record.id)
        for child in children:
            # Create label based on type
            if isinstance(child, CampaignRecord):
                label = f"[green]campaign[/green] {child.id}: {child.objective[:30]}"
            elif isinstance(child, HoldingRecord):
                label = f"[yellow]holding[/yellow] {child.id}: {child.name} v{child.version}"
            elif isinstance(child, TrialRecord):
                verdict_color = "green" if child.verdict == "approved" else "red"
                label = f"[magenta]trial[/magenta] {child.id}: [{verdict_color}]{child.verdict}[/{verdict_color}]"
            elif isinstance(child, CoronationRecord):
                label = f"[cyan]coronation[/cyan] {child.id}: {child.from_station} → {child.to_station}"
            else:
                label = f"{child.record_type} {child.id}"

            child_node = tree_node.add(label)
            build_tree(child, child_node)

    # Build root label
    if isinstance(root, PetitionRecord):
        root_label = f"[blue]petition[/blue] {root.id}: {root.request[:40]}"
    elif isinstance(root, CampaignRecord):
        root_label = f"[green]campaign[/green] {root.id}: {root.objective[:40]}"
    else:
        root_label = f"{root.record_type} {root.id}"

    tree = Tree(root_label)
    build_tree(root, tree)

    console.print(tree)


@ledger.command("stats")
def ledger_stats():
    """Show ledger statistics."""
    storage = get_storage()

    if not storage.is_initialized():
        console.print("[red]No kingdom found. Run 'dk init' first.[/red]")
        return

    table = Table(title="Ledger Statistics", show_header=True)
    table.add_column("Record Type")
    table.add_column("Count", justify="right")

    total = 0
    for record_type in ["petition", "campaign", "holding", "trial", "coronation"]:
        count = storage.count(record_type=record_type)
        total += count
        table.add_row(record_type.capitalize(), str(count))

    table.add_row("[bold]Total[/bold]", f"[bold]{total}[/bold]")

    console.print(table)


# =============================================================================
# HOLDING COMMANDS
# =============================================================================


@main.group()
def holding():
    """Manage holdings (produced assets)."""
    pass


@holding.command("create")
@click.argument("campaign_id")
@click.option("--name", "-n", required=True, help="Holding name")
@click.option("--version", "-v", required=True, help="Version")
@click.option("--type", "-t", "holding_type", default="dataset", help="Type (dataset, model, etc.)")
@click.option("--location", "-l", default=None, help="URI location")
@click.option("--treaty", default=None, help="Path to treaty file")
def holding_create(
    campaign_id: str,
    name: str,
    version: str,
    holding_type: str,
    location: Optional[str],
    treaty: Optional[str],
):
    """Create a new holding under a campaign."""
    storage = get_storage()

    try:
        campaign = storage.read(campaign_id)
    except RecordNotFound:
        console.print(f"[red]Campaign not found: {campaign_id}[/red]")
        return

    if not isinstance(campaign, CampaignRecord):
        console.print(f"[red]{campaign_id} is not a campaign[/red]")
        return

    # Get sequence number
    existing = storage.get_children(campaign_id)
    sequence = len(existing) + 1

    holding_id = generate_child_id(campaign_id, sequence)

    record = HoldingRecord(
        id=holding_id,
        parent=campaign_id,
        holding_type=holding_type,
        name=name,
        version=version,
        location=location,
        treaty=treaty,
    )

    storage.write(record, f"Holding created: {name} v{version}")

    console.print(
        Panel(
            f"[bold]Holding ID:[/bold] {holding_id}\n"
            f"[bold]Name:[/bold] {name}\n"
            f"[bold]Version:[/bold] {version}\n"
            f"[bold]Type:[/bold] {holding_type}\n"
            f"[bold]Station:[/bold] development",
            title="Holding Created",
            border_style="yellow",
        )
    )


# =============================================================================
# COURT COMMANDS
# =============================================================================


@main.group()
def court():
    """The Court - evaluates holdings and issues verdicts."""
    pass


@court.command("try")
@click.argument("holding_id")
@click.option(
    "--trials", "-t",
    multiple=True,
    help="Specific trials to run (default: all standard trials)",
)
@click.option(
    "--context", "-c",
    type=(str, str),
    multiple=True,
    help="Context key-value pairs for trials (e.g., -c min_rows 1000)",
)
def court_try(holding_id: str, trials: tuple, context: tuple):
    """Hold a trial for a holding. The Court will judge."""
    from data_kingdom.court import Court

    storage = get_storage()

    try:
        holding = storage.read(holding_id)
    except RecordNotFound:
        console.print(f"[red]Holding not found: {holding_id}[/red]")
        return

    if not isinstance(holding, HoldingRecord):
        console.print(f"[red]{holding_id} is not a holding[/red]")
        return

    # Build context dict from key-value pairs
    ctx = {}
    for key, value in context:
        # Try to parse as number
        try:
            ctx[key] = int(value)
        except ValueError:
            try:
                ctx[key] = float(value)
            except ValueError:
                ctx[key] = value

    # Initialize court and run trials
    the_court = Court(storage)

    trials_list = list(trials) if trials else None

    console.print(f"\n[bold]The Court is now in session for:[/bold] {holding.name} v{holding.version}")
    console.print("[dim]Running trials...[/dim]\n")

    trial_record = the_court.hold_trial(holding, trials=trials_list, context=ctx)

    # Display results
    verdict_colors = {
        "approved": "green",
        "approved_with_conditions": "yellow",
        "rejected": "red",
        "pending": "dim",
    }
    verdict_color = verdict_colors.get(trial_record.verdict, "white")

    # Results table
    table = Table(title="Trial Results", show_header=True)
    table.add_column("Trial", style="cyan")
    table.add_column("Verdict")
    table.add_column("Details")

    for evidence in trial_record.trials_run:
        if evidence.passed:
            verdict_str = "[green]PASSED[/green]"
        else:
            verdict_str = "[red]FAILED[/red]"

        details = evidence.error or "OK"
        if len(details) > 50:
            details = details[:47] + "..."

        table.add_row(evidence.name, verdict_str, details)

    console.print(table)

    # Summary
    passed = sum(1 for e in trial_record.trials_run if e.passed)
    total = len(trial_record.trials_run)

    console.print()
    console.print(
        Panel(
            f"[bold]Verdict:[/bold] [{verdict_color}]{trial_record.verdict.upper()}[/{verdict_color}]\n"
            f"[bold]Trials Passed:[/bold] {passed}/{total}\n"
            f"[bold]Trial ID:[/bold] {trial_record.id}",
            title="Court Ruling",
            border_style=verdict_color,
        )
    )

    if trial_record.rejection_reasons:
        console.print("\n[bold red]Rejection Reasons:[/bold red]")
        for reason in trial_record.rejection_reasons:
            console.print(f"  - {reason}")


@court.command("verdict")
@click.argument("holding_id")
def court_verdict(holding_id: str):
    """Show the latest verdict for a holding."""
    storage = get_storage()

    try:
        holding = storage.read(holding_id)
    except RecordNotFound:
        console.print(f"[red]Holding not found: {holding_id}[/red]")
        return

    if not isinstance(holding, HoldingRecord):
        console.print(f"[red]{holding_id} is not a holding[/red]")
        return

    trial = storage.get_trial_for_holding(holding_id)

    if not trial:
        console.print(f"[yellow]No trial on record for {holding_id}[/yellow]")
        console.print("[dim]Run 'dk court try' to hold a trial.[/dim]")
        return

    verdict_colors = {
        "approved": "green",
        "approved_with_conditions": "yellow",
        "rejected": "red",
        "pending": "dim",
    }
    verdict_color = verdict_colors.get(trial.verdict, "white")

    console.print(
        Panel(
            f"[bold]Holding:[/bold] {holding.name} v{holding.version}\n"
            f"[bold]Verdict:[/bold] [{verdict_color}]{trial.verdict.upper()}[/{verdict_color}]\n"
            f"[bold]Trial ID:[/bold] {trial.id}\n"
            f"[bold]Date:[/bold] {trial.created_at.strftime('%Y-%m-%d %H:%M')}",
            title="Court Verdict",
            border_style=verdict_color,
        )
    )


# =============================================================================
# CROWN COMMAND
# =============================================================================


@main.command()
@click.argument("holding_id")
@click.option(
    "--to", "-t",
    "to_station",
    required=True,
    type=click.Choice(["staging", "canary", "production"]),
    help="Station to promote to",
)
@click.option(
    "--witness", "-w",
    multiple=True,
    help="Witnesses to the coronation",
)
def crown(holding_id: str, to_station: str, witness: tuple):
    """Crown a holding - promote it to a new station."""
    from data_kingdom.court import Court
    from data_kingdom.court.judge import CoronationDenied
    from data_kingdom.ledger import Station

    storage = get_storage()

    try:
        holding = storage.read(holding_id)
    except RecordNotFound:
        console.print(f"[red]Holding not found: {holding_id}[/red]")
        return

    if not isinstance(holding, HoldingRecord):
        console.print(f"[red]{holding_id} is not a holding[/red]")
        return

    # Map string to Station enum
    station_map = {
        "staging": Station.STAGING,
        "canary": Station.CANARY,
        "production": Station.PRODUCTION,
    }
    target_station = station_map[to_station]

    the_court = Court(storage)

    # Check if allowed
    allowed, reason = the_court.may_crown(holding, target_station)

    if not allowed:
        console.print(
            Panel(
                f"[bold]Holding:[/bold] {holding.name} v{holding.version}\n"
                f"[bold]Current Station:[/bold] {holding.current_station.value}\n"
                f"[bold]Target Station:[/bold] {to_station}\n\n"
                f"[red]Denied:[/red] {reason}",
                title="Coronation Denied",
                border_style="red",
            )
        )
        return

    # Get the current station as string
    current_station_str = (
        holding.current_station.value
        if hasattr(holding.current_station, "value")
        else holding.current_station
    )

    try:
        coronation = the_court.crown(
            holding,
            target_station,
            witnesses=list(witness),
        )

        console.print(
            Panel(
                f"[bold]Holding:[/bold] {holding.name} v{holding.version}\n"
                f"[bold]Promoted:[/bold] {current_station_str} → {to_station}\n"
                f"[bold]Coronation ID:[/bold] {coronation.id}\n"
                f"[bold]Witnesses:[/bold] {', '.join(witness) if witness else 'none'}",
                title="Coronation Complete",
                border_style="cyan",
            )
        )

    except CoronationDenied as e:
        console.print(f"[red]Coronation denied: {e}[/red]")


# =============================================================================
# PATTERN COMMANDS
# =============================================================================


@main.group()
def pattern():
    """Manage Pattern Books (blessed templates for work)."""
    pass


@pattern.command("list")
@click.option("--tag", "-t", default=None, help="Filter by tag")
@click.option("--type", "-T", "holding_type", default=None, help="Filter by holding type")
def pattern_list(tag: Optional[str], holding_type: Optional[str]):
    """List available Pattern Books."""
    from data_kingdom.pattern import PatternRegistry

    registry = PatternRegistry(get_kingdom_root())

    if tag:
        patterns = registry.list_by_tag(tag)
    elif holding_type:
        patterns = registry.list_by_holding_type(holding_type)
    else:
        patterns = registry.list_all()

    if not patterns:
        console.print("[dim]No patterns found[/dim]")
        return

    table = Table(title="Pattern Books", show_header=True)
    table.add_column("Name", style="cyan")
    table.add_column("Version")
    table.add_column("Description")
    table.add_column("Type")
    table.add_column("Trials")
    table.add_column("Tags")

    for p in patterns:
        table.add_row(
            p.name,
            p.version,
            p.description[:40] + "..." if len(p.description) > 40 else p.description,
            p.holding_type,
            str(len(p.mandatory_trials)),
            ", ".join(p.tags[:3]),
        )

    console.print(table)


@pattern.command("show")
@click.argument("pattern_name")
def pattern_show(pattern_name: str):
    """Show details of a Pattern Book."""
    from data_kingdom.pattern import PatternRegistry
    from data_kingdom.pattern.registry import PatternNotFound

    registry = PatternRegistry(get_kingdom_root())

    try:
        p = registry.get(pattern_name)
    except PatternNotFound as e:
        console.print(f"[red]{e}[/red]")
        return

    # Header
    console.print()
    console.print(Panel(
        f"[bold]Description:[/bold] {p.description}\n"
        f"[bold]Version:[/bold] {p.version}\n"
        f"[bold]Holding Type:[/bold] {p.holding_type}\n"
        f"[bold]Owner:[/bold] {p.owner or 'unspecified'}",
        title=f"Pattern Book: {p.name}",
        border_style="blue",
    ))

    # Required inputs
    if p.required_inputs:
        console.print("\n[bold]Required Inputs:[/bold]")
        for inp in p.required_inputs:
            console.print(f"  - {inp}")

    # Workshops
    if p.workshops:
        console.print("\n[bold]Workshops:[/bold]")
        table = Table(show_header=True, box=None)
        table.add_column("Step", style="cyan")
        table.add_column("Type")
        table.add_column("Craft", style="magenta")
        table.add_column("Description")
        table.add_column("Trials After")

        for w in p.workshops:
            table.add_row(
                w.name,
                w.type.value,
                w.craft or "auto",
                w.description or "",
                ", ".join(w.trials_after) if w.trials_after else "-",
            )

        console.print(table)

    # Trials
    console.print("\n[bold]Mandatory Trials:[/bold]")
    for trial in p.mandatory_trials:
        console.print(f"  - {trial}")

    # Promotion path
    console.print("\n[bold]Promotion Path:[/bold]")
    path = " → ".join(p.promotion.stations)
    console.print(f"  {path}")

    if p.promotion.canary_duration:
        console.print(f"  [dim]Canary: {p.promotion.canary_duration} at {p.promotion.canary_percentage}%[/dim]")

    # Rollback
    console.print("\n[bold]Rollback:[/bold]")
    console.print(f"  Strategy: {p.rollback.strategy.value}")
    console.print(f"  Triggers: {', '.join(t.value for t in p.rollback.triggers)}")

    # Requirements
    console.print("\n[bold]Requirements:[/bold]")
    console.print(f"  Treaty required: {'yes' if p.requires_treaty else 'no'}")
    console.print(f"  Golden questions required: {'yes' if p.requires_golden_questions else 'no'}")


@pattern.command("validate")
@click.argument("pattern_name")
@click.option("--realm", "-r", required=True, help="Realm to validate against")
def pattern_validate(pattern_name: str, realm: str):
    """Validate if a pattern can be used in a realm."""
    from data_kingdom.pattern import PatternRegistry

    registry = PatternRegistry(get_kingdom_root())

    allowed, reason = registry.validate_for_realm(pattern_name, realm)

    if allowed:
        console.print(f"[green]Pattern '{pattern_name}' is allowed in realm '{realm}'[/green]")
    else:
        console.print(f"[red]{reason}[/red]")


# =============================================================================
# REALM COMMANDS
# =============================================================================


@main.group()
def realm():
    """Manage Realms (feudal territories)."""
    pass


@realm.command("list")
def realm_list():
    """List all realms in the Kingdom."""
    from data_kingdom.realm import RealmRegistry

    registry = RealmRegistry(get_kingdom_root())

    realms = registry.list_realms()

    if not realms:
        console.print("[dim]No realms found. Create one with 'dk realm init'[/dim]")
        return

    table = Table(title="Realms", show_header=True)
    table.add_column("Name", style="cyan")
    table.add_column("Ruler")
    table.add_column("Fiefs")
    table.add_column("Treaties")
    table.add_column("Status")

    for r in realms:
        treaty_count = len(registry.list_treaties(r.name))
        status_str = r.status.value if hasattr(r.status, "value") else str(r.status)
        status_color = "green" if status_str == "active" else "yellow"

        table.add_row(
            r.name,
            r.ruler,
            str(len(r.fiefs)),
            str(treaty_count),
            f"[{status_color}]{status_str}[/{status_color}]",
        )

    console.print(table)


@realm.command("show")
@click.argument("realm_name")
def realm_show(realm_name: str):
    """Show details of a realm."""
    from data_kingdom.realm import RealmRegistry
    from data_kingdom.realm.registry import RealmNotFound

    registry = RealmRegistry(get_kingdom_root())

    try:
        r = registry.get_realm(realm_name)
    except RealmNotFound as e:
        console.print(f"[red]{e}[/red]")
        return

    # Header
    console.print()
    status_color = "green" if r.status == "active" else "yellow"
    console.print(Panel(
        f"[bold]Description:[/bold] {r.description or 'No description'}\n"
        f"[bold]Ruler:[/bold] {r.ruler}\n"
        f"[bold]Stewards:[/bold] {', '.join(r.stewards) if r.stewards else 'none'}\n"
        f"[bold]Status:[/bold] [{status_color}]{r.status}[/{status_color}]",
        title=f"Realm: {r.name}",
        border_style="blue",
    ))

    # Fiefs
    if r.fiefs:
        console.print("\n[bold]Fiefs:[/bold]")
        for fief in r.fiefs:
            owner = f" ({fief.owner})" if fief.owner else ""
            console.print(f"  - {fief.name}{owner}")

    # Laws
    if r.laws:
        console.print("\n[bold]Laws:[/bold]")
        for law in r.laws:
            console.print(f"  - {law}")

    # Treaties
    treaties = registry.list_treaties(realm_name)
    if treaties:
        console.print("\n[bold]Treaties:[/bold]")
        for t in treaties:
            public = " [public]" if t.public else ""
            console.print(f"  - {t.name} v{t.version}{public}")

    # Dependencies
    deps = registry.get_realm_dependencies(realm_name)
    if deps:
        console.print("\n[bold]Dependencies:[/bold]")
        for dep in deps:
            status = "[green]granted[/green]" if dep["granted"] else "[red]denied[/red]"
            console.print(f"  - {dep['realm']}.{dep['treaty']} ({status})")


@realm.command("init")
@click.argument("realm_name")
@click.option("--ruler", "-r", required=True, help="Who rules this realm")
@click.option("--description", "-d", default="", help="Realm description")
def realm_init(realm_name: str, ruler: str, description: str):
    """Initialize a new realm."""
    from data_kingdom.realm import RealmRegistry

    registry = RealmRegistry(get_kingdom_root())

    if registry.realm_exists(realm_name):
        console.print(f"[yellow]Realm '{realm_name}' already exists[/yellow]")
        return

    path = registry.initialize_realm(realm_name, ruler, description)

    console.print(Panel(
        f"[bold]Realm:[/bold] {realm_name}\n"
        f"[bold]Ruler:[/bold] {ruler}\n"
        f"[bold]Path:[/bold] {path}",
        title="Realm Initialized",
        border_style="green",
    ))


# =============================================================================
# TREATY COMMANDS
# =============================================================================


@main.group()
def treaty():
    """Manage Treaties (public interfaces between realms)."""
    pass


@treaty.command("list")
@click.option("--realm", "-r", "realm_name", default=None, help="Filter by realm")
@click.option("--public", "-p", is_flag=True, help="Show only public treaties")
def treaty_list(realm_name: Optional[str], public: bool):
    """List treaties."""
    from data_kingdom.realm import RealmRegistry

    registry = RealmRegistry(get_kingdom_root())

    if realm_name:
        treaties = registry.list_treaties(realm_name)
    else:
        treaties = registry.list_all_treaties()

    if public:
        treaties = [t for t in treaties if t.public]

    if not treaties:
        console.print("[dim]No treaties found[/dim]")
        return

    table = Table(title="Treaties", show_header=True)
    table.add_column("Name", style="cyan")
    table.add_column("Version")
    table.add_column("Realm")
    table.add_column("Public")
    table.add_column("Grants")
    table.add_column("Freshness")

    for t in treaties:
        public_str = "[green]yes[/green]" if t.public else "no"
        grants = len(t.granted_to) if not t.public else "all"

        table.add_row(
            t.name,
            t.version,
            t.realm,
            public_str,
            str(grants),
            t.guarantees.freshness,
        )

    console.print(table)


@treaty.command("show")
@click.argument("realm_name")
@click.argument("treaty_name")
def treaty_show(realm_name: str, treaty_name: str):
    """Show details of a treaty."""
    from data_kingdom.realm import RealmRegistry
    from data_kingdom.realm.registry import RealmNotFound, TreatyNotFound

    registry = RealmRegistry(get_kingdom_root())

    try:
        t = registry.get_treaty(realm_name, treaty_name)
    except (RealmNotFound, TreatyNotFound) as e:
        console.print(f"[red]{e}[/red]")
        return

    # Header
    console.print()
    public_str = "[green]PUBLIC[/green]" if t.public else "[yellow]RESTRICTED[/yellow]"
    console.print(Panel(
        f"[bold]Version:[/bold] {t.version}\n"
        f"[bold]Realm:[/bold] {t.realm}\n"
        f"[bold]Fief:[/bold] {t.fief or 'none'}\n"
        f"[bold]Access:[/bold] {public_str}\n"
        f"[bold]Owner:[/bold] {t.owner or 'unspecified'}",
        title=f"Treaty: {t.name}",
        border_style="cyan",
    ))

    # Semantic definition
    if t.definition:
        console.print("\n[bold]Definition:[/bold]")
        console.print(Panel(t.definition.strip(), border_style="dim"))

    # Schema
    if t.schema_columns:
        console.print("\n[bold]Schema:[/bold]")
        table = Table(show_header=True, box=None)
        table.add_column("Column", style="cyan")
        table.add_column("Type")
        table.add_column("Nullable")
        table.add_column("Description")

        for col in t.schema_columns:
            nullable = "yes" if col.nullable else "no"
            table.add_row(
                col.name,
                col.type,
                nullable,
                (col.description or "")[:40],
            )

        console.print(table)

    # Golden questions
    if t.golden_questions:
        console.print("\n[bold]Golden Questions:[/bold]")
        for gq in t.golden_questions:
            console.print(f"  - {gq.question}")
            console.print(f"    Expected: {gq.expected} (±{gq.tolerance:.0%})")

    # Guarantees
    console.print("\n[bold]Guarantees:[/bold]")
    console.print(f"  Freshness: {t.guarantees.freshness}")
    console.print(f"  Availability: {t.guarantees.availability}")
    if t.guarantees.backfill_policy:
        console.print(f"  Backfill: {t.guarantees.backfill_policy}")

    # Grants
    if not t.public and t.granted_to:
        console.print("\n[bold]Granted To:[/bold]")
        for grant in t.granted_to:
            fief_str = f".{grant.fief}" if grant.fief else ""
            console.print(f"  - {grant.realm}{fief_str}")


@treaty.command("check")
@click.argument("requesting_realm")
@click.argument("target_realm")
@click.argument("treaty_name")
def treaty_check(requesting_realm: str, target_realm: str, treaty_name: str):
    """Check if a realm can access a treaty (border control)."""
    from data_kingdom.realm import RealmRegistry

    registry = RealmRegistry(get_kingdom_root())

    allowed, reason = registry.check_access(
        requesting_realm, target_realm, treaty_name
    )

    if allowed:
        console.print(
            f"[green]Access GRANTED: '{requesting_realm}' can depend on "
            f"'{target_realm}.{treaty_name}'[/green]"
        )
        console.print(f"[dim]Reason: {reason}[/dim]")
    else:
        console.print(
            f"[red]Access DENIED: '{requesting_realm}' cannot depend on "
            f"'{target_realm}.{treaty_name}'[/red]"
        )
        console.print(f"[dim]Reason: {reason}[/dim]")


@treaty.command("dependents")
@click.argument("realm_name")
@click.argument("treaty_name")
def treaty_dependents(realm_name: str, treaty_name: str):
    """Show realms that depend on a treaty."""
    from data_kingdom.realm import RealmRegistry
    from data_kingdom.realm.registry import TreatyNotFound

    registry = RealmRegistry(get_kingdom_root())

    try:
        dependents = registry.get_treaty_dependents(realm_name, treaty_name)
    except TreatyNotFound as e:
        console.print(f"[red]{e}[/red]")
        return

    if not dependents:
        console.print(f"[dim]No realms depend on {realm_name}.{treaty_name}[/dim]")
        return

    console.print(f"[bold]Realms that can depend on {realm_name}.{treaty_name}:[/bold]")
    for dep in dependents:
        console.print(f"  - {dep}")


# =============================================================================
# GUILD COMMANDS
# =============================================================================


@main.group()
def guild():
    """Manage Guilds (specialized workers for campaigns)."""
    pass


@guild.command("crafts")
def guild_crafts():
    """List available crafts (specializations)."""
    from data_kingdom.guild.models import Craft, CRAFT_DESCRIPTIONS

    table = Table(title="Guild Crafts", show_header=True)
    table.add_column("Craft", style="cyan")
    table.add_column("Description")

    for craft in Craft:
        desc = CRAFT_DESCRIPTIONS.get(craft, "")
        # Truncate description
        short_desc = desc.split(".")[0] if desc else craft.value
        table.add_row(craft.value, short_desc)

    console.print(table)


@guild.command("summon")
@click.argument("campaign_id")
@click.option(
    "--craft", "-c",
    type=click.Choice([c.value for c in __import__("data_kingdom.guild.models", fromlist=["Craft"]).Craft]),
    default=None,
    help="Craft to summon (auto-detected if not specified)",
)
@click.option("--task", "-t", required=True, help="Task for the guild member")
@click.option("--background", "-b", is_flag=True, help="Run in background")
def guild_summon(campaign_id: str, craft: Optional[str], task: str, background: bool):
    """Summon a guild member to work on a campaign task."""
    from data_kingdom.guild import GuildSpawner, Craft
    from data_kingdom.guild.spawner import SpawnError

    storage = get_storage()

    # Verify campaign exists
    try:
        campaign = storage.read(campaign_id)
    except RecordNotFound:
        console.print(f"[red]Campaign not found: {campaign_id}[/red]")
        return

    spawner = GuildSpawner(get_kingdom_root())

    # Determine craft
    if craft:
        craft_enum = Craft(craft)
    else:
        craft_enum = spawner.get_craft_for_task(task)
        console.print(f"[dim]Auto-selected craft: {craft_enum.value}[/dim]")

    try:
        member = spawner.summon(
            campaign_id=campaign_id,
            craft=craft_enum,
            task=task,
            background=background,
        )

        console.print(Panel(
            f"[bold]Member ID:[/bold] {member.id}\n"
            f"[bold]Craft:[/bold] {member.craft.value}\n"
            f"[bold]Campaign:[/bold] {campaign_id}\n"
            f"[bold]Task:[/bold] {task}\n"
            f"[bold]Post:[/bold] {member.post_id}\n"
            f"[bold]Status:[/bold] [green]{member.status.value}[/green]",
            title="Guild Member Summoned",
            border_style="magenta",
        ))

        if not background and member.metadata and "command" in member.metadata:
            console.print("\n[bold]To start the agent, run:[/bold]")
            console.print(f"  {' '.join(member.metadata['command'])}")

    except SpawnError as e:
        console.print(f"[red]Failed to summon: {e}[/red]")


@guild.command("list")
@click.option("--campaign", "-c", default=None, help="Filter by campaign")
@click.option("--all", "-a", "show_all", is_flag=True, help="Show all members (including dismissed)")
def guild_list(campaign: Optional[str], show_all: bool):
    """List guild members."""
    from data_kingdom.guild import GuildSpawner

    spawner = GuildSpawner(get_kingdom_root())

    if show_all:
        members = spawner.list_all()
    else:
        members = spawner.list_active(campaign)

    if not members:
        console.print("[dim]No guild members found[/dim]")
        return

    table = Table(title="Guild Members", show_header=True)
    table.add_column("ID", style="cyan")
    table.add_column("Craft")
    table.add_column("Campaign")
    table.add_column("Task")
    table.add_column("Status")

    status_colors = {
        "active": "green",
        "idle": "yellow",
        "blocked": "red",
        "dismissed": "dim",
        "summoning": "blue",
    }

    for m in members:
        color = status_colors.get(m.status.value, "white")
        table.add_row(
            m.id,
            m.craft.value,
            m.campaign_id[:20],
            m.task[:30] + "..." if len(m.task) > 30 else m.task,
            f"[{color}]{m.status.value}[/{color}]",
        )

    console.print(table)


@guild.command("posts")
@click.argument("campaign_id")
def guild_posts(campaign_id: str):
    """List posts (workspaces) for a campaign."""
    from data_kingdom.guild import PostMaster

    post_master = PostMaster(get_kingdom_root())

    posts = post_master.list_for_campaign(campaign_id)

    if not posts:
        console.print(f"[dim]No posts found for campaign {campaign_id}[/dim]")
        return

    table = Table(title=f"Posts for {campaign_id}", show_header=True)
    table.add_column("ID", style="cyan")
    table.add_column("Craft")
    table.add_column("Current Task")
    table.add_column("Completed")
    table.add_column("Path")

    for p in posts:
        table.add_row(
            p.id,
            p.craft.value,
            p.current_task[:25] + "..." if p.current_task and len(p.current_task) > 25 else (p.current_task or "-"),
            str(len(p.completed_tasks)),
            p.path[-40:] if len(p.path) > 40 else p.path,
        )

    console.print(table)


@guild.command("notes")
@click.argument("post_id")
def guild_notes(post_id: str):
    """Show notes from a post."""
    from data_kingdom.guild import PostMaster
    from data_kingdom.guild.post_master import PostNotFound

    post_master = PostMaster(get_kingdom_root())

    try:
        notes = post_master.get_notes(post_id)
    except PostNotFound:
        console.print(f"[red]Post not found: {post_id}[/red]")
        return

    if not notes:
        console.print("[dim]No notes at this post[/dim]")
        return

    console.print(Panel(notes, title=f"Notes: {post_id}", border_style="dim"))


@guild.command("dismiss")
@click.argument("member_id")
@click.option("--reason", "-r", default="manual dismissal", help="Reason for dismissal")
@click.option(
    "--outcome", "-o",
    type=click.Choice(["completed", "failed", "manual"]),
    default="manual",
    help="Outcome of the work",
)
def guild_dismiss(member_id: str, reason: str, outcome: str):
    """Dismiss a guild member."""
    from data_kingdom.guild import GuildSpawner

    spawner = GuildSpawner(get_kingdom_root())

    try:
        dismissal = spawner.dismiss(member_id, reason, outcome)

        console.print(Panel(
            f"[bold]Member:[/bold] {member_id}\n"
            f"[bold]Reason:[/bold] {reason}\n"
            f"[bold]Outcome:[/bold] {outcome}\n"
            f"[bold]Tasks Completed:[/bold] {len(dismissal.tasks_completed)}",
            title="Guild Member Dismissed",
            border_style="yellow",
        ))

    except ValueError as e:
        console.print(f"[red]{e}[/red]")


if __name__ == "__main__":
    main()
