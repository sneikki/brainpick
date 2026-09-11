import * as fs from 'fs';
import * as path from 'path';

export const content = `<!-- markdownlint-disable -->
\`\`\`
   ╭────────────────────╮
   │      ●───●         │
   │     ╱ ╲ ╱ ╲        │   b r a i n p i c k
   │    ●───●───●       │   pick your agent's brain
   │     ╲ ╱ ╲ ╱ ⛏      │   plain markdown in · a living brain out
   │      ●───●         │
   ╰────────────────────╯
\`\`\`
<!-- markdownlint-enable -->

# brainpick

> **This is a fork.** [sneikki/brainpick](https://github.com/sneikki/brainpick)
> is Nuutti Varvikko's fork of
> [benquemax/brainpick](https://github.com/benquemax/brainpick), branched at
> 0.4.0 and developed on its own roadmap: useful concepts from upstream are
> re-implemented here, not merged. The \`brainpick\` package on PyPI, the
> release installers and the live demo are upstream's and do not carry this
> fork's changes — install the fork from git (see the quick start).

**A turn-key brain stack for AI agents — plain markdown in, a living
knowledge graph out.** Your agents' knowledge lives as an
[OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
bundle of plain markdown files — [henxels](https://github.com/benquemax/henxels)
keeps every writer true to the format — and brainpick compiles it into
tiered, disposable artifacts: a generated index, a link graph, semantic
vectors, an entity graph. Agents consume the compiled brain over
[MCP](https://modelcontextprotocol.io) and the CLI; everything is
local-first, deterministic wherever a model isn't needed, and no server is
ever required.

Humans get a separate, optional face: the **holographic brain**, a web UI
that renders the same compiled graph and updates live while agents write.
It is a window into the brain, never a dependency of it — see upstream's
[live demo](https://benquemax.github.io/brainpick/), its own docs compiled
and served by brainpick itself.
`;

export const validate = async () => {
  // TODO: Add validation for this section
  //
  // Based on this section's content, consider validating:
  // - Verify 'typescript' is in package.json devDependencies
  // - Check that mentioned file paths and directories actually exist
  // - Think creatively: what hidden rules, patterns, or standards should be validated?
  //
  // See .codumentation-guide.md for more validation patterns and examples
};

export const errorContent = `
[Validation Failed] The "intro" section validation failed.

Review this section and ensure the documentation matches the actual codebase state.
`;
