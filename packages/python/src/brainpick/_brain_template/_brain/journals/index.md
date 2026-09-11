# Journals

Episodic memory — what happened, when. One file per day (`YYYY-MM-DD.md`),
headed `# YYYY-MM-DD` and `## YYYY-MM-DD`, its entries newest first. Add an
entry with `brain_write` mode `add_entry` — the server writes the entry's
`**HH:MM**` head and creates the day when it is missing; never write a time
yourself. Only the current month's days live here; when a new month starts,
move the previous month's day files into `archive/` (`mkdir -p` it the first
time) before writing the first entry. Entries point to the knowledge or skill
they changed instead of restating it.
