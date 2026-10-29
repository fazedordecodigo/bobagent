import { type VmCredential, VmCredentialKind, type VmCredentialProvider } from "@upbot/protocol";
import { z } from "zod";
import type { Vault } from "../vault";

// Provider logins for Firecracker microVM sessions. Stored encrypted in the vault under
// `vmcred.<provider>` (hidden from vault.list and never shared with agents). The value only
// travels inside the run spec over SSH stdin and the guest vsock, and becomes environment
// variables of the provider process inside the VM.

const PREFIX = "vmcred.";

export const VM_CREDENTIAL_ENV: Record<
  VmCredentialProvider,
  Partial<Record<VmCredentialKind, string[]>>
> = {
  claude: { oauth_token: ["CLAUDE_CODE_OAUTH_TOKEN"], api_key: ["ANTHROPIC_API_KEY"] },
  codex: { api_key: ["OPENAI_API_KEY", "CODEX_API_KEY"] },
  gemini: { api_key: ["GEMINI_API_KEY"] },
  cursor: { api_key: ["CURSOR_API_KEY"] },
};

const isProvider = (p: string): p is VmCredentialProvider => p in VM_CREDENTIAL_ENV;

const STORED_ENTRY = z.object({ kind: VmCredentialKind, value: z.string() });

export class VmCredentials {
  constructor(private vault: Vault) {}

  /** Stored `{kind, value}` for a provider, or null when none is saved. A stored entry
   * that fails to decrypt or parse is logged and reads as absent. */
  private readEntry(provider: VmCredentialProvider): z.infer<typeof STORED_ENTRY> | null {
    const name = `${PREFIX}${provider}`;
    if (!this.vault.internalEntries(name).some((e) => e.name === name)) return null;
    try {
      return STORED_ENTRY.parse(JSON.parse(this.vault.revealInternal(name)));
    } catch {
      console.error("UpBot could not read a stored microVM credential", {
        provider,
        reason: "invalid_entry",
      });
      return null;
    }
  }

  list(): VmCredential[] {
    return this.vault
      .internalEntries(PREFIX)
      .map((e) => {
        const provider = e.name.slice(PREFIX.length);
        if (!isProvider(provider)) return null;
        const entry = this.readEntry(provider);
        return entry ? { provider, kind: entry.kind, updatedAt: e.updatedAt } : null;
      })
      .filter((c): c is VmCredential => c !== null);
  }

  set(provider: VmCredentialProvider, kind: VmCredentialKind, value: string): VmCredential {
    if (!VM_CREDENTIAL_ENV[provider][kind]) throw new Error(`${provider} does not accept ${kind}`);
    this.vault.set(`${PREFIX}${provider}`, JSON.stringify({ kind, value }), []);
    return this.list().find((c) => c.provider === provider)!;
  }

  delete(provider: VmCredentialProvider): boolean {
    return this.vault.delete(`${PREFIX}${provider}`);
  }

  /** Environment variables for a provider session inside a microVM ({} when none is set). */
  env(provider: string): Record<string, string> {
    if (!isProvider(provider)) return {};
    const entry = this.readEntry(provider);
    if (!entry) return {};
    return Object.fromEntries(
      (VM_CREDENTIAL_ENV[provider][entry.kind] ?? []).map((k) => [k, entry.value]),
    );
  }
}
