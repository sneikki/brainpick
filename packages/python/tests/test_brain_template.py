"""`brainpick init --template brain` (spec/85): the brain template lives in brainpick."""
import os
import sys
from pathlib import Path

import pytest

from brainpick.brain_template import contract_fragment, scaffold_brain, template_files, template_root
from brainpick.scaffold import run_init

from conftest import REPO_ROOT

CANONICAL = REPO_ROOT / "integrations" / "brain-template"
NO_BACKENDS = [("ollama", None), ("lm studio", None), ("llama.cpp", None)]
GITIGNORE = "_temp/\nbrainpick.local.toml\n.brainpick/\n_todo.md\n"


def canonical_files() -> list[str]:
    return sorted(p.relative_to(CANONICAL).as_posix() for p in CANONICAL.rglob("*") if p.is_file())


# -- one canonical tree, byte-identical shipped copy --------------------------------


def test_the_shipped_template_is_the_canonical_tree():
    assert template_files() == canonical_files()
    for rel in canonical_files():
        assert (template_root() / rel).read_bytes() == (CANONICAL / rel).read_bytes(), rel


def test_the_first_skill_never_asks_for_a_time():
    skill = (CANONICAL / "_brain" / "skills" / "using-the-brain.md").read_text(encoding="utf-8")
    assert "Never write a time" in skill
    assert "`add_entry`" in skill and "`meta`" in skill
    assert "Bump `timestamp`" not in skill and "YYYY-MM.md" not in skill


# -- the scaffold --------------------------------------------------------------------


def test_scaffold_writes_the_brain_and_never_overwrites(tmp_path):
    report = scaffold_brain(tmp_path, "2026-01-02", "fixturebrain000000000")
    assert report["written"] == template_files()
    assert report["existing"] == [] and report["fragment"] is None
    assert report["gitignore"] == "created"
    assert (tmp_path / ".gitignore").read_text(encoding="utf-8") == GITIGNORE
    for rel in template_files():
        assert "{{" not in (tmp_path / rel).read_text(encoding="utf-8"), rel
    assert 'id = "fixturebrain000000000"' in (tmp_path / "brainpick.toml").read_text(encoding="utf-8")
    skill = (tmp_path / "_brain" / "skills" / "using-the-brain.md").read_text(encoding="utf-8")
    assert "timestamp: 2026-01-02T00:00:00Z" in skill
    assert "## 2026-01-02" in (tmp_path / "_brain" / "log.md").read_text(encoding="utf-8")

    before = {rel: (tmp_path / rel).read_bytes() for rel in template_files()}
    again = scaffold_brain(tmp_path, "2030-12-31", "otherbrain00000000000")
    assert again["written"] == [] and again["existing"] == template_files()
    assert again["gitignore"] is None
    assert {rel: (tmp_path / rel).read_bytes() for rel in template_files()} == before


def test_an_existing_contract_gets_the_fragment_and_gitignore_is_appended(tmp_path):
    (tmp_path / "henxels.yaml").write_text("henxels: []\n", encoding="utf-8")
    (tmp_path / ".gitignore").write_text("node_modules/\n_temp/", encoding="utf-8")
    report = scaffold_brain(tmp_path, "2026-01-02", "fixturebrain000000000")
    assert (tmp_path / "henxels.yaml").read_text(encoding="utf-8") == "henxels: []\n"
    assert report["existing"] == ["henxels.yaml"]
    assert report["fragment"] == contract_fragment()
    assert report["fragment"].startswith("  # --- the brainpick brain")
    assert "One journal file per DAY" in report["fragment"]
    assert report["gitignore"] == "appended"
    assert (tmp_path / ".gitignore").read_text(encoding="utf-8") == (
        "node_modules/\n_temp/\nbrainpick.local.toml\n.brainpick/\n_todo.md\n"
    )


# -- init --template brain -----------------------------------------------------------


def test_init_template_brain_scaffolds_then_compiles(tmp_path, capsys):
    root = tmp_path / "repo"
    root.mkdir()
    assert run_init(root, template="brain", env={}, probes=NO_BACKENDS) == 0
    out = capsys.readouterr().out
    assert (root / "_brain" / "skills" / "using-the-brain.md").is_file()
    assert (root / "_brain" / ".brainpick" / "manifest.json").is_file()
    assert "brain: format 2" in out
    assert f"cd {root} && henxels init" in out  # not a git repository: the command is printed
    assert "Gate commits on a fresh brain" not in out  # the contract already carries the gate


def test_init_rejects_an_unknown_template(tmp_path, capsys):
    assert run_init(tmp_path, template="wiki", env={}, probes=NO_BACKENDS) == 1
    out = capsys.readouterr().out
    assert "unknown template 'wiki'" in out and "brain" in out
    assert list(tmp_path.iterdir()) == []


def test_init_template_dry_run_writes_nothing(tmp_path, capsys):
    assert run_init(tmp_path, template="brain", dry_run=True, env={}, probes=NO_BACKENDS) == 0
    assert "_brain/skills/using-the-brain.md" in capsys.readouterr().out
    assert list(tmp_path.iterdir()) == []


@pytest.mark.skipif(sys.platform == "win32", reason="a POSIX shell script stands in for henxels")
def test_init_template_runs_henxels_init_in_a_git_repository(tmp_path, capsys):
    root = tmp_path / "repo"
    (root / ".git").mkdir(parents=True)
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    calls = tmp_path / "calls"
    fake = bin_dir / "henxels"
    fake.write_text(f'#!/bin/sh\npwd > "{calls}"\necho "$@" >> "{calls}"\n', encoding="utf-8")
    fake.chmod(0o755)
    env = {"PATH": f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}"}
    assert run_init(root, template="brain", env=env, probes=NO_BACKENDS) == 0
    assert calls.read_text(encoding="utf-8").splitlines() == [str(root.resolve()), "init"]
    assert "henxels: hooks, schema and the AGENTS.md digest installed" in capsys.readouterr().out
    assert Path(root / "henxels.yaml").is_file()
