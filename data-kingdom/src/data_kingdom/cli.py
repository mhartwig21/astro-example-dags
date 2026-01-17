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


if __name__ == "__main__":
    main()
