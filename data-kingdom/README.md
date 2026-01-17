# The Data Kingdom

A feudal operating system for building, governing, and evolving data products.

## Core Philosophy

> If it is not written in the Ledger, it did not happen.

The Data Kingdom is not a pipeline platform. It is not a DAG manager. It is a **governance-and-production system for meaning**.

## Quick Start

```bash
# Install
pip install -e .

# Initialize a new kingdom
dk init --git

# File a petition
dk petition "Create daily active users dataset" --realm analytics

# Launch a campaign
dk campaign launch dk-a1b2 --pattern public-holding

# Inspect the campaign (War Room view)
dk campaign inspect dk-a1b2.1

# View ledger history
dk ledger history
```

## Architecture

### The Kingdom Structure

- **The Crown** - Kingdom-level authority (global standards, courts, ledger)
- **Realms** - Major territories (e.g., Analytics, Ads, Integrity)
- **Fiefs** - Sub-territories within realms
- **Treaties** - Public interfaces between realms

### Ledger Records

Everything is recorded in the Great Ledger:

| Record Type | Purpose |
|-------------|---------|
| Petition | "We want this to exist" |
| Campaign | "We are attempting to make it so" |
| Holding | "This thing now exists" |
| Trial | "The Court examined it" |
| Coronation | "It is now law" |

### Campaigns

A Campaign is a bounded attempt to change reality. Campaigns:
- Pursue a goal
- Have scope and limits
- May succeed partially
- Always leave records

### The Court

The Court evaluates all work before promotion. It judges:
- Correctness
- Meaning (semantics)
- Safety
- Performance
- Stability

## License

MIT
