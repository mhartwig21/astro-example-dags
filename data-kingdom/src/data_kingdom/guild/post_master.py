"""
Post Master

Manages Posts - the persistent workspaces for Guild members.

Posts are the key to reliable multi-agent work:
- They survive agent crashes
- They store state between agent sessions
- They provide resume capability

Posts are stored in:
    .posts/
    ├── {campaign_id}/
    │   ├── {craft}-{sequence}/
    │   │   ├── post.yaml          # Post metadata
    │   │   ├── notes.md           # Agent notes
    │   │   ├── session.txt        # Claude session ID
    │   │   └── workspace/         # Working files
    │   └── ...
    └── ...
"""

import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

import yaml

from data_kingdom.guild.models import Post, Craft
from data_kingdom.ledger.ids import generate_id


class PostNotFound(Exception):
    """Raised when a post cannot be found."""

    pass


class PostMaster:
    """
    Manages Posts for Guild members.

    The PostMaster creates, tracks, and cleans up posts.
    Posts are persistent - they survive agent restarts.
    """

    POSTS_DIR = ".posts"

    def __init__(self, kingdom_root: Path | str):
        """
        Initialize the PostMaster.

        Args:
            kingdom_root: Root directory of the Kingdom
        """
        self.kingdom_root = Path(kingdom_root)
        self.posts_dir = self.kingdom_root / self.POSTS_DIR

    def _ensure_posts_dir(self) -> None:
        """Ensure the posts directory exists."""
        self.posts_dir.mkdir(parents=True, exist_ok=True)

    def _get_campaign_dir(self, campaign_id: str) -> Path:
        """Get the directory for a campaign's posts."""
        # Sanitize campaign ID for filesystem
        safe_id = campaign_id.replace(".", "_").replace("/", "_")
        return self.posts_dir / safe_id

    def _get_post_dir(self, campaign_id: str, craft: Craft, sequence: int) -> Path:
        """Get the directory for a specific post."""
        campaign_dir = self._get_campaign_dir(campaign_id)
        return campaign_dir / f"{craft.value}-{sequence}"

    def _count_craft_posts(self, campaign_id: str, craft: Craft) -> int:
        """Count existing posts for a craft in a campaign."""
        campaign_dir = self._get_campaign_dir(campaign_id)
        if not campaign_dir.exists():
            return 0

        count = 0
        for path in campaign_dir.iterdir():
            if path.is_dir() and path.name.startswith(f"{craft.value}-"):
                count += 1

        return count

    def establish(
        self,
        campaign_id: str,
        craft: Craft,
        task: Optional[str] = None,
    ) -> Post:
        """
        Establish a new Post for a Guild member.

        Args:
            campaign_id: Campaign the post belongs to
            craft: Craft of the member
            task: Initial task (optional)

        Returns:
            The created Post
        """
        self._ensure_posts_dir()

        # Determine sequence number
        sequence = self._count_craft_posts(campaign_id, craft) + 1

        # Create post directory
        post_dir = self._get_post_dir(campaign_id, craft, sequence)
        post_dir.mkdir(parents=True, exist_ok=True)
        (post_dir / "workspace").mkdir(exist_ok=True)

        # Generate post ID
        post_id = f"post-{generate_id('p')[3:]}"  # e.g., "post-a1b2"

        # Create post
        post = Post(
            id=post_id,
            campaign_id=campaign_id,
            craft=craft,
            path=str(post_dir),
            current_task=task,
        )

        # Save post metadata
        self._save_post(post)

        # Initialize notes file
        notes_file = post_dir / "notes.md"
        notes_file.write_text(
            f"# Post Notes: {craft.value}\n\n"
            f"Campaign: {campaign_id}\n"
            f"Established: {post.created_at.isoformat()}\n\n"
            "---\n\n"
            "## Notes\n\n"
            "*Leave notes here for future agents who may take over this post.*\n\n"
        )

        return post

    def _save_post(self, post: Post) -> None:
        """Save post metadata to disk."""
        post_dir = Path(post.path)
        post_file = post_dir / "post.yaml"

        data = post.model_dump(mode="json")
        with open(post_file, "w") as f:
            yaml.dump(data, f, default_flow_style=False)

    def _load_post(self, post_dir: Path) -> Post:
        """Load a post from disk."""
        post_file = post_dir / "post.yaml"

        if not post_file.exists():
            raise PostNotFound(f"Post file not found: {post_file}")

        with open(post_file) as f:
            data = yaml.safe_load(f)

        return Post(**data)

    def get(self, post_id: str) -> Post:
        """
        Get a post by ID.

        Args:
            post_id: Post ID

        Returns:
            The Post

        Raises:
            PostNotFound: If post doesn't exist
        """
        # Search all campaign directories for the post
        if not self.posts_dir.exists():
            raise PostNotFound(f"Post not found: {post_id}")

        for campaign_dir in self.posts_dir.iterdir():
            if not campaign_dir.is_dir():
                continue

            for post_dir in campaign_dir.iterdir():
                if not post_dir.is_dir():
                    continue

                try:
                    post = self._load_post(post_dir)
                    if post.id == post_id:
                        return post
                except Exception:
                    continue

        raise PostNotFound(f"Post not found: {post_id}")

    def list_for_campaign(self, campaign_id: str) -> list[Post]:
        """List all posts for a campaign."""
        campaign_dir = self._get_campaign_dir(campaign_id)

        if not campaign_dir.exists():
            return []

        posts = []
        for post_dir in campaign_dir.iterdir():
            if not post_dir.is_dir():
                continue

            try:
                post = self._load_post(post_dir)
                posts.append(post)
            except Exception:
                continue

        return posts

    def list_by_craft(self, campaign_id: str, craft: Craft) -> list[Post]:
        """List posts for a specific craft in a campaign."""
        all_posts = self.list_for_campaign(campaign_id)
        return [p for p in all_posts if p.craft == craft]

    def update(self, post: Post) -> None:
        """Update a post's metadata."""
        post.last_active = datetime.now(timezone.utc)
        self._save_post(post)

    def add_note(self, post_id: str, note: str, author: str = "agent") -> None:
        """
        Add a note to a post.

        Notes persist across agent sessions, providing
        continuity for future agents.
        """
        post = self.get(post_id)
        post_dir = Path(post.path)

        # Add to notes file
        notes_file = post_dir / "notes.md"
        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M")

        with open(notes_file, "a") as f:
            f.write(f"\n### [{timestamp}] {author}\n\n{note}\n")

        # Add to post object
        post.notes.append(f"[{timestamp}] {author}: {note}")
        self._save_post(post)

    def get_notes(self, post_id: str) -> str:
        """Get all notes for a post."""
        post = self.get(post_id)
        notes_file = Path(post.path) / "notes.md"

        if notes_file.exists():
            return notes_file.read_text()

        return ""

    def save_session(self, post_id: str, session_id: str) -> None:
        """Save a Claude session ID for resume capability."""
        post = self.get(post_id)
        post.session_id = session_id

        # Also save to session file
        session_file = Path(post.path) / "session.txt"
        session_file.write_text(session_id)

        self._save_post(post)

    def get_session(self, post_id: str) -> Optional[str]:
        """Get the saved session ID for a post."""
        post = self.get(post_id)

        if post.session_id:
            return post.session_id

        # Try loading from file
        session_file = Path(post.path) / "session.txt"
        if session_file.exists():
            return session_file.read_text().strip()

        return None

    def mark_task_complete(self, post_id: str, task: str) -> None:
        """Mark a task as completed at a post."""
        post = self.get(post_id)
        post.completed_tasks.append(task)
        post.current_task = None
        self._save_post(post)

    def set_task(self, post_id: str, task: str) -> None:
        """Set the current task for a post."""
        post = self.get(post_id)
        post.current_task = task
        self._save_post(post)

    def abandon(self, post_id: str) -> None:
        """
        Abandon a post (mark it as no longer active).

        The post data is preserved for auditing, but
        no new agents should be assigned to it.
        """
        post = self.get(post_id)

        # Add abandonment note
        self.add_note(
            post_id,
            "Post abandoned",
            author="system",
        )

        # Could move to archive directory if desired
        # For now, just update metadata
        self._save_post(post)

    def cleanup_campaign(self, campaign_id: str, keep_notes: bool = True) -> None:
        """
        Clean up all posts for a completed campaign.

        Args:
            campaign_id: Campaign to clean up
            keep_notes: Whether to preserve notes files
        """
        campaign_dir = self._get_campaign_dir(campaign_id)

        if not campaign_dir.exists():
            return

        if keep_notes:
            # Just remove workspace directories, keep notes
            for post_dir in campaign_dir.iterdir():
                workspace = post_dir / "workspace"
                if workspace.exists():
                    shutil.rmtree(workspace)
        else:
            # Remove entire campaign directory
            shutil.rmtree(campaign_dir)
