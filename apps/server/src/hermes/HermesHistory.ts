/**
 * Reads Hermes Agent's session store (`~/.hermes/state.db`) so sessions started
 * outside T3 (Hermes desktop, CLI, cron, messaging gateways) can appear as threads.
 *
 * The database is opened read-only; Hermes stays its only writer.
 *
 * @module HermesHistory
 */
import * as NodeSqlite from "node:sqlite";

import * as DateTime from "effect/DateTime";

export interface HermesHistoryMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

export interface HermesHistorySession {
  readonly sessionId: string;
  readonly source: string;
  readonly title: string;
  readonly cwd: string | null;
  readonly model: string | null;
  readonly startedAt: string;
  readonly messages: ReadonlyArray<HermesHistoryMessage>;
}

/** Sessions T3 itself creates over ACP already have a thread. */
const T3_OWNED_SOURCES = new Set(["acp"]);
const TITLE_MAX_LENGTH = 80;

function isoFromEpochSeconds(value: unknown): string {
  const seconds = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return DateTime.formatIso(DateTime.makeUnsafe(Math.round(seconds * 1000)));
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Hermes records model switches and other notes as `[System: …]` user turns. */
function isHermesSystemNote(text: string): boolean {
  return text.startsWith("[System:");
}

/** Drops leading `[…]` instruction paragraphs, such as the preamble Hermes gives cron jobs. */
function withoutBracketedPreamble(text: string): string {
  const paragraphs = text.split(/\n\s*\n/);
  while (paragraphs.length > 1 && /^\[[\s\S]*\]$/.test(paragraphs[0]!.trim())) {
    paragraphs.shift();
  }
  return paragraphs.join("\n\n");
}

export function titleForHermesSession(input: {
  readonly displayName: string | null;
  readonly firstUserText: string | undefined;
  readonly source: string;
}): string {
  const raw =
    input.displayName ??
    (input.firstUserText === undefined
      ? undefined
      : withoutBracketedPreamble(input.firstUserText).replace(/\s+/g, " ").trim()) ??
    `Hermes ${input.source} session`;
  const title = raw || `Hermes ${input.source} session`;
  return title.length > TITLE_MAX_LENGTH ? `${title.slice(0, TITLE_MAX_LENGTH - 1)}…` : title;
}

/**
 * Lists sessions not created by T3, oldest first, skipping ids in `exclude`.
 * Sessions without a visible user or assistant message are left out.
 */
export function readHermesHistorySessions(
  databasePath: string,
  exclude: ReadonlySet<string>,
): ReadonlyArray<HermesHistorySession> {
  const database = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
  try {
    const sessionRows = database
      .prepare(
        `SELECT id, source, display_name, cwd, model, started_at
         FROM sessions
         WHERE parent_session_id IS NULL
         ORDER BY started_at ASC`,
      )
      .all();
    const messageQuery = database.prepare(
      `SELECT role, content, timestamp
       FROM messages
       WHERE session_id = ? AND active = 1 AND role IN ('user', 'assistant')
       ORDER BY timestamp ASC, id ASC`,
    );

    const sessions: HermesHistorySession[] = [];
    for (const row of sessionRows) {
      const sessionId = nonEmpty(row.id);
      const source = nonEmpty(row.source) ?? "unknown";
      if (!sessionId || T3_OWNED_SOURCES.has(source) || exclude.has(sessionId)) continue;

      const messages: HermesHistoryMessage[] = [];
      for (const message of messageQuery.all(sessionId)) {
        const text = nonEmpty(message.content);
        const role = message.role === "user" ? "user" : "assistant";
        if (!text || (role === "user" && isHermesSystemNote(text))) continue;
        messages.push({ role, text, createdAt: isoFromEpochSeconds(message.timestamp) });
      }
      if (messages.length === 0) continue;

      sessions.push({
        sessionId,
        source,
        title: titleForHermesSession({
          displayName: nonEmpty(row.display_name),
          firstUserText: messages.find((message) => message.role === "user")?.text,
          source,
        }),
        cwd: nonEmpty(row.cwd),
        model: nonEmpty(row.model),
        startedAt: isoFromEpochSeconds(row.started_at),
        messages,
      });
    }
    return sessions;
  } finally {
    database.close();
  }
}
