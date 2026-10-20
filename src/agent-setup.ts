import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export type Agent = "claude" | "codex" | "antigravity" | "opencode" | "aevra";
export type SetupAction = "install" | "uninstall";
export interface SetupOptions {
  agent: string;
  dryRun?: boolean;
  executable?: string;
}
interface RecordEntry {
  kind: "json" | "toml";
  configPath: string;
  instructionPath: string;
  executable: string;
  instructionSeparator?: string;
  instructionExisted?: boolean;
  configExisted?: boolean;
}
interface SetupState {
  schema: number;
  agents: Partial<Record<Agent, RecordEntry>>;
  skills: Record<string, string>;
}
type PlannedWrite = { file: string; content: string | null; description: string };

const HOME = process.env.MOBILE_MCP_SETUP_HOME ? path.resolve(process.env.MOBILE_MCP_SETUP_HOME) : os.homedir();
const STATE_PATH = path.join(HOME, ".config", "mobile-mcp-build", "installed.json");
const SKILL_DIR = path.join(HOME, ".agents", "skills");
const MARKER_START = "<!-- BEGIN mobile-mcp-build managed instructions -->";
const MARKER_END = "<!-- END mobile-mcp-build managed instructions -->";
const TOML_BEGIN = "# BEGIN mobile-mcp-build managed MCP";
const TOML_END = "# END mobile-mcp-build managed MCP";
const SKILLS: Record<string, string> = {
  "mobile-automation": [
    "---",
    "name: mobile-automation",
    "description: Control authorized Android and iOS devices through Mobile MCP, including UI inspection, screenshots, taps, and testing.",
    "---",
    "# Mobile automation",
    "Use the mobile_* MCP tools only for devices the user has authorized.",
    "1. Call mobile_list_available_devices and select a device.",
    "2. Prefer mobile_list_elements_on_screen; use screenshots only when needed.",
    "3. Use taps, swipe, type, app launch and other mobile_* tools for the requested workflow.",
    "4. Inspect the resulting UI to verify each consequential action.",
    "Never expose passwords, clipboard secrets, private messages or full logs without explicit need.",
    "Get explicit user approval before sending messages, purchases, permissions changes, app deletion or other destructive operations.",
    "Do not use Mobile Next Cloud without the user's explicit request.",
    ""
  ].join("\n"),
  "build-mcp-exe": [
    "---",
    "name: build-mcp-exe",
    "description: Build and maintain a privacy-preserving Windows mobile-mcp EXE, its GitHub Actions workflow, reversible agent installation, and smoke tests.",
    "---",
    "# Build mobile-mcp EXE",
    "Repository: https://github.com/the-long-ride/mobile-mcp-build",
    "1. Inspect the current fork and pin the exact commit/dependency versions before editing.",
    "2. Keep MCP PostHog and Scarf requests removed in src/server.ts, not merely opt-out. Keep raw argument/result logging disabled.",
    "3. Ensure MOBILEMCP_DISABLE_TELEMETRY, MOBILEWRIGHT_DISABLE_TELEMETRY, and DO_NOT_TRACK are forced to 1 before running the MCP server or mobilecli.",
    "4. Keep the Windows GitHub Actions job on a Windows runner. Run npm ci, npm run build, bundle with Bun --compile to dist/mobile-mcp.exe, and copy the mobilecli-windows-amd64.exe companion.",
    "5. Run --help for all commands; run install/uninstall dry-run smoke tests. Verify executable and companion appear in the artifact.",
    "6. Test installing and uninstalling Claude, Codex, Antigravity and OpenCode in an isolated HOME. Preserve pre-existing user data; uninstall only owned entries.",
    "7. For Aevra show manual MCP configuration guidance; do not silently mutate Aevra settings.",
    "8. Confirm dry-run has zero filesystem writes and verify no PostHog or Scarf paths remain in the bundled MCP server.",
    "9. Commit changes to a feature branch and open a PR; inspect action logs and fix failures before treating the EXE as verified.",
    "10. Publish SHA-256 checksums of the resulting Windows artifacts. Never claim zero network traffic from unreviewed native dependencies.",
    ""
  ].join("\n")
};

function read(file: string): string | null {
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}
function checksum(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}
function atomicWrite(file: string, content: string | null): void {
  if (content === null) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + "." + process.pid + ".tmp";
  try {
    fs.writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}
function parseJson(file: string): Record<string, any> {
  const text = read(file);
  if (text === null) return {};
  const value = JSON.parse(text);
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("Expected an object in " + file);
  }
  return value;
}
function state(): SetupState {
  const raw = parseJson(STATE_PATH);
  if (raw.schema !== undefined && raw.schema !== 1) throw new Error("Unsupported installer state schema");
  return { schema: 1, agents: raw.agents || {}, skills: raw.skills || {} };
}
function agentPaths(agent: Agent): {config: string; instructions: string; kind: "json" | "toml"} {
  switch (agent) {
    case "claude":
      return { config: path.join(HOME, ".claude.json"), instructions: path.join(HOME, ".claude", "CLAUDE.md"), kind: "json" };
    case "codex":
      return { config: path.join(HOME, ".codex", "config.toml"), instructions: path.join(HOME, ".codex", "AGENTS.md"), kind: "toml" };
    case "antigravity":
      return { config: path.join(HOME, ".gemini", "config", "mcp_config.json"), instructions: path.join(HOME, ".gemini", "GEMINI.md"), kind: "json" };
    case "opencode":
      return { config: path.join(HOME, ".config", "opencode", "opencode.json"), instructions: path.join(HOME, ".config", "opencode", "AGENTS.md"), kind: "json" };
    default:
      throw new Error("Aevra is guidance only");
  }
}
function managedInstructions(): string {
  return MARKER_START + "\n" +
    "Mobile MCP is installed locally. For mobile automation consult " +
    path.join(SKILL_DIR, "mobile-automation", "SKILL.md") + ". " +
    "For packaging work consult " + path.join(SKILL_DIR, "build-mcp-exe", "SKILL.md") + ". " +
    "Use mobile_* tools only for authorized devices; confirm destructive actions. " +
    "The fork disables its own telemetry; do not expose private on-device content to an AI provider unnecessarily.\n" +
    MARKER_END;
}
function addBlock(original: string | null): string {
  const base = original || "";
  if (base.includes(MARKER_START) || base.includes(MARKER_END)) {
    if (base.includes(managedInstructions())) return base;
    throw new Error("Managed instruction block was edited; manual reconciliation required");
  }
  return base + (base && !base.endsWith("\n") ? "\n" : "") + (base ? "\n" : "") + managedInstructions() + "\n";
}
function removeBlock(original: string | null, separator: string): string | null {
  if (original === null) return null;
  const idx = original.indexOf(managedInstructions());
  if (idx === -1) {
    if (original.includes(MARKER_START)) throw new Error("Instruction block changed; refusing to remove user edits");
    return original;
  }
  if (!original.slice(0, idx).endsWith(separator)) throw new Error("Managed instruction separator changed");
  const start = idx - separator.length;
  const end = idx + managedInstructions().length;
  const after = original.slice(end).replace(/^\n/, "");
  return original.slice(0, start) + after;
}
function configEntry(executable: string, opencodeV2: boolean): any {
  if (opencodeV2) return {
    type: "local", command: [executable],
    environment: {
      MOBILEMCP_DISABLE_TELEMETRY: "1",
      MOBILEWRIGHT_DISABLE_TELEMETRY: "1",
      DO_NOT_TRACK: "1"
    }
  };
  return { command: executable, args: [], env: {
    MOBILEMCP_DISABLE_TELEMETRY: "1",
    MOBILEWRIGHT_DISABLE_TELEMETRY: "1",
    DO_NOT_TRACK: "1"
  }};
}
function jsonSlot(agent: Agent, root: Record<string, any>): Record<string, any> {
  if (agent === "opencode") {
    if (root.mcp === undefined) root.mcp = {};
    if (typeof root.mcp !== "object" || Array.isArray(root.mcp) || root.mcp === null) throw new Error("Invalid OpenCode MCP config");
    // OpenCode V2 nests local servers under mcp.servers; preserve V1 when already present.
    if (root.mcp.servers && typeof root.mcp.servers === "object" && !Array.isArray(root.mcp.servers)) return root.mcp.servers;
    if (Object.keys(root.mcp).some(key => key !== "servers")) return root.mcp;
    root.mcp.servers = {};
    return root.mcp.servers;
  }
  if (root.mcpServers === undefined) root.mcpServers = {};
  if (typeof root.mcpServers !== "object" || Array.isArray(root.mcpServers) || root.mcpServers === null) throw new Error("Invalid MCP config");
  return root.mcpServers;
}
function toJson(v: unknown): string { return JSON.stringify(v, null, 2) + "\n"; }
function tomlBlock(exe: string): string {
  const q = (s: string) => JSON.stringify(s);
  return TOML_BEGIN + "\n" +
    '[mcp_servers."mobile-mcp"]\n' +
    "command = " + q(exe) + "\n" +
    "args = []\n" +
    '[mcp_servers."mobile-mcp".env]\n' +
    'MOBILEMCP_DISABLE_TELEMETRY = "1"\n' +
    'MOBILEWRIGHT_DISABLE_TELEMETRY = "1"\n' +
    'DO_NOT_TRACK = "1"\n' +
    TOML_END + "\n";
}
function push(writes: PlannedWrite[], file: string, content: string | null, description: string): void {
  if (read(file) !== content) writes.push({file, content, description});
}
function chosenAgents(value: string): Agent[] {
  const options: Agent[] = ["claude", "codex", "antigravity", "opencode", "aevra"];
  if (value === "all") return options;
  const parts = value.split(",").map(x => x.trim().toLowerCase());
  if (!parts.length || parts.some(x => !options.includes(x as Agent))) {
    throw new Error("Choose --agent claude|codex|antigravity|opencode|aevra|all (comma-separated accepted)");
  }
  return [...new Set(parts)] as Agent[];
}
function executablePath(explicit?: string): string {
  const exe = path.resolve(explicit || process.execPath);
  const filename = path.basename(exe).toLowerCase();
  if (!explicit && filename !== "mobile-mcp.exe" && filename !== "mobile-mcp") {
    throw new Error("Run the compiled mobile-mcp.exe or pass --executable C:\\path\\mobile-mcp.exe");
  }
  if (!fs.existsSync(exe)) throw new Error("Executable does not exist: " + exe);
  return exe;
}
function aevraGuide(exe: string): void {
  console.log("Aevra: manual configuration only. No Aevra settings were changed.");
  console.log("In Aevra's supported external MCP integration UI, register a local stdio server:");
  console.log(toJson({ name: "mobile-mcp", command: exe, args: [], env: {
    MOBILEMCP_DISABLE_TELEMETRY: "1", MOBILEWRIGHT_DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1"
  }}));
  console.log("Enable this only if your Aevra version exposes custom MCP server registration.");
}

export async function runAgentSetup(action: SetupAction, options: SetupOptions): Promise<void> {
  const selected = chosenAgents(options.agent);
  const standalone = selected.filter(x => x !== "aevra");
  const current = state();
  const writes: PlannedWrite[] = [];
  const executable = standalone.length && action === "install" ? executablePath(options.executable) : path.resolve(options.executable || process.execPath);

  for (const agent of standalone) {
    const paths = agentPaths(agent);
    const installed = current.agents[agent];
    if (action === "install") {
      if (installed) {
        if (installed.executable !== executable) throw new Error(agent + " already points at another executable. Uninstall first.");
        console.log(agent + ": already tracked; skipping");
        continue;
      }
      const original = read(paths.config);
      if (paths.kind === "toml") {
        if (original && (/^\s*\[mcp_servers\.(?:"mobile-mcp"|mobile-mcp)(?:\]|\.)/m.test(original) ||
            original.includes(TOML_BEGIN))) throw new Error("Existing Codex mobile-mcp config: " + paths.config);
        push(writes, paths.config, (original || "") + (original && !original.endsWith("\n") ? "\n" : "") + "\n" + tomlBlock(executable), "Configure " + agent);
      } else {
        const config = parseJson(paths.config);
        const slot = jsonSlot(agent, config);
        if (Object.prototype.hasOwnProperty.call(slot, "mobile-mcp")) throw new Error("Existing " + agent + " mobile-mcp entry. Refusing to overwrite.");
        const v2 = agent === "opencode" && slot === config.mcp?.servers;
        slot["mobile-mcp"] = configEntry(executable, v2);
        push(writes, paths.config, toJson(config), "Configure " + agent);
      }
      const originalInstructions = read(paths.instructions);
      const separator = originalInstructions ? (originalInstructions.endsWith("\n") ? "\n" : "\n\n") : "";
      push(writes, paths.instructions, addBlock(originalInstructions), "Add global instructions for " + agent);
      current.agents[agent] = {kind: paths.kind, configPath: paths.config, instructionPath: paths.instructions, executable,
        instructionSeparator: separator, instructionExisted: originalInstructions !== null, configExisted: original !== null};
    } else {
      if (!installed) { console.log(agent + ": not installed by this CLI; skipping"); continue; }
      if (installed.configPath !== paths.config || installed.instructionPath !== paths.instructions) {
        throw new Error("Installer state path mismatch for " + agent);
      }
      const original = read(paths.config);
      if (installed.kind === "toml") {
        if (original !== null) {
          const block = tomlBlock(installed.executable);
          if (!original.includes(block)) throw new Error("Codex config changed; will not remove an unrecognized block");
          const result = original.replace(block, "");
          push(writes, paths.config, !installed.configExisted && result.trim() === "" ? null : result, "Remove Codex MCP entry");
        }
      } else if (original !== null) {
        const config = parseJson(paths.config);
        const slot = jsonSlot(agent, config);
        const actual = slot["mobile-mcp"];
        const expected = configEntry(installed.executable, agent === "opencode" && slot === config.mcp?.servers);
        if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(agent + " MCP entry changed; refusing to delete");
        delete slot["mobile-mcp"];
        const emptyCreated = !installed.configExisted &&
          (agent === "opencode" ? JSON.stringify(config) === '{"mcp":{"servers":{}}}' : JSON.stringify(config) === '{"mcpServers":{}}');
        push(writes, paths.config, emptyCreated ? null : toJson(config), "Remove " + agent + " MCP entry");
      }
      const removedInstructions = removeBlock(read(paths.instructions), installed.instructionSeparator || "");
      push(writes, paths.instructions,
        !installed.instructionExisted && removedInstructions === "" ? null : removedInstructions,
        "Remove global instructions for " + agent);
      delete current.agents[agent];
    }
  }

  if (standalone.length) {
    if (action === "install") {
      for (const [name, content] of Object.entries(SKILLS)) {
        const skillPath = path.join(SKILL_DIR, name, "SKILL.md");
        const existing = read(skillPath);
        if (existing !== null && existing !== content && !current.skills[name]) {
          throw new Error("Skill exists but is not owned by this installer: " + skillPath);
        }
        if (current.skills[name] && existing !== null && checksum(existing) !== current.skills[name]) {
          throw new Error("Managed skill was edited, refusing overwrite: " + skillPath);
        }
        if (existing === null || current.skills[name]) {
          push(writes, skillPath, content, "Install global skill " + name);
          current.skills[name] = checksum(content);
        }
      }
    } else if (!Object.keys(current.agents).length) {
      for (const [name, hash] of Object.entries(current.skills)) {
        const skillPath = path.join(SKILL_DIR, name, "SKILL.md");
        const existing = read(skillPath);
        if (existing !== null && checksum(existing) !== hash) throw new Error("Skill was edited, refusing to delete: " + skillPath);
        push(writes, skillPath, null, "Remove owned global skill " + name);
      }
      current.skills = {};
    }
    push(writes, STATE_PATH, toJson(current), "Update owned installation manifest");
  }

  for (const step of writes) {
    console.log((options.dryRun ? "[dry-run] " : "") + step.description + ": " + step.file);
  }
  if (options.dryRun) {
    console.log("Dry run complete: no files changed.");
  } else {
    for (const step of writes) atomicWrite(step.file, step.content);
    console.log(action + " complete (" + writes.length + " file updates).");
  }
  if (selected.includes("aevra")) aevraGuide(executable);
}
