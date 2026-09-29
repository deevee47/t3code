/**
 * `t3 thread` — list, read, message and steer the threads of a running T3 Code.
 *
 * Talks to the live server over its HTTP API with a short-lived admin session,
 * the same way `t3 project` does. Built so agents such as Hermes can drive T3.
 */
import {
  AuthAdministrativeScopes,
  type ClientOrchestrationCommand,
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  EnvironmentHttpApi,
  MessageId,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell,
  ProjectId,
  ProviderApprovalDecision,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import * as HttpApiClient from "effect/unstable/httpapi/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { type CliAuthLocationFlags, projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import {
  formatMessage,
  formatThreadList,
  isThreadBusy,
  pendingApprovalsFromActivities,
  threadCliStatus,
  toPrettyJson,
} from "./threadFormat.ts";

class ThreadCliError extends Schema.TaggedError<ThreadCliError>()("ThreadCliError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

const LIVE_SERVER_TIMEOUT = Duration.seconds(15);
const WATCH_INTERVAL = Duration.seconds(2);
const HERMES_INSTANCE = ProviderInstanceId.make("hermes");
const decodeApprovalDecision = Schema.decodeEffect(ProviderApprovalDecision);

const makeClient = (origin: string) => HttpApiClient.make(EnvironmentHttpApi, { baseUrl: origin });
type LiveClient = Effect.Success<ReturnType<typeof makeClient>>;

interface LiveServer {
  readonly client: LiveClient;
  readonly headers: { readonly authorization: string };
}

const liveError = (detail: string) => (cause: unknown) => new ThreadCliError({ detail, cause });

/** Runs `run` against the running T3 server, or fails with a hint to open the app. */
const withLiveServer = <A, E, R>(
  flags: CliAuthLocationFlags,
  run: (server: LiveServer) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    return yield* Effect.gen(function* () {
      const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
      if (Option.isNone(runtimeState)) {
        return yield* new ThreadCliError({
          detail: "T3 Code is not running. Open the app (or run `t3 start`) and try again.",
        });
      }
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
      const client = yield* makeClient(runtimeState.value.origin);
      return yield* Effect.acquireUseRelease(
        environmentAuth.issueSession({ scopes: AuthAdministrativeScopes, label: "t3 thread cli" }),
        (issued) => run({ client, headers: { authorization: `Bearer ${issued.token}` } }),
        (issued) => environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore),
      );
    }).pipe(
      Effect.provide(
        EnvironmentAuth.runtimeLayer.pipe(
          Layer.provideMerge(FetchHttpClient.layer),
          Layer.provide(ServerConfig.layer(config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, config.logLevel)),
        ),
      ),
    );
  });

const shellSnapshot = (server: LiveServer) =>
  server.client.orchestration
    .shellSnapshot({ headers: server.headers })
    .pipe(
      Effect.timeout(LIVE_SERVER_TIMEOUT),
      Effect.mapError(liveError("Could not read threads from T3 Code.")),
    );

const threadDetail = (server: LiveServer, threadId: ThreadId) =>
  server.client.orchestration
    .threadSnapshot({ headers: server.headers, params: { threadId }, payload: {} })
    .pipe(
      Effect.timeout(LIVE_SERVER_TIMEOUT),
      Effect.mapError(liveError(`Could not read thread ${threadId}.`)),
    );

const dispatch = (server: LiveServer, command: ClientOrchestrationCommand) =>
  server.client.orchestration
    .dispatch({ headers: server.headers, payload: command } as Parameters<
      LiveClient["orchestration"]["dispatch"]
    >[0])
    .pipe(
      Effect.timeout(LIVE_SERVER_TIMEOUT),
      Effect.mapError(liveError(`T3 Code rejected ${command.type}.`)),
    );

const newUuid = Crypto.Crypto.pipe(
  Effect.flatMap((crypto) => crypto.randomUUIDv4),
  Effect.mapError(liveError("Could not generate an id.")),
);
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const findThread = (snapshot: OrchestrationShellSnapshot, threadId: string) => {
  const matches = snapshot.threads.filter(
    (thread) => thread.id === threadId || thread.id.startsWith(threadId),
  );
  if (matches.length === 1) return Effect.succeed(matches[0]!);
  return Effect.fail(
    new ThreadCliError({
      detail:
        matches.length === 0
          ? `No thread matches '${threadId}'. Run \`t3 thread list\`.`
          : `'${threadId}' matches ${matches.length} threads; use more of the id.`,
    }),
  );
};

const sendMessage = (server: LiveServer, thread: OrchestrationThreadShell, text: string) =>
  Effect.gen(function* () {
    yield* dispatch(server, {
      type: "thread.turn.start",
      commandId: CommandId.make(yield* newUuid),
      threadId: thread.id,
      message: { messageId: MessageId.make(yield* newUuid), role: "user", text, attachments: [] },
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      createdAt: yield* nowIso,
    });
  });

/** Polls until the thread stops working, printing each new assistant message once. */
const waitForThread = (server: LiveServer, threadId: ThreadId, printFrom: number) =>
  Effect.gen(function* () {
    let printed = printFrom;
    let sawWork = false;
    for (;;) {
      const { thread } = yield* threadDetail(server, threadId);
      for (const message of thread.messages.slice(printed)) {
        if (message.role === "assistant" && !message.streaming) {
          yield* Console.log(formatMessage(message));
        }
      }
      printed = thread.messages.filter((message) => !message.streaming).length;
      const status = threadCliStatus({
        ...thread,
        hasPendingApprovals: pendingApprovalsFromActivities(thread.activities).length > 0,
        hasPendingUserInput: false,
      });
      if (isThreadBusy(status)) sawWork = true;
      else if (sawWork || status !== "idle") {
        yield* Console.log(`[thread ${threadId} is ${status}]`);
        return;
      }
      yield* Effect.sleep(WATCH_INTERVAL);
    }
  });

const jsonFlag = Flag.boolean("json").pipe(Flag.withDescription("Print JSON."));
const threadIdArgument = Argument.string("thread-id").pipe(
  Argument.withDescription("Thread id, or a unique prefix of it."),
);

const listCommand = Command.make("list", {
  ...projectLocationFlags,
  json: jsonFlag,
  workspace: Flag.choice("workspace", ["all", "t3", "hermes"]).pipe(
    Flag.withDescription("Only T3 threads or only Hermes threads."),
    Flag.withDefault("all"),
  ),
  archived: Flag.boolean("archived").pipe(Flag.withDescription("Include archived threads.")),
}).pipe(
  Command.withDescription("List threads with their status: working, needs-approval, settled…"),
  Command.withHandler((flags) =>
    withLiveServer(flags, (server) =>
      Effect.gen(function* () {
        const snapshot = yield* shellSnapshot(server);
        const threads = snapshot.threads
          .filter((thread) => flags.archived || thread.archivedAt === null)
          .filter((thread) => {
            const isHermes = thread.modelSelection.instanceId.startsWith(HERMES_INSTANCE);
            return flags.workspace === "all" || (flags.workspace === "hermes") === isHermes;
          })
          .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
        yield* Console.log(
          flags.json
            ? toPrettyJson(
                threads.map((thread) => ({
                  id: thread.id,
                  title: thread.title,
                  status: threadCliStatus(thread),
                  provider: thread.modelSelection.instanceId,
                  model: thread.modelSelection.model,
                  projectId: thread.projectId,
                  updatedAt: thread.updatedAt,
                })),
              )
            : formatThreadList(threads, snapshot.projects),
        );
      }),
    ),
  ),
);

const showCommand = Command.make("show", {
  ...projectLocationFlags,
  threadId: threadIdArgument,
  json: jsonFlag,
  last: Flag.integer("last").pipe(
    Flag.withDescription("How many recent messages to print."),
    Flag.withDefault(10),
  ),
}).pipe(
  Command.withDescription("Print a thread's status, pending approvals and recent messages."),
  Command.withHandler((flags) =>
    withLiveServer(flags, (server) =>
      Effect.gen(function* () {
        const shell = yield* findThread(yield* shellSnapshot(server), flags.threadId);
        const { thread } = yield* threadDetail(server, shell.id);
        const approvals = pendingApprovalsFromActivities(thread.activities);
        const messages = thread.messages.slice(-Math.max(1, flags.last));
        if (flags.json) {
          yield* Console.log(
            toPrettyJson({
              id: thread.id,
              title: thread.title,
              status: threadCliStatus(shell),
              provider: thread.modelSelection.instanceId,
              model: thread.modelSelection.model,
              pendingApprovals: approvals,
              messages: messages.map(({ role, text, createdAt }) => ({ role, text, createdAt })),
            }),
          );
          return;
        }
        const header = [
          `${thread.title}`,
          `id ${thread.id} · ${threadCliStatus(shell)} · ${thread.modelSelection.instanceId}/${thread.modelSelection.model}`,
          ...approvals.map(
            (approval) =>
              `pending approval ${approval.requestId}: ${approval.detail ?? "(no detail)"}`,
          ),
        ];
        yield* Console.log([...header, "", ...messages.map(formatMessage)].join("\n"));
      }),
    ),
  ),
);

const waitFlag = Flag.boolean("wait").pipe(
  Flag.withDescription("Wait for the agent to finish and print its reply."),
);

const sendCommand = Command.make("send", {
  ...projectLocationFlags,
  threadId: threadIdArgument,
  text: Argument.string("message").pipe(Argument.withDescription("Message to send.")),
  wait: waitFlag,
}).pipe(
  Command.withDescription("Send a message to a thread. A working thread takes it as a follow-up."),
  Command.withHandler((flags) =>
    withLiveServer(flags, (server) =>
      Effect.gen(function* () {
        const shell = yield* findThread(yield* shellSnapshot(server), flags.threadId);
        const before = (yield* threadDetail(server, shell.id)).thread.messages.length;
        yield* sendMessage(server, shell, flags.text);
        yield* Console.log(`Sent to ${shell.id}.`);
        if (flags.wait) yield* waitForThread(server, shell.id, before);
      }),
    ),
  ),
);

const newCommand = Command.make("new", {
  ...projectLocationFlags,
  text: Argument.string("message").pipe(Argument.withDescription("First message.")),
  project: Flag.string("project").pipe(
    Flag.withDescription("Project id, title or folder path. Defaults to the most recent project."),
    Flag.optional,
  ),
  provider: Flag.string("provider").pipe(
    Flag.withDescription("Provider instance, e.g. hermes, codex, claudeAgent."),
    Flag.withDefault("hermes"),
  ),
  model: Flag.string("model").pipe(Flag.withDescription("Model slug."), Flag.optional),
  wait: waitFlag,
}).pipe(
  Command.withDescription("Start a new thread and send its first message."),
  Command.withHandler((flags) =>
    withLiveServer(flags, (server) =>
      Effect.gen(function* () {
        const snapshot = yield* shellSnapshot(server);
        const wanted = Option.getOrUndefined(flags.project);
        const projects = snapshot.projects.toSorted((left, right) =>
          right.updatedAt.localeCompare(left.updatedAt),
        );
        const project = wanted
          ? projects.find(
              (entry) =>
                entry.id === wanted || entry.title === wanted || entry.workspaceRoot === wanted,
            )
          : projects[0];
        if (!project) {
          return yield* new ThreadCliError({
            detail: wanted
              ? `No project matches '${wanted}'. Add it with \`t3 project add <path>\`.`
              : "T3 Code has no projects yet. Add one with `t3 project add <path>`.",
          });
        }
        const instanceId = ProviderInstanceId.make(flags.provider);
        const driverDefault = DEFAULT_MODEL_BY_PROVIDER[flags.provider as never] as
          | string
          | undefined;
        const model = Option.getOrUndefined(flags.model) ?? driverDefault;
        if (!model) {
          return yield* new ThreadCliError({ detail: "Pass --model for this provider." });
        }
        const threadId = ThreadId.make(yield* newUuid);
        const title = flags.text.replace(/\s+/g, " ").trim().slice(0, 60) || "New thread";
        yield* dispatch(server, {
          type: "thread.create",
          commandId: CommandId.make(yield* newUuid),
          threadId,
          projectId: ProjectId.make(project.id),
          title,
          modelSelection: { instanceId, model },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: yield* nowIso,
        });
        const created = yield* findThread(yield* shellSnapshot(server), threadId);
        yield* sendMessage(server, created, flags.text);
        yield* Console.log(`Started ${threadId} in ${project.title}.`);
        if (flags.wait) yield* waitForThread(server, threadId, 0);
      }),
    ),
  ),
);

const stopCommand = Command.make("stop", {
  ...projectLocationFlags,
  threadId: threadIdArgument,
}).pipe(
  Command.withDescription("Stop the thread's running turn."),
  Command.withHandler((flags) =>
    withLiveServer(flags, (server) =>
      Effect.gen(function* () {
        const shell = yield* findThread(yield* shellSnapshot(server), flags.threadId);
        yield* dispatch(server, {
          type: "thread.turn.interrupt",
          commandId: CommandId.make(yield* newUuid),
          threadId: shell.id,
          createdAt: yield* nowIso,
        });
        yield* Console.log(`Stopping ${shell.id}.`);
      }),
    ),
  ),
);

const approveCommand = Command.make("approve", {
  ...projectLocationFlags,
  threadId: threadIdArgument,
  decision: Flag.choice("decision", ["accept", "acceptForSession", "decline", "cancel"]).pipe(
    Flag.withDescription("accept once, accept for the session, decline, or cancel the turn."),
    Flag.withDefault("accept"),
  ),
}).pipe(
  Command.withDescription("Answer the thread's oldest pending approval request."),
  Command.withHandler((flags) =>
    withLiveServer(flags, (server) =>
      Effect.gen(function* () {
        const shell = yield* findThread(yield* shellSnapshot(server), flags.threadId);
        const [approval] = pendingApprovalsFromActivities(
          (yield* threadDetail(server, shell.id)).thread.activities,
        );
        if (!approval) {
          return yield* new ThreadCliError({ detail: `${shell.id} has no pending approval.` });
        }
        yield* dispatch(server, {
          type: "thread.approval.respond",
          commandId: CommandId.make(yield* newUuid),
          threadId: shell.id,
          requestId: approval.requestId,
          decision: yield* decodeApprovalDecision(flags.decision).pipe(
            Effect.mapError(liveError(`Unknown decision ${flags.decision}.`)),
          ),
          createdAt: yield* nowIso,
        });
        yield* Console.log(`Answered ${approval.requestId} with ${flags.decision}.`);
      }),
    ),
  ),
);

const watchCommand = Command.make("watch", {
  ...projectLocationFlags,
  threadId: Argument.string("thread-id").pipe(
    Argument.withDescription("Follow one thread until it finishes, instead of all threads."),
    Argument.optional,
  ),
}).pipe(
  Command.withDescription("Print status changes as they happen. Stop with Ctrl-C."),
  Command.withHandler((flags) =>
    withLiveServer(flags, (server) =>
      Effect.gen(function* () {
        const single = Option.getOrUndefined(flags.threadId);
        if (single) {
          const shell = yield* findThread(yield* shellSnapshot(server), single);
          const printed = (yield* threadDetail(server, shell.id)).thread.messages.length;
          yield* Console.log(`Watching ${shell.id} (${threadCliStatus(shell)})…`);
          return yield* waitForThread(server, shell.id, printed);
        }
        const lastStatus = new Map<string, string>();
        for (let first = true; ; first = false) {
          const snapshot = yield* shellSnapshot(server);
          for (const thread of snapshot.threads) {
            if (thread.archivedAt !== null) continue;
            const status = threadCliStatus(thread);
            if (!first && lastStatus.get(thread.id) !== status) {
              yield* Console.log(
                `${yield* nowIso}  ${thread.id}  ${status.padEnd(14)}  ${thread.title}`,
              );
            }
            lastStatus.set(thread.id, status);
          }
          if (first) yield* Console.log(`Watching ${lastStatus.size} threads…`);
          yield* Effect.sleep(WATCH_INTERVAL);
        }
      }),
    ),
  ),
);

export const threadCommand = Command.make("thread").pipe(
  Command.withDescription("Work with the threads of a running T3 Code."),
  Command.withSubcommands([
    listCommand,
    showCommand,
    sendCommand,
    newCommand,
    stopCommand,
    approveCommand,
    watchCommand,
  ]),
);
