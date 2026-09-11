// The query log (spec/70) writes under XDG state by default; tests and the servers they
// spawn log into a scratch dir instead of the developer's own (the twin of conftest.py).
import { join } from "node:path";

process.env["BRAINPICK_QUERY_LOG_DIR"] ??= join(__dirname, ".query-log-scratch");
