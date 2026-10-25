import { describe, expect, test } from "bun:test";
import {
  isVmCredentialRejection,
  redactSecrets,
  vmCredentialRejectedMessage,
} from "../src/providers/process";

describe("microVM credential rejection messages", () => {
  const cases = [
    {
      provider: "claude" as const,
      name: "API key",
      credential: "sk-ant-api03-fake-claude",
      detail: "HTTP 401 invalid x-api-key sk-ant-api03-fake-claude",
    },
    {
      provider: "claude" as const,
      name: "OAuth token",
      credential: "sk-ant-oat01-fake-oauth",
      detail: "Authentication failed for token sk-ant-oat01-fake-oauth",
    },
    {
      provider: "codex" as const,
      name: "API key",
      credential: "sk-proj-fake-codex",
      detail: "Incorrect API key provided: sk-proj-fake-codex",
    },
  ];

  for (const { provider, name, credential, detail } of cases) {
    test(`${provider} ${name} rejection does not expose the saved fake credential`, () => {
      expect(isVmCredentialRejection(detail)).toBe(true);
      const message = vmCredentialRejectedMessage(provider, detail, credential);
      expect(message).toContain(`${provider}: the saved microVM credential was rejected`);
      expect(message).toContain("Update it in Settings → Hosts.");
      expect(message).not.toContain(credential);
    });
  }

  test("does not classify unrelated provider failures as credential rejections", () => {
    expect(isVmCredentialRejection("network connection timed out")).toBe(false);
  });

  test("redacts provider-masked API keys with visible prefixes and suffixes", () => {
    const detail = "Incorrect API key provided: sk-proj-****************029f";
    expect(redactSecrets(detail)).not.toContain("sk-proj-");
  });
});
