---
name: build-mcp-exe
description: Repeatable workflow for building a privacy-preserving Windows Mobile MCP executable, configuring AI agents globally, and validating safe uninstall/dry-run behavior.
---

# Build Mobile MCP Windows EXE

Target repository: https://github.com/the-long-ride/mobile-mcp-build

Use this skill when requested to rebuild, upgrade, debug, or ship the Windows Mobile MCP executable or global agent installers. Do not ask the user to restate the pipeline.

## Required outcomes

- Windows x64 artifact includes mobile-mcp.exe and native mobilecli-windows-amd64.exe, with SHA256SUMS.txt.
- Built MCP server has no PostHog/Scarf calls, analytics events, or optional feedback submission tool.
- Set MOBILEMCP_DISABLE_TELEMETRY=1, MOBILEWRIGHT_DISABLE_TELEMETRY=1, DO_NOT_TRACK=1 for spawned processes as defense in depth. Audit newly added dependencies for independent outbound calls.
- Installer supports Claude Code, Codex, Antigravity and OpenCode. Aevra integration outputs manual instructions only.
- Install puts mobile-automation and build-mcp-exe skills under ~/.agents/skills and inserts delimited, reversible global agent instructions.
- Uninstall removes only owned, unchanged entries and files; keep existing files, other tools, and user edits.
- All installer subcommands implement --help and dry-run. Dry-run must perform zero writes.
- Installation changes are applied transactionally: preflight all destinations and roll back every applied file if a later operation fails.
- OpenCode uses the documented flat mcp object with type: local, command array and environment fields; accept JSONC without destroying comments.
- Maintain **one canonical copy** of each skill under `~/.agents/skills/<name>/SKILL.md`.
- For Claude Code and Antigravity, link the **skill directory**, never copy its `SKILL.md`. Use Windows NTFS directory **junctions** (Node `fs.symlinkSync(target, link, "junction")`), which normally work without Developer Mode or administrator rights. On Unix use directory symlinks.
- Do not link `~/.agents/skills` in its entirety: keep each named skill separately discoverable. Do not create redundant copies under agent-specific folders.
- Record owned link paths and canonical targets in the installer manifest. Uninstall only verified installer-owned links, with `fs.unlinkSync(link)`; never remove or follow the target directory. Preserve matching unowned links.
- On re-running install, migrate previous installer-owned duplicate skill directories to junctions **only** if ownership hash matches and the directory contains exactly one unmodified `SKILL.md`. Refuse to alter pre-existing unowned or modified folders.
- Treat link creation, removal, and migration as transaction steps with preflight, rollback, zero-write dry-run, and tests that confirm both directory target and link type.

## Procedure

1. Review the repository's current branch, source, history, dependencies, workflow, and build artifacts. Work in a new feature branch; never modify upstream without user authorization.
2. Maintain src/agent-setup.ts, src/index.ts, src/mobilecli.ts and src/server.ts. Do not reintroduce PostHog/Scarf tracking or raw tool argument/result logging.
3. Maintain .github/workflows/windows-exe.yml using windows-latest, Node 24, actions/checkout@v6, actions/setup-node@v6, actions/upload-artifact@v6, npm ci, npm run build, Bun --compile --target=bun-windows-x64 and the sidecar mobilecli-windows-amd64.exe from the pinned npm dependency.
4. Confirm mobilecli resolves beside the compiled EXE and that Windows device tools only depend on documented Windows prerequisites such as ADB and drivers.
5. Test: `mobile-mcp.exe --help`, `install --help`, `uninstall --help`, and `install|uninstall --agent all --dry-run`. Then execute installation and uninstallation in an isolated `MOBILE_MCP_SETUP_HOME` and verify normal MCP stdio handshake.
6. Test safety on populated configs: installation refuses pre-existing MCP entries; uninstallation preserves unrelated JSON/JSONC/TOML, comments and edited instructions. Inject failures mid-install and assert rollback. Assert agent-specific skill directories are junctions on Windows, resolve to canonical directories, uninstall removes **only** links, and migrating old owned copies is reversible. Tamper test an owned junction and verify uninstall refuses to follow it.
7. Inspect Windows GitHub Actions jobs and build logs after pushing, fix failures and rerun tests. Do not claim the build passed until the latest commit has a green run.
8. Validate SHA-256 checksums and archive contents. Use published workflow artifacts for distribution; executable itself is unsigned unless signing is explicitly configured.
9. Write upgrade/rebuild notes describing version pinning, native sidecar requirement and AI-provider privacy boundaries.
10. Work on the existing `build/private-windows-mcp-squashed` branch where possible. Keep **exactly one squashed commit** on top of the original `main` base, using an expected-SHA lease before a force update. Do not create PRs or change `main` unless requested.

## Notes

Do not confuse telemetry off with zero network access: agents can request URLs, cloud devices and remote provider traffic; native mobilecli may also have independent behavior. For complete assurance, inspect network traffic of the built artifact. Avoid connecting a personal phone while evaluating untrusted or unreviewed builds.

## Usage and troubleshooting

```powershell
.\mobile-mcp.exe install --agent all --dry-run
.\mobile-mcp.exe install --agent all
.\mobile-mcp.exe uninstall --agent all --dry-run
.\mobile-mcp.exe uninstall --agent all
```

The canonical directories are `~/.agents/skills/mobile-automation` and `~/.agents/skills/build-mcp-exe`. The agent-specific directories are `~/.claude/skills/<name>`, `~/.gemini/config/skills/<name>`, and `~/.gemini/antigravity-cli/skills/<name>`. On Windows inspect a link with `Get-Item -Force <path> | Format-List LinkType,Target`; on Unix use `readlink`. If the directory is not empty or ownership cannot be verified, stop and report a safe manual migration step instead of deleting user data. A junction is not a `.lnk` desktop shortcut; it is a filesystem directory link visible to agents.
