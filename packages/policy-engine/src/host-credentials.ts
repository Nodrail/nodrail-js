import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  readSecretFile,
  removeSecretFile,
  writeSecretFile,
} from "./secret-store.ts";

const nativeStore = { readSecretFile, writeSecretFile, removeSecretFile };

type Binding = {
  origin: string;
  workspace: string;
  environment: string;
  projectId: string;
};
type HostCredential = Binding & { credential: string; installationId: string };

function pathOf(home: string, binding: Binding) {
  const key = JSON.stringify([
    binding.origin,
    binding.workspace,
    binding.environment,
    binding.projectId,
  ]);
  const hash = createHash("sha256").update(key).digest("hex");
  return join(home, ".nodrail", "hosts", `${hash}.json`);
}

function readCredential(
  home: string,
  binding: Binding,
  store: typeof nativeStore,
): HostCredential | null {
  try {
    const text = store.readSecretFile(pathOf(home, binding));
    if (!text) return null;
    const record = JSON.parse(text) as Partial<HostCredential> | null;
    if (
      !record ||
      record.origin !== binding.origin ||
      record.workspace !== binding.workspace ||
      record.environment !== binding.environment ||
      record.projectId !== binding.projectId ||
      typeof record.credential !== "string" ||
      !/^ndr_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/.test(record.credential) ||
      typeof record.installationId !== "string"
    )
      return null;
    return record as HostCredential;
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      (error as NodeJS.ErrnoException).code === "ENOENT"
    )
      return null;
    throw error;
  }
}

export async function readHostCredential(
  home: string,
  binding: Binding,
  store = nativeStore,
) {
  return readCredential(home, binding, store);
}

export async function writeHostCredential(
  home: string,
  record: HostCredential,
  guard?: {
    commit: NonNullable<Parameters<typeof writeSecretFile>[2]>;
    previousGeneration: string | undefined;
  },
  store = nativeStore,
) {
  store.writeSecretFile(
    pathOf(home, record),
    `${JSON.stringify(record)}\n`,
    guard &&
      ((replace) => {
        guard.commit(() => {
          const generation = readCredential(
            home,
            record,
            store,
          )?.credential.slice(4, 16);
          if (generation !== guard.previousGeneration)
            throw new Error(
              "The machine credential generation changed. Run nodrail apply again.",
            );
          replace();
        });
      }),
  );
}

export function removeHostCredential(
  home: string,
  binding: Binding,
  store = nativeStore,
) {
  store.removeSecretFile(pathOf(home, binding));
}
