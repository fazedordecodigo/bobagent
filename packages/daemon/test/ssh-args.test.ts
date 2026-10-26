import { describe, expect, test } from "bun:test";
import { sshArgs } from "../src/remote/hosts";

const host = (port: number) =>
  ({ id: "h", name: "vps", target: "vps-alias", port, identityFile: null }) as Parameters<
    typeof sshArgs
  >[0];

describe("sshArgs", () => {
  test("leaves port 22 to ~/.ssh/config so Host aliases keep their Port", () => {
    const [, args] = sshArgs(host(22), [], "true");
    expect(args).not.toContain("-p");
    expect(args.slice(-2, -1)).toEqual(["vps-alias"]);
  });

  test("passes an explicit non-default port", () => {
    const [, args] = sshArgs(host(2222), [], "true");
    expect(args[args.indexOf("-p") + 1]).toBe("2222");
  });
});
