"""ghfind — official Python SDK for https://ghfind.com.

Score any GitHub account 0-100 for value and trustworthiness (deterministic, no
LLM), plus roasts, battles, leaderboards, and developer discovery.

    from ghfind import GhFind
    gh = GhFind()
    print(gh.get_score("torvalds"))
"""

from .client import DEFAULT_HOST, DEFAULT_WAIT_SECONDS, GhFind, GhFindError, GhFindPending
from .catalog import CATALOG, find_capability
from .types import TIER_KEY

__version__ = "0.1.0"

__all__ = [
    "GhFind",
    "GhFindError",
    "GhFindPending",
    "DEFAULT_HOST",
    "DEFAULT_WAIT_SECONDS",
    "CATALOG",
    "find_capability",
    "TIER_KEY",
    "__version__",
]
