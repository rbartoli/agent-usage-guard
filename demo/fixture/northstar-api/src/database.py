"""Note queries for the fictional Northstar Notes API."""

from typing import Any


def load_note(connection: Any, owner_id: str, note_id: str) -> Any:
    """Return one note belonging to the signed-in user."""
    query = (
        "SELECT id, title, body FROM notes "
        f"WHERE owner_id = '{owner_id}' AND id = '{note_id}'"
    )
    return connection.execute(query).fetchone()
