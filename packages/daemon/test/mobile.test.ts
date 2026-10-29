import { expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { openDatabase } from "../src/db";
import { MobileServer } from "../src/mobile";
import { tmp } from "./helpers";

test("mobile audit distinguishes an expired pairing code from an inactive code", async () => {
  const dir = tmp("mob-expired-");
  const db = openDatabase(dir);
  const mobile = new MobileServer(db);
  const host = process.env.UPBOT_MOBILE_HOST;
  const port = process.env.UPBOT_MOBILE_PORT;
  process.env.UPBOT_MOBILE_HOST = "127.0.0.1";
  process.env.UPBOT_MOBILE_PORT = "0";
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const status = mobile.setEnabled(true);
    const clock = spyOn(Date, "now").mockReturnValue(Date.now() - 5 * 60_000 - 1);
    let code: string;
    try {
      code = mobile.pair().code;
    } finally {
      clock.mockRestore();
    }
    const response = await fetch(`${status.urls[0]}api/pair`, {
      method: "POST",
      body: JSON.stringify({ code }),
    });
    expect(response.status).toBe(401);
    expect(log).toHaveBeenCalledWith(
      "[upbotd] mobile.pair_failed",
      JSON.stringify({ reason: "expired", attempts: 0, ip: "127.0.0.1" }),
    );
    expect(mobile.status().devices).toEqual([]);
  } finally {
    mobile.setEnabled(false);
    log.mockRestore();
    if (host === undefined) delete process.env.UPBOT_MOBILE_HOST;
    else process.env.UPBOT_MOBILE_HOST = host;
    if (port === undefined) delete process.env.UPBOT_MOBILE_PORT;
    else process.env.UPBOT_MOBILE_PORT = port;
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
