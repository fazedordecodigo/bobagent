import type { VmCredential, VmCredentialKind, VmCredentialProvider } from "@upbot/protocol";
import { type Vault, VMCRED_PREFIX } from "../vault";

// Provider logins for Firecracker microVM sessions. Stored encrypted in the vault under
// `vmcred.<provider>` (hidden from vault.list and never shared with agents). The value only
// travels inside the run spec over SSH stdin and the guest vsock, and becomes environment
// variables of the provider process inside the VM.

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

export class VmCredentials {
  constructor(private vault: Vault) {}

  list(): VmCredential[] {
    return this.vault
      .internalEntries(VMCRED_PREFIX)
      .map((e) => {
        const provider = e.name.slice(VMCRED_PREFIX.length);
        if (!isProvider(provider)) return null;
        const { kind } = JSON.parse(this.vault.revealInternal(e.name)) as {
          kind: VmCredentialKind;
        };
        return { provider, kind, updatedAt: e.updatedAt };
      })
      .filter((c): c is VmCredential => c !== null);
  }

  set(provider: VmCredentialProvider, kind: VmCredentialKind, value: string): VmCredential {
    if (!VM_CREDENTIAL_ENV[provider][kind]) throw new Error(`${provider} does not accept ${kind}`);
    this.vault.set(`${VMCRED_PREFIX}${provider}`, JSON.stringify({ kind, value }), []);
    return this.list().find((c) => c.provider === provider)!;
  }

  delete(provider: VmCredentialProvider): boolean {
    return this.vault.delete(`${VMCRED_PREFIX}${provider}`);
  }

  /** Environment variables for a provider session inside a microVM ({} when none is set). */
  env(provider: string): Record<string, string> {
    if (!isProvider(provider)) return {};
    let raw: string;
    try {
      raw = this.vault.revealInternal(`${VMCRED_PREFIX}${provider}`);
    } catch {
      return {};
    }
    const { kind, value } = JSON.parse(raw) as { kind: VmCredentialKind; value: string };
    return Object.fromEntries((VM_CREDENTIAL_ENV[provider][kind] ?? []).map((k) => [k, value]));
  }
}
