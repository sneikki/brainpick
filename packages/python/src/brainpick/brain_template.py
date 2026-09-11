"""`brainpick init --template brain` (spec/85): scaffold a format-2 brain.

The files are the canonical tree integrations/brain-template/, shipped as package data
and synced by scripts/sync-brain-template.mjs; `{{today}}` and `{{bundle_id}}` are the
only placeholders. Nothing that exists is overwritten: an existing henxels.yaml gets
the brain contract as a fragment to paste instead.
"""
from __future__ import annotations

from pathlib import Path

TEMPLATES = ("brain",)
CONTRACT = "henxels.yaml"
FRAGMENT_MARKER = "  # --- the brainpick brain"
GITIGNORE_ENTRIES = ("_temp/", "brainpick.local.toml", ".brainpick/", "_todo.md")


def template_root() -> Path:
    """The shipped template: the package copy first (installed wheels), then the
    repo-root canonical (dev checkout)."""
    packaged = Path(__file__).resolve().parent / "_brain_template"
    if packaged.is_dir():
        return packaged
    return Path(__file__).resolve().parents[4] / "integrations" / "brain-template"


def template_files() -> list[str]:
    """Every file the template writes, as sorted bundle-relative POSIX paths."""
    base = template_root()
    return sorted(p.relative_to(base).as_posix() for p in base.rglob("*") if p.is_file())


def contract_fragment() -> str:
    """The brain rules of the template contract, to paste into an existing henxels.yaml."""
    text = (template_root() / CONTRACT).read_text(encoding="utf-8")
    return text[text.index(FRAGMENT_MARKER):]


def _ensure_gitignored(root: Path) -> str | None:
    """Append the missing entries to .gitignore: "created", "appended" or None."""
    gitignore = root / ".gitignore"
    existing = gitignore.read_text(encoding="utf-8") if gitignore.is_file() else None
    lines = {line.strip() for line in (existing or "").splitlines()}
    missing = [entry for entry in GITIGNORE_ENTRIES if entry not in lines and entry.rstrip("/") not in lines]
    if not missing:
        return None
    separator = "" if not existing or existing.endswith("\n") else "\n"
    with gitignore.open("w", encoding="utf-8", newline="") as handle:
        handle.write((existing or "") + separator + "".join(entry + "\n" for entry in missing))
    return "appended" if existing is not None else "created"


def scaffold_brain(root: Path, today: str, bundle_id: str) -> dict:
    """Write the template into `root`. Returns {"written", "existing"} (template paths),
    "gitignore" ("created" | "appended" | None) and "fragment" (the contract to paste
    when henxels.yaml already existed, else None)."""
    base = template_root()
    written: list[str] = []
    existing: list[str] = []
    for rel in template_files():
        target = root / rel
        if target.exists():
            existing.append(rel)
            continue
        text = (base / rel).read_text(encoding="utf-8")
        text = text.replace("{{today}}", today).replace("{{bundle_id}}", bundle_id)
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("w", encoding="utf-8", newline="") as handle:
            handle.write(text)
        written.append(rel)
    return {
        "written": written,
        "existing": existing,
        "gitignore": _ensure_gitignored(root),
        "fragment": contract_fragment() if CONTRACT in existing else None,
    }
