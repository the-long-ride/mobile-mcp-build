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
- All CLI subcommands implement --help and dry-run. Dry-run must perform zero writes.

## Procedure

1. Review the repository's current branch, source, history, dependencies, workflow, and build artifacts. Work in a new feature branch; never modify upstream without user authorization.
2. Maintain src/agent-setup.ts, src/index.ts, src/mobilecli.ts and src/server.ts. Do not reintroduce PostHog/Scarf tracking or raw tool argument/result logging.
3. Maintain .github/workflows/windows-exe.yml using windows-latest, Node 22, npm ci, npm run build, Bun --compile --target=bun-windows-x64 and the sidecar mobilecli-windows-amd64.exe from the pinned npm dependency.
4. Confirm mobilecli resolves beside the compiled EXE and that Windows device tools only depend on documented Windows prerequisites such as ADB and drivers.
5. Test: mobile-mcp.exe --help; mobile-mcp.exe install --help; mobile-mcp.exe uninstall --help; install/uninstall --agent all --dry-run; install/uninstall --agent all in an isolated temporary HOME.
6. Test safety on populated configs: installation refuses preexisting mobile-mcp entries; uninstallation preserves unrelated config and manually edited instructions; original files are not deleted.
7. Inspect the Windows CI workflow run and jobs after pushing/PR creation; repair build errors and rerun checks. Do not claim success before a green run.
8. Validate SHA-256 checksums and archive contents. Use published workflow artifacts for distribution; executable itself is unsigned unless signing is explicitly configured.
9. Write upgrade/rebuild notes describing version pinning, native sidecar requirement and AI-provider privacy boundaries.
10. Open a PR with proof of tests and operational caveats; do not auto-merge unless directed.

## Notes

Do not confuse telemetry off with zero network access: agents can request URLs, cloud devices and remote provider traffic; native mobilecli may also have independent behavior. For complete assurance, inspect network traffic of the built artifact. Avoid connecting a personal phone while evaluating untrusted or unreviewed builds.
