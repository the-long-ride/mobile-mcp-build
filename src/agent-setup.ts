import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { SKILLS } from "./embedded-skills";

type Agent = "claude" | "codex" | "antigravity" | "opencode" | "aevra";
type Action = "install" | "uninstall";
export interface SetupOptions {
	agent: string;
	dryRun?: boolean;
	executable?: string;
}
interface Entry {
	kind: "json" | "jsonc" | "toml";
	configPath: string;
	instructionPath: string;
	executable: string;
	configExisted: boolean;
	instructionExisted: boolean;
	instructionSeparator: string;
	tomlPrefix?: string;
	mcpCreated?: boolean;
}
interface State {
	schema: 2;
	agents: Partial<Record<Agent, Entry>>;
	skills: Record<string, string>;
	links: Record<string, string>;
}
interface Change {
	path: string;
	before: string | null;
	after: string | null;
	description: string;
	kind?: "file" | "link-create" | "link-remove" | "link-migrate";
	target?: string;
}
const HOME = path.resolve(process.env.MOBILE_MCP_SETUP_HOME || os.homedir());
const STATE_PATH = path.join(HOME, ".config", "mobile-mcp-build", "installed.json");
const CANON = path.join(HOME, ".agents", "skills");
const START = "<!-- BEGIN mobile-mcp-build managed instructions -->";
const END = "<!-- END mobile-mcp-build managed instructions -->";
const TOML_START = "# BEGIN mobile-mcp-build managed MCP";
const TOML_END = "# END mobile-mcp-build managed MCP";

function read(file: string): string | null {
	return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
}
function hash(text: string): string {
	return crypto.createHash("sha256").update(text).digest("hex");
}
function json(value: unknown): string {
	return JSON.stringify(value, null, 2) + "\n";
}
function object(value: unknown, name: string): Record<string, any> {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(name + " must contain a JSON object");
	}
	return value as Record<string, any>;
}
function parse(file: string): Record<string, any> {
	const value = read(file);
	return value === null ? {} : object(JSON.parse(value), file);
}
function getState(): State {
	const state = parse(STATE_PATH);
	if (state.schema !== undefined && state.schema !== 2) {
		throw new Error("Unsupported installation state; previous version must be removed or migrated manually");
	}
	return { schema: 2, agents: state.agents || {}, skills: state.skills || {}, links: state.links || {} };
}
function selectedAgents(input: string): Agent[] {
	const supported: Agent[] = ["claude", "codex", "antigravity", "opencode", "aevra"];
	const names = input.toLowerCase() === "all" ? supported : input.toLowerCase().split(",").map(x => x.trim());
	if (!names.length || names.some(x => !supported.includes(x as Agent))) {
		throw new Error("Supported --agent: claude, codex, antigravity, opencode, aevra, all");
	}
	return [...new Set(names)] as Agent[];
}
function target(agent: Agent): { config: string; instructions: string; kind: "json" | "toml" } {
	switch (agent) {
		case "claude":
			return { config: path.join(HOME, ".claude.json"), instructions: path.join(HOME, ".claude", "CLAUDE.md"), kind: "json" };
		case "codex":
			return { config: path.join(HOME, ".codex", "config.toml"), instructions: path.join(HOME, ".codex", "AGENTS.md"), kind: "toml" };
		case "antigravity":
			return { config: path.join(HOME, ".gemini", "config", "mcp_config.json"), instructions: path.join(HOME, ".gemini", "GEMINI.md"), kind: "json" };
		case "opencode": {
			const directory = path.join(HOME, ".config", "opencode");
			const j = path.join(directory, "opencode.json");
			const jc = path.join(directory, "opencode.jsonc");
			if (fs.existsSync(j) && fs.existsSync(jc)) {
				throw new Error("Both OpenCode config variants exist. Select one before installing: " + directory);
			}
			return { config: fs.existsSync(jc) ? jc : j, instructions: path.join(directory, "AGENTS.md"), kind: "json" };
		}
		default:
			throw new Error("Aevra uses manual registration only");
	}
}
function entry(executable: string, agent: Agent): Record<string, any> {
	const env = { MOBILEMCP_DISABLE_TELEMETRY: "1", MOBILEWRIGHT_DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1" };
	return agent === "opencode"
		? { type: "local", command: [executable], environment: env }
		: { command: executable, args: [], env };
}
function instructions(): string {
	return START + "\n" +
		"Mobile MCP is installed for authorized device automation. Use skills in " + CANON +
		"/mobile-automation/SKILL.md and " + CANON +
		"/build-mcp-exe/SKILL.md. Verify destructive actions with the user. Avoid exposing device secrets to AI providers.\n" +
		END;
}
function appendInstructions(original: string | null): { output: string; separator: string } {
	const text = original || "";
	if (text.includes(START) || text.includes(END)) {
		throw new Error("An existing Mobile MCP managed instruction block needs manual reconciliation");
	}
	const separator = !text ? "" : text.endsWith("\n") ? "\n" : "\n\n";
	return { output: text + separator + instructions() + "\n", separator };
}
function stripInstructions(original: string | null, previous: Entry): string | null {
	if (original === null) {
		return null;
	}
	const match = previous.instructionSeparator + instructions() + "\n";
	const index = original.indexOf(match);
	if (index === -1) {
		throw new Error("Managed global instructions changed; refusing to remove them");
	}
	const output = original.slice(0, index) + original.slice(index + match.length);
	return !previous.instructionExisted && output === "" ? null : output;
}
function tomlBlock(executable: string): string {
	return TOML_START + "\n" +
		'[mcp_servers."mobile-mcp"]\n' +
		"command = " + JSON.stringify(executable) + "\nargs = []\n" +
		'[mcp_servers."mobile-mcp".env]\n' +
		'MOBILEMCP_DISABLE_TELEMETRY = "1"\n' +
		'MOBILEWRIGHT_DISABLE_TELEMETRY = "1"\n' +
		'DO_NOT_TRACK = "1"\n' + TOML_END + "\n";
}

// Only JSONC whitespace, // and /* */ comments, and trailing commas are accepted.
// Tokens retain source offsets so editing preserves existing comments and formatting.
interface Token { raw: string; start: number; end: number; kind: "string" | "symbol" | "atom"; }
function tokenize(source: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < source.length) {
		const start = i;
		const ch = source[i];
		if (/\s/.test(ch)) { i++; continue; }
		if (source.startsWith("//", i)) {
			i += 2;
			while (i < source.length && source[i] !== "\n") { i++; }
			continue;
		}
		if (source.startsWith("/*", i)) {
			i = source.indexOf("*/", i + 2);
			if (i < 0) { throw new Error("Unclosed JSONC comment"); }
			i += 2;
			continue;
		}
		if (ch === '"') {
			i++;
			while (i < source.length) {
				if (source[i] === "\\") { i += 2; continue; }
				if (source[i++] === '"') { break; }
			}
			if (source[i - 1] !== '"') { throw new Error("Unterminated JSON string"); }
			tokens.push({ kind: "string", raw: source.slice(start, i), start, end: i });
			continue;
		}
		if ("{}[]:,".includes(ch)) {
			i++;
			tokens.push({ kind: "symbol", raw: ch, start, end: i });
			continue;
		}
		while (i < source.length && !/[\s{}\[\]:,]/.test(source[i]) && !source.startsWith("//", i) && !source.startsWith("/*", i)) { i++; }
		if (i === start) { throw new Error("Invalid JSONC token"); }
		tokens.push({ kind: "atom", raw: source.slice(start, i), start, end: i });
	}
	return tokens;
}
function parseJsonc(source: string): Record<string, any> {
	const tokens = tokenize(source);
	const withoutComments = tokens.filter((t, i) => t.raw !== "," || !["}", "]"].includes(tokens[i + 1]?.raw));
	return object(JSON.parse(withoutComments.map(t => t.raw).join("")), "OpenCode JSONC");
}
function closing(tokens: Token[], start: number): number {
	const open = tokens[start]?.raw;
	const close = open === "{" ? "}" : open === "[" ? "]" : null;
	if (!close) { return start; }
	let depth = 0;
	for (let i = start; i < tokens.length; i++) {
		if (tokens[i].raw === open) { depth++; }
		if (tokens[i].raw === close && --depth === 0) { return i; }
	}
	throw new Error("Unclosed JSONC object");
}
interface Property { name: string; key: number; valueStart: number; valueEnd: number; comma: number | null; }
function properties(tokens: Token[], begin: number): Property[] {
	if (tokens[begin]?.raw !== "{") { throw new Error("Expected JSONC object"); }
	const end = closing(tokens, begin);
	const out: Property[] = [];
	let i = begin + 1;
	while (i < end) {
		if (tokens[i].raw === ",") { i++; continue; }
		if (tokens[i].kind !== "string" || tokens[i + 1]?.raw !== ":") { throw new Error("Invalid JSONC object property"); }
		const name = JSON.parse(tokens[i].raw) as string;
		const valueStart = i + 2;
		const valueEnd = closing(tokens, valueStart);
		const comma = tokens[valueEnd + 1]?.raw === "," ? valueEnd + 1 : null;
		out.push({ name, key: i, valueStart, valueEnd, comma });
		i = valueEnd + 1 + (comma !== null ? 1 : 0);
	}
	return out;
}
function property(tokens: Token[], begin: number, name: string): Property | undefined {
	return properties(tokens, begin).find(p => p.name === name);
}
function jsoncInsert(original: string, executable: string): { output: string; mcpCreated: boolean } {
	const parsed = parseJsonc(original);
	const tokens = tokenize(original);
	const parent = property(tokens, 0, "mcp");
	if (parent) {
		const existing = object(parsed.mcp, "OpenCode mcp");
		if (Object.hasOwn(existing, "mobile-mcp")) { throw new Error("OpenCode mobile-mcp entry exists"); }
		const open = parent.valueStart;
		const hasEntries = properties(tokens, open).length > 0;
		const fragment = "\n    \"mobile-mcp\": " + JSON.stringify(entry(executable, "opencode")) + (hasEntries ? "," : "") + "\n";
		const pos = tokens[open].end;
		return { output: original.slice(0, pos) + fragment + original.slice(pos), mcpCreated: false };
	}
	const hasEntries = properties(tokens, 0).length > 0;
	const fragment = "\n  \"mcp\": {\"mobile-mcp\": " + JSON.stringify(entry(executable, "opencode")) + "}" + (hasEntries ? "," : "") + "\n";
	const pos = tokens[0].end;
	return { output: original.slice(0, pos) + fragment + original.slice(pos), mcpCreated: true };
}
function removeJsoncProperty(source: string, tokens: Token[], parentOpen: number, name: string): string {
	const props = properties(tokens, parentOpen);
	const index = props.findIndex(p => p.name === name);
	if (index < 0) { throw new Error("Expected owned JSONC property: " + name); }
	const selected = props[index];
	let start = tokens[selected.key].start;
	let end = tokens[selected.valueEnd].end;
	if (selected.comma !== null) {
		end = tokens[selected.comma].end;
	} else if (index > 0 && props[index - 1].comma !== null) {
		start = tokens[props[index - 1].comma!].start;
	}
	return source.slice(0, start) + source.slice(end);
}
function jsoncRemove(original: string, expected: Record<string, any>, previous: Entry): string | null {
	const obj = parseJsonc(original);
	const mcp = object(obj.mcp, "OpenCode mcp");
	if (JSON.stringify(mcp["mobile-mcp"]) !== JSON.stringify(expected)) {
		throw new Error("OpenCode entry changed; refusing to remove");
	}
	let tokens = tokenize(original);
	const section = property(tokens, 0, "mcp");
	if (!section) { throw new Error("OpenCode MCP section is missing"); }
	let output = removeJsoncProperty(original, tokens, section.valueStart, "mobile-mcp");
	if (previous.mcpCreated) {
		tokens = tokenize(output);
		const mcpSection = property(tokens, 0, "mcp");
		if (mcpSection && properties(tokens, mcpSection.valueStart).length === 0) {
			output = removeJsoncProperty(output, tokens, 0, "mcp");
		}
	}
	return !previous.configExisted && parseJsonc(output) && output.trim() === "{}" ? null : output;
}
function configChange(agent: Agent, configPath: string, executable: string, previous?: Entry): { output: string | null; kind: Entry["kind"]; prefix?: string; mcpCreated?: boolean } {
	const original = read(configPath);
	const mode: Entry["kind"] = agent === "codex" ? "toml" : configPath.endsWith(".jsonc") ? "jsonc" : "json";
	if (agent === "codex") {
		const block = tomlBlock(previous?.executable || executable);
		if (!previous) {
			if (original && (original.includes(TOML_START) || /^\s*\[mcp_servers\.(?:"mobile-mcp"|mobile-mcp)(?:\]|\.)/m.test(original))) {
				throw new Error("Codex mobile-mcp config already exists");
			}
			const prefix = original ? original.endsWith("\n") ? "\n" : "\n\n" : "";
			return { output: (original || "") + prefix + block, kind: mode, prefix };
		}
		const owned = (previous.tomlPrefix || "") + block;
		if (!original?.includes(owned)) { throw new Error("Codex managed MCP block changed"); }
		const output = original.replace(owned, "");
		return { output: !previous.configExisted && output === "" ? null : output, kind: mode };
	}
	if (mode === "jsonc") {
		if (!previous) {
			const result = jsoncInsert(original || "{}", executable);
			return { output: result.output, kind: mode, mcpCreated: result.mcpCreated };
		}
		return { output: original === null ? null : jsoncRemove(original, entry(previous.executable, agent), previous), kind: mode };
	}
	const root = original === null ? {} : object(JSON.parse(original), configPath);
	const slot = agent === "opencode" ? (root.mcp ??= {}) : (root.mcpServers ??= {});
	object(slot, "MCP configuration");
	if (!previous) {
		if (Object.hasOwn(slot, "mobile-mcp")) { throw new Error(agent + " mobile-mcp entry already exists"); }
		slot["mobile-mcp"] = entry(executable, agent);
		return { output: json(root), kind: mode };
	}
	if (JSON.stringify(slot["mobile-mcp"]) !== JSON.stringify(entry(previous.executable, agent))) {
		throw new Error(agent + " managed MCP entry changed; refusing to delete it");
	}
	delete slot["mobile-mcp"];
	if (Object.keys(slot).length === 0) {
		if (agent === "opencode") { delete root.mcp; } else { delete root.mcpServers; }
	}
	return { output: !previous.configExisted && Object.keys(root).length === 0 ? null : json(root), kind: mode };
}
function mirrors(agent: Agent): string[] {
	switch (agent) {
		case "claude": return [path.join(HOME, ".claude", "skills")];
		case "antigravity": return [
			path.join(HOME, ".gemini", "config", "skills"),
			path.join(HOME, ".gemini", "antigravity-cli", "skills")
		];
		default: return [];
	}
}
function stat(file: string): fs.Stats | null {
	try { return fs.lstatSync(file); } catch (error: any) {
		if (error.code === "ENOENT") { return null; }
		throw error;
	}
}
function plan(writes: Change[], file: string, after: string | null, description: string): void {
	const before = read(file);
	if (before !== after) {
		writes.push({ kind: "file", path: file, before, after, description });
	}
}
function skillFile(root: string, name: string): string {
	return path.join(root, name, "SKILL.md");
}
function ensureSkill(writes: Change[], state: State, file: string, content: string): void {
	const existing = read(file);
	const owned = state.skills[file];
	if (existing !== null && !owned) {
		if (existing !== content) { throw new Error("Existing unowned skill conflicts: " + file); }
		return;
	}
	if (owned && existing !== null && hash(existing) !== owned) {
		throw new Error("Managed skill edited; will not overwrite: " + file);
	}
	plan(writes, file, content, "Install canonical global skill");
	state.skills[file] = hash(content);
}
function removeSkill(writes: Change[], state: State, file: string): void {
	const owned = state.skills[file];
	if (!owned) { return; }
	const existing = read(file);
	if (existing !== null && hash(existing) !== owned) {
		throw new Error("Managed skill edited; will not delete: " + file);
	}
	plan(writes, file, null, "Remove owned global skill");
	delete state.skills[file];
}
function sameLink(link: string, target: string): boolean {
	if (!stat(link)?.isSymbolicLink()) { return false; }
	// realpath handles Windows junction's \??\ prefix and normal symlinks.
	try { return fs.realpathSync(link) === fs.realpathSync(target); } catch { return false; }
}
function planLink(writes: Change[], state: State, link: string, target: string): void {
	const current = stat(link);
	if (current?.isSymbolicLink()) {
		if (!sameLink(link, target)) { throw new Error("Skill link points elsewhere: " + link); }
		if (state.links[link] && state.links[link] !== target) {
			throw new Error("Owned skill link target changed: " + link);
		}
		// Matching unowned symlinks are left alone and are not removed by uninstall.
		return;
	}
	if (state.links[link]) {
		throw new Error("Tracked skill link was replaced or deleted: " + link);
	}
	if (current) {
		const legacy = skillFile(path.dirname(link), path.basename(link));
		const owned = state.skills[legacy];
		if (!current.isDirectory() || !owned) {
			throw new Error("Cannot replace unowned skill directory: " + link);
		}
		const content = read(legacy);
		if (content === null || hash(content) !== owned ||
			fs.readdirSync(link).length !== 1 ||
			fs.readdirSync(link)[0] !== "SKILL.md" ||
			!stat(legacy)?.isFile()) {
			throw new Error("Managed skill directory was modified; manual migration needed: " + link);
		}
		writes.push({ kind: "link-migrate", path: link, before: content, after: null, target,
			description: "Replace owned skill copy with directory junction" });
		delete state.skills[legacy];
	} else {
		writes.push({ kind: "link-create", path: link, before: null, after: null, target,
			description: "Link agent skill to canonical ~/.agents/skills" });
	}
	state.links[link] = target;
}
function planRemoveLink(writes: Change[], state: State, link: string, target: string): void {
	const owned = state.links[link];
	if (owned) {
		if (owned !== target || !sameLink(link, target)) {
			throw new Error("Owned skill link changed; refusing to remove: " + link);
		}
		writes.push({ kind: "link-remove", path: link, before: null, after: null, target,
			description: "Remove owned agent skill junction" });
		delete state.links[link];
		return;
	}
	// Compatibility: prior builds installed independent skill copies.
	removeSkill(writes, state, skillFile(path.dirname(link), path.basename(link)));
}
function writeAtomically(file: string, content: string | null): void {
	if (content === null) { fs.rmSync(file, { force: true }); return; }
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = file + "." + process.pid + ".tmp";
	try {
		fs.writeFileSync(temp, content, { encoding: "utf8", mode: 0o600 });
		fs.renameSync(temp, file);
	} finally {
		fs.rmSync(temp, { force: true });
	}
}
function createLink(link: string, target: string): void {
	fs.mkdirSync(path.dirname(link), { recursive: true });
	// Junctions are directory links on Windows and normally need no admin/Developer Mode.
	fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}
function applyChange(change: Change): void {
	switch (change.kind) {
		case "link-create":
			createLink(change.path, change.target!);
			return;
		case "link-remove":
			fs.unlinkSync(change.path); // Removes the link, never its target.
			return;
		case "link-migrate": {
			const oldSkill = path.join(change.path, "SKILL.md");
			fs.unlinkSync(oldSkill);
			fs.rmdirSync(change.path);
			try { createLink(change.path, change.target!); } catch (err) {
				fs.mkdirSync(change.path, { recursive: true });
				writeAtomically(oldSkill, change.before);
				throw err;
			}
			return;
		}
		default:
			writeAtomically(change.path, change.after);
	}
}
function undoChange(change: Change): void {
	switch (change.kind) {
		case "link-create":
			if (stat(change.path)?.isSymbolicLink()) { fs.unlinkSync(change.path); }
			return;
		case "link-remove":
			createLink(change.path, change.target!);
			return;
		case "link-migrate":
			if (stat(change.path)?.isSymbolicLink()) { fs.unlinkSync(change.path); }
			fs.mkdirSync(change.path, { recursive: true });
			writeAtomically(path.join(change.path, "SKILL.md"), change.before);
			return;
		default:
			writeAtomically(change.path, change.before);
	}
}
function checkChange(change: Change): void {
	if (change.kind === "file" || !change.kind) {
		if (read(change.path) !== change.before) {
			throw new Error("File changed during planning: " + change.path);
		}
	} else if (change.kind === "link-create") {
		if (stat(change.path)) { throw new Error("Link destination appeared: " + change.path); }
	} else if (change.kind === "link-remove") {
		if (!sameLink(change.path, change.target!)) {
			throw new Error("Link destination changed: " + change.path);
		}
	} else if (change.kind === "link-migrate") {
		const skill = path.join(change.path, "SKILL.md");
		if (!stat(change.path)?.isDirectory() || stat(change.path)?.isSymbolicLink() ||
			fs.readdirSync(change.path).length !== 1 ||
			fs.readdirSync(change.path)[0] !== "SKILL.md" ||
			read(skill) !== change.before || !stat(skill)?.isFile()) {
			throw new Error("Owned skill copy changed before migration: " + change.path);
		}
	}
	// Never traverse symlink parents, including where old copies once existed.
	let candidate = (change.kind === "file" || !change.kind) ? change.path : path.dirname(change.path);
	while (candidate === HOME || (!path.relative(HOME, candidate).startsWith("..") && candidate !== path.dirname(candidate))) {
		if (stat(candidate)?.isSymbolicLink()) {
			throw new Error("Refusing to modify through a symlink: " + candidate);
		}
		if (candidate === HOME) { break; }
		candidate = path.dirname(candidate);
	}
}
function apply(writes: Change[], dryRun: boolean): void {
	for (const change of writes) {
		console.log((dryRun ? "[dry-run] " : "") + change.description + ": " + change.path +
			(change.target ? " -> " + change.target : ""));
	}
	if (dryRun) { console.log("Dry run complete: no files changed."); return; }
	for (const change of writes) { checkChange(change); }
	const applied: Change[] = [];
	try {
		for (const change of writes) {
			applyChange(change);
			applied.push(change);
			const failAfter = Number(process.env.MOBILE_MCP_SETUP_TEST_FAIL_AFTER || 0);
			if (failAfter > 0 && applied.length >= failAfter) {
				throw new Error("Simulated mid-installation failure");
			}
		}
	} catch (failure) {
		const errors: string[] = [];
		for (const change of applied.reverse()) {
			try { undoChange(change); } catch (err) { errors.push(change.path + ": " + String(err)); }
		}
		if (errors.length) {
			throw new Error("Setup failed and rollback was incomplete: " + errors.join("; "), { cause: failure });
		}
		throw failure;
	}
	console.log("Applied " + writes.length + " changes.");
}
function aevra(action: Action, executable: string): void {
	if (action === "uninstall") {
		console.log("Aevra is manually configured; no Aevra settings were changed.");
		console.log("Run 'aevra mcp list', identify the ID of mobile-mcp, then 'aevra mcp remove <id>'.");
		return;
	}
	const quoted = "'" + executable.replace(/'/g, "''") + "'";
	console.log("Aevra: manual only. In Settings -> MCP servers -> Add server, select stdio.");
	console.log("Or run in PowerShell: aevra mcp add mobile-mcp --transport stdio --command " + quoted + " --risk HIGH");
	console.log("Verify with: aevra mcp list");
}
export async function runAgentSetup(action: Action, options: SetupOptions): Promise<void> {
	const selected = selectedAgents(options.agent);
	const machines = selected.filter(x => x !== "aevra");
	const executable = path.resolve(options.executable || process.execPath);
	if (action === "install" && machines.length) {
		if (!fs.existsSync(executable)) { throw new Error("Executable missing: " + executable); }
		if (!options.executable && !/^mobile-mcp(?:\.exe)?$/i.test(path.basename(executable))) {
			throw new Error("Run the compiled mobile-mcp.exe or specify --executable");
		}
	}
	const state = getState();
	const writes: Change[] = [];
	if (machines.length && action === "install") {
		// Canonical skill files must exist before Windows junction creation.
		for (const [name, content] of Object.entries(SKILLS)) {
			ensureSkill(writes, state, skillFile(CANON, name), content);
		}
	}
	for (const agent of machines) {
		const paths = target(agent);
		const installed = state.agents[agent];
		if (action === "install") {
			if (installed) {
				if (installed.executable !== executable) {
					throw new Error(agent + " is installed for another binary");
				}
				console.log(agent + ": MCP configuration already installed; checking skill links");
			} else {
				const config = configChange(agent, paths.config, executable);
				const originalInstructions = read(paths.instructions);
				const instruction = appendInstructions(originalInstructions);
				plan(writes, paths.config, config.output, "Configure " + agent + " MCP");
				plan(writes, paths.instructions, instruction.output, "Add " + agent + " global instructions");
				state.agents[agent] = {
					kind: config.kind,
					configPath: paths.config,
					instructionPath: paths.instructions,
					executable,
					configExisted: read(paths.config) !== null,
					instructionExisted: originalInstructions !== null,
					instructionSeparator: instruction.separator,
					tomlPrefix: config.prefix,
					mcpCreated: config.mcpCreated
				};
			}
			for (const name of Object.keys(SKILLS)) {
				for (const folder of mirrors(agent)) {
					planLink(writes, state, path.join(folder, name), path.join(CANON, name));
				}
			}
		} else {
			if (!installed) { console.log(agent + ": not tracked; skipping"); continue; }
			if (installed.configPath !== paths.config || installed.instructionPath !== paths.instructions) {
				throw new Error("Managed " + agent + " paths differ from detected configuration");
			}
			const output = configChange(agent, installed.configPath, executable, installed);
			plan(writes, installed.configPath, output.output, "Remove " + agent + " MCP");
			plan(writes, installed.instructionPath,
								stripInstructions(read(installed.instructionPath), installed), "Remove " + agent + " instructions");
			for (const name of Object.keys(SKILLS)) {
				for (const folder of mirrors(agent)) {
					planRemoveLink(writes, state, path.join(folder, name), path.join(CANON, name));
				}
			}
			delete state.agents[agent];
		}
	}
	if (machines.length) {
		if (action === "uninstall" && !Object.keys(state.agents).length) {
			for (const name of Object.keys(SKILLS)) {
				removeSkill(writes, state, skillFile(CANON, name));
			}
		}
		plan(writes, STATE_PATH, json(state), "Update ownership state");
	}
	apply(writes, !!options.dryRun);
	if (selected.includes("aevra")) { aevra(action, executable); }
}
