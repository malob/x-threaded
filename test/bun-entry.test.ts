import { describe, expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

const MARKER = "BUN_ENTRY_BINDING ";

describe("Bun server entrypoint", () => {
  it("exports a loopback-only server configuration without starting it", async () => {
    const entryUrl = new URL("../src/server/index.ts", import.meta.url).href;
    const cwd = fileURLToPath(new URL("..", import.meta.url));
    const script = `
      const { serverBinding: config, serverAdvertisedHostname } = await import(${JSON.stringify(entryUrl)});
      console.log(${JSON.stringify(MARKER)} + JSON.stringify({
        hostname: config.hostname,
        port: config.port,
        idleTimeout: config.idleTimeout,
        advertisedHostname: serverAdvertisedHostname,
      }));
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd,
      env: {
        ...process.env,
        PORT: "0",
        DB_PATH: ":memory:",
        X_BEARER_TOKEN: "test-token-not-valid-for-x",
        MAX_POSTS_PER_FETCH: "500",
        X_OAUTH_CLIENT_ID: "",
        X_OAUTH_CLIENT_SECRET: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);

    const marker = stdout.split("\n").find((line) => line.startsWith(MARKER));
    expect(marker, stdout).toBeDefined();
    const binding = JSON.parse(marker!.slice(MARKER.length)) as {
      hostname: string;
      port: number;
      idleTimeout: number;
      advertisedHostname: string;
    };
    expect(binding).toEqual({
      hostname: "127.0.0.1",
      port: 0,
      idleTimeout: 0,
      advertisedHostname: "localhost",
    });
  });

  it("starts exactly one loopback server when executed", async () => {
    const entry = fileURLToPath(new URL("../src/server/index.ts", import.meta.url));
    const cwd = fileURLToPath(new URL("..", import.meta.url));
    const port = 40_000 + Math.floor(Math.random() * 10_000);
    const child = Bun.spawn([process.execPath, entry], {
      cwd,
      env: {
        ...process.env,
        PORT: String(port),
        DB_PATH: ":memory:",
        X_BEARER_TOKEN: "test-token-not-valid-for-x",
        MAX_POSTS_PER_FETCH: "500",
        X_OAUTH_CLIENT_ID: "",
        X_OAUTH_CLIENT_SECRET: "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    let body = "";
    try {
      for (let attempt = 0; attempt < 50; attempt++) {
        const response = Bun.spawnSync(
          ["curl", "--silent", "--fail", "--max-time", "0.2", `http://127.0.0.1:${port}/api/saved`],
          { stdout: "pipe", stderr: "ignore" },
        );
        if (response.exitCode === 0) {
          body = new TextDecoder().decode(response.stdout);
          break;
        }
        if (child.exitCode !== null) break;
        await Bun.sleep(20);
      }
    } finally {
      child.kill();
    }

    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(body, `exit ${exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`).toContain('"items":[]');
    expect(stdout).toContain(`http://localhost:${port}`);
    expect(stdout).not.toContain(`http://127.0.0.1:${port}`);
  });
});
