/**
 * Brings Hermes sessions started outside T3 into the Hermes workspace as
 * resumable threads, and keeps picking up new ones while the server runs.
 *
 * Imported session ids are remembered in the state directory, so a thread the
 * user deletes is not imported again.
 *
 * @module HermesHistorySync
 */
import * as NodeOS from "node:os";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  HERMES_DEFAULT_MODEL,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";

import { ServerConfig } from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { makeHermesResumeCursor } from "../provider/Layers/HermesAdapter.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { type HermesHistorySession, readHermesHistorySessions } from "./HermesHistory.ts";

const HERMES_DRIVER = ProviderDriverKind.make("hermes");
const HERMES_INSTANCE = ProviderInstanceId.make("hermes");
const HOME_PROJECT_TITLE = "Hermes";
const FIRST_SYNC_DELAY = Duration.seconds(10);
const SYNC_INTERVAL = Duration.minutes(2);

export function hermesHistoryThreadId(sessionId: string): ThreadId {
  return ThreadId.make(`import:${HERMES_INSTANCE}:${sessionId}`);
}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const serverConfig = yield* ServerConfig;
  const serverSettings = yield* ServerSettingsService;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;

  const hermesHome = process.env.HERMES_HOME?.trim() || path.join(NodeOS.homedir(), ".hermes");
  const databasePath = path.join(hermesHome, "state.db");
  const markerPath = path.join(serverConfig.stateDir, "hermes-history-imported.json");
  const newId = crypto.randomUUIDv4;

  const readImported = fileSystem.readFileString(markerPath).pipe(
    Effect.map((text) => {
      const parsed: unknown = JSON.parse(text);
      return new Set(
        Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [],
      );
    }),
    Effect.orElseSucceed(() => new Set<string>()),
  );
  const writeImported = (ids: ReadonlySet<string>) =>
    fileSystem.writeFileString(markerPath, JSON.stringify([...ids]));

  const ensureProject = (workspaceRoot: string, title: string) =>
    Effect.gen(function* () {
      const existing = yield* snapshots.getActiveProjectByWorkspaceRoot(workspaceRoot);
      if (Option.isSome(existing)) return existing.value.id;
      const projectId = ProjectId.make(yield* newId);
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make(yield* newId),
        projectId,
        title,
        workspaceRoot,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      });
      return projectId;
    });

  /** Sessions from a folder T3 already knows go there; the rest go to the Hermes home project. */
  const resolveProject = (session: HermesHistorySession) =>
    Effect.gen(function* () {
      if (session.cwd) {
        const existing = yield* snapshots.getActiveProjectByWorkspaceRoot(session.cwd);
        if (Option.isSome(existing)) {
          return { projectId: existing.value.id, workspaceRoot: session.cwd };
        }
      }
      const workspaceRoot = NodeOS.homedir();
      return { projectId: yield* ensureProject(workspaceRoot, HOME_PROJECT_TITLE), workspaceRoot };
    });

  const importSession = (session: HermesHistorySession) =>
    Effect.gen(function* () {
      const threadId = hermesHistoryThreadId(session.sessionId);
      const { projectId, workspaceRoot } = yield* resolveProject(session);
      // Install the resume cursor before the thread becomes visible, so the
      // first message continues the Hermes session instead of starting a new one.
      yield* directory.upsert(
        {
          threadId,
          provider: HERMES_DRIVER,
          providerInstanceId: HERMES_INSTANCE,
          status: "stopped",
          runtimeMode: DEFAULT_RUNTIME_MODE,
          resumeCursor: makeHermesResumeCursor(session.sessionId),
          runtimePayload: { cwd: workspaceRoot },
        },
        { onConflict: "ignore" },
      );
      if (Option.isNone(yield* snapshots.getThreadShellById(threadId))) {
        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(yield* newId),
          threadId,
          projectId,
          title: session.title,
          modelSelection: { instanceId: HERMES_INSTANCE, model: HERMES_DEFAULT_MODEL },
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt: session.startedAt,
          historyImport: true,
        });
      }
      yield* engine.dispatch({
        type: "thread.history.import",
        commandId: CommandId.make(yield* newId),
        threadId,
        messages: session.messages.map((message, index) => ({
          messageId: MessageId.make(`${threadId}:${String(index).padStart(6, "0")}`),
          role: message.role,
          text: message.text,
          createdAt: message.createdAt,
        })),
      });
    });

  const sync = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings;
    const hermes = settings.providers.hermes;
    if (!hermes.enabled || !hermes.importHistory) return;
    if (!(yield* fileSystem.exists(databasePath))) return;

    const imported = yield* readImported;
    const sessions = yield* Effect.try(() => readHermesHistorySessions(databasePath, imported));
    for (const session of sessions) {
      const result = yield* Effect.result(importSession(session));
      if (result._tag === "Failure") {
        yield* Effect.logWarning("Could not import a Hermes session", {
          sessionId: session.sessionId,
          cause: result.failure,
        });
        continue;
      }
      imported.add(session.sessionId);
      yield* writeImported(imported);
    }
    if (sessions.length > 0) {
      yield* Effect.logInfo("hermes.history.sync", { imported: sessions.length });
    }
  });

  yield* sync.pipe(
    Effect.catchCause((cause) => Effect.logWarning("Hermes history sync failed", { cause })),
    Effect.delay(FIRST_SYNC_DELAY),
    Effect.repeat(Schedule.spaced(SYNC_INTERVAL)),
    Effect.forkScoped,
  );
});

/** Starts the background Hermes history sync for the server's lifetime. */
export const HermesHistorySyncLive = Layer.effectDiscard(make);
