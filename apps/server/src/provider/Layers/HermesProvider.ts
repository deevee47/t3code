import {
  HERMES_DEFAULT_MODEL,
  type HermesSettings,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { makeHermesAcpRuntime } from "../acp/HermesAcpSupport.ts";

const HERMES_PRESENTATION = {
  displayName: "Hermes",
  supportsConversationRollback: false,
  showInteractionModeToggle: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

const VERSION_PROBE_TIMEOUT_MS = 10_000;
// Hermes is a Python app; a cold `session/new` takes a couple of seconds.
const MODEL_PROBE_TIMEOUT_MS = 30_000;

function hermesDefaultModel(currentName?: string): ServerProviderModel {
  return {
    slug: HERMES_DEFAULT_MODEL,
    name: currentName ? `Hermes default (${currentName})` : "Hermes default",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  };
}

/** The Hermes default entry, then every model Hermes offers, as the session reports them. */
export function buildHermesModelsFromSessionModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  const available = modelState?.availableModels ?? [];
  const currentModelId = modelState?.currentModelId?.trim();
  const current = available.find((model) => model.modelId.trim() === currentModelId);
  const seen = new Set<string>([HERMES_DEFAULT_MODEL]);
  const models: ServerProviderModel[] = [
    hermesDefaultModel(current?.name.trim() || currentModelId || undefined),
  ];
  for (const model of available) {
    const slug = model.modelId.trim();
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    models.push({
      slug,
      name: model.name.trim() || slug,
      isCustom: false,
      capabilities: EMPTY_CAPABILITIES,
    });
  }
  return models;
}

function hermesModels(
  settings: HermesSettings,
  discovered: ReadonlyArray<ServerProviderModel> = [hermesDefaultModel()],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(discovered, settings.customModels ?? [], EMPTY_CAPABILITIES);
}

export function buildInitialHermesProviderSnapshot(
  settings: HermesSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.map(DateTime.now, (now) =>
    buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: settings.enabled,
      checkedAt: DateTime.formatIso(now),
      models: hermesModels(settings),
      probe: {
        installed: settings.enabled,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "Checking Hermes Agent availability..."
          : "Hermes is disabled in T3 Code settings.",
      },
    }),
  );
}

/**
 * Hermes reports its model menu only from session setup. A new session that is never
 * prompted is not saved to Hermes history, so the probe leaves nothing behind.
 */
const discoverHermesModels = (settings: HermesSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeHermesAcpRuntime({
      hermesSettings: settings,
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* acp.start();
    return buildHermesModelsFromSessionModelState(started.sessionSetupResult.models);
  }).pipe(Effect.scoped);

export const checkHermesProviderStatus = Effect.fn("checkHermesProviderStatus")(function* (
  settings: HermesSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = hermesModels(settings);
  const build = (
    input: Omit<
      Parameters<typeof buildServerProvider>[0],
      "presentation" | "enabled" | "checkedAt"
    >,
  ) =>
    buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      ...input,
    });

  if (!settings.enabled) {
    return build({
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Hermes is disabled in T3 Code settings.",
      },
    });
  }

  const command = settings.binaryPath || "hermes";
  const versionResult = yield* Effect.gen(function* () {
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  }).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionResult) || Option.isNone(versionResult.success)) {
    const missing = Result.isFailure(versionResult) && isCommandMissingCause(versionResult.failure);
    return build({
      models: fallbackModels,
      probe: {
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: missing
          ? "Hermes Agent (`hermes`) is not installed or not on PATH."
          : "Hermes Agent did not answer `hermes --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  const modelsExit = yield* discoverHermesModels(settings, environment).pipe(
    Effect.timeoutOption(MODEL_PROBE_TIMEOUT_MS),
    Effect.exit,
  );
  const discovered =
    Exit.isSuccess(modelsExit) && Option.isSome(modelsExit.value) ? modelsExit.value.value : [];
  const modelsFailed = discovered.length === 0;
  if (modelsFailed) {
    yield* Effect.logWarning("Hermes ACP model probe failed or timed out.", {
      errorTag: Exit.isFailure(modelsExit) ? causeErrorTag(modelsExit.cause) : "Timeout",
    });
  }

  return build({
    models: modelsFailed ? fallbackModels : hermesModels(settings, discovered),
    slashCommands: [COMPACT_SLASH_COMMAND],
    probe: {
      installed: true,
      version,
      // A failed model probe degrades the picker; chats still run on Hermes's default model.
      status: modelsFailed ? "warning" : "ready",
      auth: modelsFailed
        ? { status: "unknown" }
        : { status: "authenticated", type: "cached_token", label: "Hermes config" },
      ...(modelsFailed
        ? {
            message:
              "Hermes is installed but did not report its models. Run `hermes setup` if chats fail.",
          }
        : {}),
    },
  });
});
