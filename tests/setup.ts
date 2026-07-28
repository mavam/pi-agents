/**
 * Test preload: point pi's user directory and HOME at a fresh temp dir so
 * user-scope discovery (~/.pi/agent/{agents,skills,workflows} and
 * ~/.agents/skills) never leaks the developer's real home configuration into
 * the suite.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-test-home-"));
process.env.PI_CODING_AGENT_DIR = path.join(home, "agent");
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
// Skill discovery reads `~/.agents/skills`, resolved through HOME exactly as
// pi resolves it. Without this the suite would read the developer's own
// portable skills.
process.env.HOME = home;
