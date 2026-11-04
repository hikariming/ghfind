"""ghfind — official Python SDK for https://ghfind.com.

Score any GitHub account 0-100 for value and trustworthiness (deterministic, no
LLM), plus roasts, battles, leaderboards, and developer discovery.

    from ghfind import GhFind
    gh = GhFind()
    print(gh.get_score("torvalds"))
"""

from .client import DEFAULT_HOST, GhFind, GhFindError
from .catalog import CATALOG, find_capability
from .types import TIER_KEY

__version__ = "0.2.0"

__all__ = [
    "GhFind",
    "GhFindError",
    "DEFAULT_HOST",
    "CATALOG",
    "find_capability",
    "TIER_KEY",
    "__version__",
]
