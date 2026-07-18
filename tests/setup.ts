/**
 * Test preload: point pi's user directory at a fresh temp dir so user-scope
 * discovery (~/.pi/agents, ~/.pi/workflows) never leaks the developer's real
 * home configuration into the suite.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agents-test-home-"));
process.env.PI_CODING_AGENT_DIR = path.join(home, "agent");
fs.mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
