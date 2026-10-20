import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const exe = path.resolve("dist/mobile-mcp.exe");
const companion = path.resolve("dist/mobilecli-windows-amd64.exe");
assert.ok(fs.existsSync(exe), "Compiled MCP executable exists");
assert.ok(fs.existsSync(companion), "Native sidecar exists");

const privacy = { MOBILEMCP_DISABLE_TELEMETRY: "1", MOBILEWRIGHT_DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1" };
const scenarios = [];
const file = (...items) => path.join(...items);
function sandbox() {
	const home = fs.mkdtempSync(file(os.tmpdir(), "mobile-mcp-smoke-"));
	scenarios.push(home);
	return home;
}
function run(home, args, extra = {}, expectSuccess = true) {
	const response = spawnSync(exe, args, {
		encoding: "utf8",
		timeout: 45000,
		env: { ...process.env, ...privacy, MOBILE_MCP_SETUP_HOME: home, ...extra }
	});
	if (expectSuccess) {
		assert.equal(response.status, 0, args.join(" ") + " failed:\n" + response.stderr + "\n" + response.stdout);
	} else {
		assert.notEqual(response.status, 0, args.join(" ") + " should fail");
	}
	return response.stdout + response.stderr;
}
function read(file) { return fs.readFileSync(file, "utf8"); }
function exists(file) { return fs.existsSync(file); }
function write(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, value);
}
function command(home, command, agent = "all", extra = {}, expectSuccess = true) {
	return run(home, [command, "--agent", agent], extra, expectSuccess);
}
async function verifyStdioMcp() {
	const client = new Client({ name: "private-windows-smoke", version: "1.0.0" });
	const transport = new StdioClientTransport({
		command: exe,
		args: [],
		env: { ...process.env, ...privacy }
	});
	const timeout = AbortSignal.timeout(20000);
	try {
		await Promise.race([
			client.connect(transport),
			new Promise((_, reject) => timeout.addEventListener("abort", () => reject(new Error("MCP handshake timed out")), { once: true }))
		]);
		const tools = await client.listTools();
		const names = tools.tools.map(tool => tool.name);
		assert.ok(names.includes("mobile_list_available_devices"), "MCP exposes device tools");
		assert.ok(!names.includes("get_more_tools"), "MCP omits telemetry feedback tool");
	} finally {
		await client.close();
	}
}
try {
	const binaryVersion = spawnSync(companion, ["--version"], { encoding: "utf8", timeout: 15000 });
	assert.equal(binaryVersion.status, 0, "Native mobilecli did not start: " + binaryVersion.stderr);
	assert.match(run(sandbox(), ["--help"]), /install/);
	assert.match(run(sandbox(), ["install", "--help"]), /dry-run/);
	assert.match(run(sandbox(), ["uninstall", "--help"]), /dry-run/);
	await verifyStdioMcp();

	const home = sandbox();
	const planned = run(home, ["install", "--agent", "all", "--dry-run"]);
	assert.match(planned, /Dry run complete/);
	assert.match(planned, /Link agent skill to canonical/);
	assert.deepEqual(fs.readdirSync(home), [], "Dry run created files");
	const existingInstruction = file(home, ".claude", "CLAUDE.md");
	write(existingInstruction, "My own rules.\n");
	const aevraGuide = command(home, "install");
	assert.match(aevraGuide, /aevra mcp add/);
	const claude = JSON.parse(read(file(home, ".claude.json")));
	assert.equal(claude.mcpServers["mobile-mcp"].command, exe);
	assert.equal(claude.mcpServers["mobile-mcp"].env.DO_NOT_TRACK, "1");
	const opencode = JSON.parse(read(file(home, ".config", "opencode", "opencode.json")));
	assert.deepEqual(opencode.mcp["mobile-mcp"].command, [exe]);
	assert.equal(opencode.mcp["mobile-mcp"].type, "local");
	assert.equal(opencode.mcp["mobile-mcp"].environment.DO_NOT_TRACK, "1");
	for (const location of [
		".agents/skills", ".claude/skills", ".gemini/config/skills", ".gemini/antigravity-cli/skills"
	]) {
		for (const name of ["mobile-automation", "build-mcp-exe"]) {
			const directory = file(home, location, name);
			assert.ok(exists(file(directory, "SKILL.md")), location + " missing " + name);
			if (location !== ".agents/skills") {
				assert.ok(fs.lstatSync(directory).isSymbolicLink(), "Expected a directory junction: " + directory);
				assert.equal(fs.realpathSync(directory), fs.realpathSync(file(home, ".agents", "skills", name)));
			} else {
				assert.ok(fs.lstatSync(directory).isDirectory());
				assert.ok(!fs.lstatSync(directory).isSymbolicLink());
			}
		}
	}
	const original = read(file(home, ".claude.json"));
	run(home, ["uninstall", "--agent", "all", "--dry-run"]);
	assert.equal(read(file(home, ".claude.json")), original, "Uninstall dry-run changed config");
	const removalGuide = command(home, "uninstall");
	assert.match(removalGuide, /aevra mcp remove/);
	assert.equal(read(existingInstruction), "My own rules.\n");
	assert.ok(!exists(file(home, ".claude.json")));
	assert.ok(!exists(file(home, ".config", "opencode", "opencode.json")));
	assert.ok(!exists(file(home, ".agents", "skills", "build-mcp-exe", "SKILL.md")));
	assert.ok(!exists(file(home, ".claude", "skills", "build-mcp-exe")));
	assert.ok(!exists(file(home, ".gemini", "config", "skills", "build-mcp-exe")));

	// OpenCode JSONC: keep existing comments, trailing commas, and unrelated MCP servers.
	const jsoncHome = sandbox();
	const jsoncPath = file(jsoncHome, ".config", "opencode", "opencode.jsonc");
	const jsoncOriginal = '{\n  // comment retained\n  "$schema": "https://opencode.ai/config.json",\n  "mcp": { "existing": {"type":"local", "command":["node"],}, },\n}\n';
	write(jsoncPath, jsoncOriginal);
	const codexPath = file(jsoncHome, ".codex", "config.toml");
	const codexOriginal = "[features]\nsearch = true\n\n";
	write(codexPath, codexOriginal);
	command(jsoncHome, "install", "opencode,codex");
	assert.match(read(jsoncPath), /comment retained/);
	assert.match(read(jsoncPath), /"mobile-mcp"/);
	assert.match(read(jsoncPath), /"existing"/);
	command(jsoncHome, "uninstall", "opencode,codex");
	assert.match(read(jsoncPath), /comment retained/);
	assert.match(read(jsoncPath), /"existing"/);
	assert.doesNotMatch(read(jsoncPath), /"mobile-mcp"/);
	assert.equal(read(codexPath), codexOriginal, "Codex uninstall did not restore original spacing");
	assert.ok(exists(jsoncPath), "Original JSONC config must be preserved");

	// An injected failure mid-apply must roll back both global config and skills.
	const rollbackHome = sandbox();
	write(file(rollbackHome, ".claude", "CLAUDE.md"), "Keep original\n");
	command(rollbackHome, "install", "all", { MOBILE_MCP_SETUP_TEST_FAIL_AFTER: "3" }, false);
	assert.ok(!exists(file(rollbackHome, ".claude.json")), "Partial config remains after rollback");
	assert.equal(read(file(rollbackHome, ".claude", "CLAUDE.md")), "Keep original\n");
	assert.ok(!exists(file(rollbackHome, ".config", "mobile-mcp-build", "installed.json")), "Stale manifest after rollback");


	// JSONC without an MCP section must get a correctly inserted and removable section.
	const noMcpHome = sandbox();
	const noMcpPath = file(noMcpHome, ".config", "opencode", "opencode.jsonc");
	const noMcpBefore = '{ // preserved note\n  "theme": "dark",\n}\n';
	write(noMcpPath, noMcpBefore);
	command(noMcpHome, "install", "opencode");
	assert.match(read(noMcpPath), /"mobile-mcp"/);
	command(noMcpHome, "uninstall", "opencode");
	assert.match(read(noMcpPath), /preserved note/);
	assert.match(read(noMcpPath), /"theme"/);
	assert.doesNotMatch(read(noMcpPath), /"mobile-mcp"/);

	// Edits to installer-owned definitions must block uninstall.
	const tamperHome = sandbox();
	command(tamperHome, "install", "claude");
	const managedConfig = file(tamperHome, ".claude.json");
	const changedConfig = JSON.parse(read(managedConfig));
	changedConfig.mcpServers["mobile-mcp"].command = "user-modified";
	write(managedConfig, JSON.stringify(changedConfig, null, 2));
	command(tamperHome, "uninstall", "claude", {}, false);
	assert.match(read(managedConfig), /user-modified/);

	// An identical preexisting skill is not installer-owned and must survive uninstall.
	const sharedHome = sandbox();
	const sharedSkill = file(sharedHome, ".agents", "skills", "mobile-automation", "SKILL.md");
	const canonicalSkill = read(file(process.cwd(), "skills", "mobile-automation", "SKILL.md"));
	write(sharedSkill, canonicalSkill);
	command(sharedHome, "install", "codex");
	command(sharedHome, "uninstall", "codex");
	assert.equal(read(sharedSkill), canonicalSkill);


	// Upgrade an installation from the previous copied-skill layout.
	const upgradeHome = sandbox();
	command(upgradeHome, "install", "claude");
	const upgradeStatePath = file(upgradeHome, ".config", "mobile-mcp-build", "installed.json");
	const upgradeState = JSON.parse(read(upgradeStatePath));
	for (const name of ["mobile-automation", "build-mcp-exe"]) {
		const link = file(upgradeHome, ".claude", "skills", name);
		const canonical = file(upgradeHome, ".agents", "skills", name, "SKILL.md");
		const copy = read(canonical);
		fs.unlinkSync(link);
		write(file(link, "SKILL.md"), copy);
		delete upgradeState.links[link];
		upgradeState.skills[file(link, "SKILL.md")] = crypto.createHash("sha256").update(copy).digest("hex");
	}
	write(upgradeStatePath, JSON.stringify(upgradeState, null, 2) + "\n");
	const upgradePreview = run(upgradeHome, ["install", "--agent", "claude", "--dry-run"]);
	assert.match(upgradePreview, /Replace owned skill copy with directory junction/);
	assert.ok(fs.lstatSync(file(upgradeHome, ".claude", "skills", "mobile-automation")).isDirectory());
	command(upgradeHome, "install", "claude");
	const upgraded = file(upgradeHome, ".claude", "skills", "mobile-automation");
	assert.ok(fs.lstatSync(upgraded).isSymbolicLink(), "Old skill was not migrated to junction");
	assert.equal(fs.realpathSync(upgraded),
		fs.realpathSync(file(upgradeHome, ".agents", "skills", "mobile-automation")));
	command(upgradeHome, "uninstall", "claude");
	assert.ok(!exists(upgraded), "Owned migrated link survived uninstall");

	// Never remove a user-modified junction or follow it to a different target.
	const swappedHome = sandbox();
	command(swappedHome, "install", "claude");
	const swapped = file(swappedHome, ".claude", "skills", "build-mcp-exe");
	const foreign = file(swappedHome, "my-own-skills");
	fs.mkdirSync(foreign);
	write(file(foreign, "SKILL.md"), "DO NOT DELETE");
	fs.unlinkSync(swapped);
	fs.symlinkSync(foreign, swapped, process.platform === "win32" ? "junction" : "dir");
	command(swappedHome, "uninstall", "claude", {}, false);
	assert.equal(read(file(foreign, "SKILL.md")), "DO NOT DELETE");

	// Never overwrite an unmanaged MCP entry.
	const conflictHome = sandbox();
	const conflict = file(conflictHome, ".claude.json");
	write(conflict, JSON.stringify({ mcpServers: { "mobile-mcp": { command: "other-program" } } }));
	command(conflictHome, "install", "claude", {}, false);
	assert.match(read(conflict), /other-program/);

	console.log("Windows native binary, stdio MCP handshake, configs, JSONC, skills, rollback and dry-run: PASS");
} finally {
	for (const home of scenarios) {
		fs.rmSync(home, { recursive: true, force: true });
	}
}
