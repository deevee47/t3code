import * as FS from "node:fs";
import * as NodeSqlite from "node:sqlite";
import * as OS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { readHermesHistorySessions, titleForHermesSession } from "./HermesHistory.ts";

const tempDirs: string[] = [];

function makeHermesDatabase(): string {
  const dir = FS.mkdtempSync(NodePath.join(OS.tmpdir(), "hermes-history-"));
  tempDirs.push(dir);
  const path = NodePath.join(dir, "state.db");
  const db = new NodeSqlite.DatabaseSync(path);
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, display_name TEXT,
      cwd TEXT, model TEXT, parent_session_id TEXT, started_at REAL NOT NULL);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
      content TEXT, timestamp REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    INSERT INTO sessions VALUES ('desk', 'desktop', NULL, NULL, 'm1', NULL, 100);
    INSERT INTO sessions VALUES ('mine', 'acp', NULL, '/repo', NULL, NULL, 90);
    INSERT INTO sessions VALUES ('child', 'desktop', NULL, NULL, NULL, 'desk', 110);
    INSERT INTO sessions VALUES ('empty', 'cron', NULL, NULL, NULL, NULL, 120);
    INSERT INTO messages (session_id, role, content, timestamp) VALUES
      ('desk', 'user', 'Plan my week', 101),
      ('desk', 'tool', '{"tools":{}}', 102),
      ('desk', 'user', '[System: The active model changed]', 103),
      ('desk', 'assistant', 'Here is a plan', 104),
      ('mine', 'user', 'hello', 91),
      ('child', 'user', 'forked', 111),
      ('empty', 'tool', 'noop', 121);
    INSERT INTO messages (session_id, role, content, timestamp, active) VALUES
      ('desk', 'assistant', 'compressed away', 105, 0);
  `);
  db.close();
  return path;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) FS.rmSync(dir, { recursive: true, force: true });
});

describe("readHermesHistorySessions", () => {
  it("returns root sessions started outside T3 with their visible conversation", () => {
    const sessions = readHermesHistorySessions(makeHermesDatabase(), new Set());

    expect(sessions.map((session) => session.sessionId)).toEqual(["desk"]);
    expect(sessions[0]).toMatchObject({
      source: "desktop",
      title: "Plan my week",
      model: "m1",
      startedAt: "1970-01-01T00:01:40.000Z",
    });
    expect(sessions[0]?.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "Plan my week"],
      ["assistant", "Here is a plan"],
    ]);
  });

  it("skips sessions that were already imported", () => {
    expect(readHermesHistorySessions(makeHermesDatabase(), new Set(["desk"]))).toEqual([]);
  });
});

describe("titleForHermesSession", () => {
  it("prefers the Hermes display name and shortens long prompts", () => {
    expect(
      titleForHermesSession({ displayName: "Named", firstUserText: "ignored", source: "desktop" }),
    ).toBe("Named");
    const title = titleForHermesSession({
      displayName: null,
      firstUserText: `${"word ".repeat(40)}\nend`,
      source: "desktop",
    });
    expect(title.length).toBe(80);
    expect(title.endsWith("…")).toBe(true);
    expect(
      titleForHermesSession({
        displayName: null,
        firstUserText: "[IMPORTANT: cron rules, say [SILENT] if idle.]\n\nBuild a meal plan",
        source: "cron",
      }),
    ).toBe("Build a meal plan");
    expect(
      titleForHermesSession({ displayName: null, firstUserText: undefined, source: "cron" }),
    ).toBe("Hermes cron session");
  });
});
