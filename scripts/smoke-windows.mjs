import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const exe = path.resolve("dist", "mobile-mcp.exe");
const companion = path.resolve("dist", "mobilecli-windows-amd64.exe");
assert.ok(fs.existsSync(exe), "Windows EXE exists");
assert.ok(fs.existsSync(companion), "native mobilecli companion exists");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-mcp-smoke-"));
const env = { ...process.env,
  MOBILE_MCP_SETUP_HOME: sandbox,
  MOBILEMCP_DISABLE_TELEMETRY: "1",
  MOBILEWRIGHT_DISABLE_TELEMETRY: "1",
  DO_NOT_TRACK: "1"
};
function call(...args) {
  const ret = spawnSync(exe, args, { env, encoding: "utf8", timeout: 45000 });
  assert.equal(ret.status, 0, "Command " + args.join(" ") + " failed: " + (ret.stderr || "") + "\n" + (ret.stdout || ""));
  return ret.stdout;
}
try {
  assert.match(call("--help"), /install/);
  assert.match(call("install", "--help"), /dry-run/);
  assert.match(call("uninstall", "--help"), /dry-run/);
  assert.match(call("install", "--agent", "all", "--dry-run"), /Dry run complete/);
  assert.deepEqual(fs.readdirSync(sandbox), [], "dry-run created files");

  const claudeInstructions = path.join(sandbox, ".claude", "CLAUDE.md");
  fs.mkdirSync(path.dirname(claudeInstructions), { recursive: true });
  fs.writeFileSync(claudeInstructions, "My existing rule stays.\n", "utf8");
  call("install", "--agent", "all");
  const claude = JSON.parse(fs.readFileSync(path.join(sandbox, ".claude.json"), "utf8"));
  assert.equal(claude.mcpServers["mobile-mcp"].command, exe);
  assert.equal(claude.mcpServers["mobile-mcp"].env.DO_NOT_TRACK, "1");
  assert.ok(fs.existsSync(path.join(sandbox, ".agents", "skills", "mobile-automation", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(sandbox, ".agents", "skills", "build-mcp-exe", "SKILL.md")));
  assert.match(fs.readFileSync(claudeInstructions, "utf8"), /My existing rule stays/);

  // Verify install/uninstall dry run does not alter any files.
  const before = fs.readFileSync(path.join(sandbox, ".claude.json"), "utf8");
  call("uninstall", "--agent", "all", "--dry-run");
  assert.equal(fs.readFileSync(path.join(sandbox, ".claude.json"), "utf8"), before);
  call("uninstall", "--agent", "all");
  assert.equal(fs.readFileSync(claudeInstructions, "utf8"), "My existing rule stays.\n");
  assert.ok(!fs.existsSync(path.join(sandbox, ".claude.json")), "uninstaller removed a config file created by the installer");
  assert.ok(!fs.existsSync(path.join(sandbox, ".agents", "skills", "build-mcp-exe", "SKILL.md")));
  console.log("All EXE/install/uninstall/safe-dry-run smoke tests passed.");
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}
