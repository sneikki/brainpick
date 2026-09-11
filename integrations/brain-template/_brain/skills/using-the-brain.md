---
type: playbook
title: Using the brain
description: Use when reading from or writing to this project's brain — before answering from memory, before grepping, and before adding or changing any doc in _brain/.
timestamp: {{today}}T00:00:00Z
depends_on: []
export: agent-skill
---

# Using the brain

`_brain/` is this project's memory. It is the **best knowledge available at
the moment, not the truth**: everything in it is provisional, and your job
when you notice a flaw is to fix the brain, not route around it.

## First: pull

**Before reading anything, pull the brain's latest version** (`git pull`
in the repo that holds it — every brain, if several are mounted). A brain
is shared memory: other agents and people commit to it between your
sessions, and an answer built on a stale checkout is built on knowledge
the brain has already corrected. Pull first, then read; if the pull brings
changes, re-read before acting on what you remembered.

## Reading: most distilled first

1. **The closest brain first.** If several brains are available (this
   project's, a team's, your personal one), the one closest to the
   implementation wins when they disagree.
2. **`skills/`** — actionable, tested procedures. The purest layer.
3. **`knowledge/`** — evergreen concepts, for the idea behind a skill or a
   fact no skill covers yet.
4. **`journals/`** — dated episodes, only when nothing distilled exists.
   One file per day, `journals/YYYY-MM-DD.md`; earlier months' days are in
   `journals/archive/`.
5. **`raw/`** — undistilled source material. Not in search results; grep it
   to ground a claim or to distil something new.

With brainpick: `brain_overview` first, then `brain_search`, then
`brain_read`. Grep only after the brain comes up short.

## Searching: one call, two inputs

`brain_search` takes two inputs because the brain has two engines that need
different text: keyword search matches tokens and finds identifiers,
semantic search matches meaning and finds paraphrases. A single string suits
one engine and starves the other:

- `situation` (required) — the episode in one or two full sentences: what
  you are doing, what happened, what you expected, which project. Feeds the
  semantic engine. A keyword list here finds nothing.
- `terms` (required, `[]` when nothing has a name yet) — identifiers
  verbatim: ticket ids, error strings as printed, function/env/flag/file
  names, proper nouns. Feeds the keyword engine. A sentence here matches
  only function words.

Search during the work, not only at the prompt: before reading code or
tickets from scratch, the moment an error or unexpected behaviour appears,
before choosing an approach, before writing to the brain. Hits are pointers:
`brain_read` every plausibly relevant hit before deciding it is not — a
journal hit is titled by its date, so judge it by the snippet and read the
entry with `brain_read(path, sections=["HH:MM"])`. On a miss, reformulate
once before concluding the memory does not exist.

## Writing: distil upward, point, ground

- **Write through `brain_write`**, never by editing files under `_brain/`:
  it checks the contract at write time, tells you exactly what to fix, and
  recompiles the brain.
- **Never write a time.** No `**HH:MM**` in a journal entry, no `timestamp`
  in a page: the server owns every clock and overwrites any time you send,
  because a model does not know the wall clock.
- **Journal with `add_entry`.** Send ONE entry, ``* `project` · type — text``
  with continuation lines indented two spaces, to today's
  `journals/YYYY-MM-DD.md`; the server heads it with its `**HH:MM**`, places
  it newest first and creates the day when missing. **When a new month
  starts, move last month's day files to `journals/archive/` first** — the
  contract blocks a commit with more than a month of day files.
- **Pages: the body in `content`, the frontmatter in `meta`.** On `create`
  send `type`, `title` and `description` as `meta`; on `replace` send the
  whole body and only the `meta` keys that change — the page keeps the rest
  of its frontmatter.
- **Information flows `journals/` → `knowledge/` → `skills/`.** An episode
  becomes a concept when it settles; a concept becomes a skill when it has
  been carried out and works.
- **DRY by pointer.** When you distil, the less distilled doc gains a
  pointer to the more distilled one ("now covered by [skill]") — never a
  copy. The journal points to what it changed and never restates it.
- **Raw stays clean.** Drop source material into `raw/` with a kebab-case
  name that says what it is, list it in `raw/index.md`, and clean up after
  yourself: prune what you have distilled or found worthless. Raw is
  valuable — it is what claims ground on — only while it stays greppable.
- **Ground every claim inline**, Wikipedia-style, with a plain link: a
  journal entry (a decision we made), an external page, another brain
  (`brain://slug-id/path`), or say in words that it is an assumption.
- **Reading a less distilled layer is a distillation opportunity.** If the
  answer was in the journal, ask whether it should now be knowledge.
- **Commit and push what you changed** (the contract checks it on commit)
  so the next reader's pull brings your version — memory that stays on one
  machine is not shared memory.

## Several brains: subsidiarity

When brains conflict: the closest wins. Update both. Then decide — keep the
information duplicated (readers of the farther brain may not have the
closer one) or replace it with a `brain://` pointer. Record the episode in
the journal of the brain that changed.

## Where this comes from

Evergreen concepts live in [Knowledge](../knowledge/index.md); what happened
and when, in the [Journals](../journals/index.md). The brain format and its
reasoning live in brainpick's wiki:
https://github.com/sneikki/brainpick/blob/main/docs/brain.md — data flow,
grounding, subsidiarity, and what is fixed for life versus cheap to change.
Serve this brain with `brainpick serve`, then the `brain_*` MCP tools.
