import { errorFields, logError, logInfo } from "./log";

export type UpdaterPhase = "check" | "install";
export type UpdateLike = { version: string; downloadAndInstall(): Promise<void> };
export type UpdaterOutcome<U> =
  | { kind: "installed"; update: U }
  | { kind: "checked"; update: U | null }
  | { kind: "failed"; phase: UpdaterPhase; update: U | null; error: unknown };

const SEMVER_CORE = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;

/** Version from remote update metadata, logged only when it is a plain `x.y.z`. */
export function logVersion(version: string | undefined): string | undefined {
  if (version === undefined) return undefined;
  return SEMVER_CORE.test(version) ? version : "invalid";
}

export async function runUpdater<U extends UpdateLike>(
  pending: U | null,
  check: () => Promise<U | null>,
  log = { info: logInfo, error: logError },
): Promise<UpdaterOutcome<U>> {
  const phase: UpdaterPhase = pending ? "install" : "check";
  try {
    if (pending) {
      await pending.downloadAndInstall();
      log.info("updater.installed", { version: logVersion(pending.version) });
      return { kind: "installed", update: pending };
    }
    return { kind: "checked", update: await check() };
  } catch (error) {
    log.error("updater.failed", {
      phase,
      version: logVersion(pending?.version),
      ...errorFields(error),
    });
    return { kind: "failed", phase, update: pending, error };
  }
}
