import {
  HERMES_DEFAULT_MODEL,
  type HermesSettings,
  type ProviderApprovalDecision,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

/** Hermes authenticates with whatever provider credentials its own config already holds. */
const HERMES_AUTH_METHOD_ID = "custom";

type HermesAcpRuntimeSettings = Pick<HermesSettings, "binaryPath">;

export interface HermesAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly hermesSettings: HermesAcpRuntimeSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildHermesAcpSpawnInput(
  hermesSettings: HermesAcpRuntimeSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: hermesSettings?.binaryPath || "hermes",
    args: ["acp"],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeHermesAcpRuntime = (
  input: HermesAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        // Hermes supports both, but `session/resume` skips the transcript replay that
        // `session/load` streams back, which T3 already has.
        resumeMethod: "resume",
        ...input,
        spawn: buildHermesAcpSpawnInput(input.hermesSettings, input.cwd, input.environment),
        authMethodId: HERMES_AUTH_METHOD_ID,
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

/**
 * Hermes approval modes, least to most permissive. `default` asks before edits,
 * `accept_edits` allows workspace edits, `dont_ask` allows every edit outside sensitive paths.
 */
export function hermesModeIdForRuntimeMode(runtimeMode: RuntimeMode): string {
  switch (runtimeMode) {
    case "approval-required":
      return "default";
    case "auto-accept-edits":
    case "auto":
      return "accept_edits";
    case "full-access":
      return "dont_ask";
  }
}

/** Resolves a T3 model slug to the Hermes model id, or undefined to keep the session's model. */
export function resolveHermesAcpModelId(model: string | null | undefined): string | undefined {
  const trimmed = model?.trim();
  return trimmed && trimmed !== HERMES_DEFAULT_MODEL ? trimmed : undefined;
}

export function currentHermesModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

/** Switches the session model only when the requested model differs from the current one. */
export function applyHermesAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModel: string | null | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const requestedModelId = resolveHermesAcpModelId(input.requestedModel);
  if (requestedModelId === undefined || requestedModelId === input.currentModelId) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime
    .setSessionModel(requestedModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(requestedModelId));
}

/** Hermes advertises approval modes through `modes`, not a `mode` config option. */
export function setHermesSessionMode(
  runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "request">,
  sessionId: string,
  modeId: string,
): Effect.Effect<void, EffectAcpErrors.AcpError> {
  return runtime.request("session/set_mode", { sessionId, modeId }).pipe(Effect.asVoid);
}

/**
 * Picks the Hermes permission option for a T3 decision. Hermes names its options
 * `allow_once`, `allow_session`, `allow_always`, `deny` and `deny_always`; a session-wide
 * approval must not select the permanent `allow_always`.
 */
export function selectHermesPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const byId = (optionId: string) =>
    request.options.find((option) => option.optionId === optionId)?.optionId;
  const byKind = (kind: EffectAcpSchema.PermissionOptionKind) =>
    request.options.find((option) => option.kind === kind)?.optionId;
  switch (decision) {
    case "acceptAlways":
      return byId("allow_always") ?? byKind("allow_always") ?? byId("allow_session");
    case "acceptForSession":
      return byId("allow_session") ?? byId("allow_once") ?? byKind("allow_once");
    case "accept":
      return byId("allow_once") ?? byKind("allow_once");
    case "decline":
      return byId("deny") ?? byKind("reject_once");
  }
}
