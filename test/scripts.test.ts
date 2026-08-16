import { afterEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..");
const SCRIPT_NAMES = ["dev-server.sh", "dev-worker.sh", "push-secrets.sh", "read-fifo.sh"];
const fixtures: string[] = [];

type RunResult = Readonly<{ exitCode: number; stdout: string; stderr: string }>;

function writeExecutable(path: string, content: string): void {
  writeFileSync(path, content);
  chmodSync(path, 0o755);
}

function makeFixture(): { root: string; log: string } {
  const root = mkdtempSync(join(tmpdir(), "x-threaded-scripts-"));
  fixtures.push(root);
  const scripts = join(root, "scripts");
  const bin = join(root, "bin");
  mkdirSync(scripts);
  mkdirSync(bin);

  for (const name of SCRIPT_NAMES) {
    const destination = join(scripts, name);
    copyFileSync(join(REPO_ROOT, "scripts", name), destination);
    chmodSync(destination, 0o755);
  }

  const log = join(root, "calls.log");
  writeExecutable(
    join(bin, "bun"),
    `#!/usr/bin/env bash
printf 'bun\\t%s\\ttoken=%s\\n' "$*" "\${X_BEARER_TOKEN:-}" >> "$TEST_LOG"
if [[ "\${FAIL_BUN:-}" == "$*" ]]; then
  exit 23
fi
`,
  );
  writeExecutable(
    join(bin, "bunx"),
    `#!/usr/bin/env bash
set -u
printf 'bunx\\t%s\\ttoken=%s\\tinclude=%s\\n' "$*" "\${X_BEARER_TOKEN:-}" "\${CLOUDFLARE_INCLUDE_PROCESS_ENV:-}" >> "$TEST_LOG"
if [[ "\${1:-}" == wrangler && "\${2:-}" == secret && "\${3:-}" == put ]]; then
  value=$(cat)
  printf 'secret\\t%s\\t%s\\n' "$4" "$value" >> "$TEST_LOG"
  if [[ "\${FAIL_SECRET:-}" == "$4" ]]; then
    echo "stub wrangler failure for $4" >&2
    exit 23
  fi
fi
`,
  );
  writeExecutable(
    join(bin, "npx"),
    `#!/usr/bin/env bash
echo "unexpected npx invocation" >&2
exit 97
`,
  );
  writeExecutable(
    join(bin, "wrangler"),
    `#!/usr/bin/env bash
printf 'wrangler\\t%s\\n' "$*" >> "$TEST_LOG"
`,
  );
  return { root, log };
}

async function run(
  root: string,
  command: string[],
  env: Record<string, string> = {},
): Promise<RunResult> {
  const child = Bun.spawn(command, {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${join(root, "bin")}:/usr/bin:/bin`,
      TEST_LOG: join(root, "calls.log"),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function createFifo(path: string): void {
  const result = Bun.spawnSync(["mkfifo", path], { stderr: "pipe" });
  expect(result.exitCode, new TextDecoder().decode(result.stderr)).toBe(0);
}

async function writeFifo(path: string, content: string): Promise<number> {
  const writer = Bun.spawn(["/bin/bash", "-c", `printf '%s' "$ENV_CONTENT" > "$ENV_FIFO"`], {
    env: { ...process.env, ENV_CONTENT: content, ENV_FIFO: path },
    stdout: "ignore",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    writer.exited,
    new Response(writer.stderr).text(),
  ]);
  expect(exitCode, stderr).toBe(0);
  return exitCode;
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

describe("shell helpers", () => {
  it("loads a FIFO into the Bun server environment without GNU timeout", async () => {
    const { root, log } = makeFixture();
    const fifo = join(root, ".env");
    createFifo(fifo);
    const writer = writeFifo(fifo, "X_BEARER_TOKEN=fifo-token\n");

    const result = await run(root, ["/bin/bash", join(root, "scripts/dev-server.sh")]);
    await writer;

    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(readFileSync(log, "utf8")).toContain(
      "bun\t--watch src/server/index.ts\ttoken=fifo-token",
    );
  });

  it("loads a FIFO and invokes Worker development through bunx", async () => {
    const { root, log } = makeFixture();
    const fifo = join(root, ".env");
    createFifo(fifo);
    const writer = writeFifo(
      fifo,
      "X_BEARER_TOKEN=fifo-token\nWORKER_PORT=9191\n",
    );

    const result = await run(root, ["/bin/bash", join(root, "scripts/dev-worker.sh")]);
    await writer;

    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(readFileSync(log, "utf8")).toContain(
      "bunx\twrangler dev --port 9191\ttoken=fifo-token\tinclude=true",
    );
  });

  it("stops waiting for an unopened FIFO and cleans up", async () => {
    const { root } = makeFixture();
    const fifo = join(root, ".env");
    createFifo(fifo);
    const started = performance.now();

    const result = await run(root, ["/bin/bash", join(root, "scripts/read-fifo.sh"), fifo, "1"]);
    const elapsed = performance.now() - started;

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(elapsed).toBeGreaterThanOrEqual(800);
    expect(elapsed).toBeLessThan(5_000);
  });

  for (const script of ["dev-server.sh", "dev-worker.sh"]) {
    it(`${script} fails explicitly when its configuration FIFO cannot be read`, async () => {
      const { root, log } = makeFixture();
      createFifo(join(root, ".env"));
      writeExecutable(
        join(root, "scripts/read-fifo.sh"),
        "#!/usr/bin/env bash\nexit 17\n",
      );

      const result = await run(root, ["/bin/bash", join(root, `scripts/${script}`)]);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("Could not read the .env named pipe");
      expect(existsSync(log)).toBe(false);
    });
  }

  it("pushes only the safe deployment names and never ALLOW_UNGATED", async () => {
    const { root, log } = makeFixture();
    writeFileSync(
      join(root, ".env"),
      [
        "X_BEARER_TOKEN=bearer-value",
        "X_OAUTH_CLIENT_ID=client-id",
        "X_OAUTH_CLIENT_SECRET=client-secret",
        "POLICY_AUD=access-aud",
        "TEAM_DOMAIN=https://team.example",
        "MAX_POSTS_PER_FETCH=250",
        "ALLOW_UNGATED=true",
        "PORT=9999",
        "WORKER_PORT=9998",
        "DB_PATH=/not-for-workers.sqlite",
      ].join("\n"),
    );

    const result = await run(root, ["/bin/bash", join(root, "scripts/push-secrets.sh")]);
    const calls = readFileSync(log, "utf8");
    const names = calls
      .split("\n")
      .filter((line) => line.startsWith("secret\t"))
      .map((line) => line.split("\t")[1]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(names).toEqual([
      "X_BEARER_TOKEN",
      "X_OAUTH_CLIENT_ID",
      "X_OAUTH_CLIENT_SECRET",
      "POLICY_AUD",
      "TEAM_DOMAIN",
      "MAX_POSTS_PER_FETCH",
    ]);
    expect(calls).not.toContain("ALLOW_UNGATED");
    expect(calls).not.toContain("PORT\t");
    expect(calls).not.toContain("DB_PATH");
    expect(result.stdout).toContain("skip   ALLOW_UNGATED (must be pushed explicitly)");
    expect(result.stdout).toContain("6 secret(s) updated");
    expect(result.stdout + result.stderr).not.toContain("bearer-value");
    expect(result.stdout + result.stderr).not.toContain("client-secret");
  });

  it("does not let .env replace the internal secret allowlist", async () => {
    const { root, log } = makeFixture();
    writeFileSync(
      join(root, ".env"),
      [
        "NAMES=ALLOW_UNGATED",
        "ALLOW_UNGATED=true",
        "X_BEARER_TOKEN=bearer-value",
      ].join("\n"),
    );

    const result = await run(root, ["/bin/bash", join(root, "scripts/push-secrets.sh")]);
    const calls = readFileSync(log, "utf8");
    const names = calls
      .split("\n")
      .filter((line) => line.startsWith("secret\t"))
      .map((line) => line.split("\t")[1]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(names).toEqual(["X_BEARER_TOKEN"]);
    expect(calls).not.toContain("secret\tALLOW_UNGATED\t");
    expect(result.stdout).toContain("skip   ALLOW_UNGATED (must be pushed explicitly)");
  });

  it("reads a secret configuration FIFO once and still uses the stubbed bunx", async () => {
    const { root, log } = makeFixture();
    const fifo = join(root, ".env");
    createFifo(fifo);
    const writer = writeFifo(
      fifo,
      "X_BEARER_TOKEN=fifo-secret\nMAX_POSTS_PER_FETCH=125\n",
    );

    const result = await run(root, ["/bin/bash", join(root, "scripts/push-secrets.sh")]);
    await writer;
    const calls = readFileSync(log, "utf8");

    expect(result.exitCode, result.stderr).toBe(0);
    expect(calls).toContain("secret\tX_BEARER_TOKEN\tfifo-secret");
    expect(calls).toContain("secret\tMAX_POSTS_PER_FETCH\t125");
    expect(result.stdout + result.stderr).not.toContain("fifo-secret");
  });

  it("fails instead of reporting success when the secret FIFO cannot be read", async () => {
    const { root } = makeFixture();
    createFifo(join(root, ".env"));
    writeExecutable(
      join(root, "scripts/read-fifo.sh"),
      "#!/usr/bin/env bash\nexit 17\n",
    );

    const result = await run(root, ["/bin/bash", join(root, "scripts/push-secrets.sh")]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Could not read the .env named pipe");
    expect(result.stderr).not.toContain("updated");
  });

  it("tries every configured secret and exits nonzero if any upload fails", async () => {
    const { root, log } = makeFixture();
    writeFileSync(
      join(root, ".env"),
      [
        "X_BEARER_TOKEN=bearer-value",
        "POLICY_AUD=access-aud",
        "TEAM_DOMAIN=https://team.example",
        "MAX_POSTS_PER_FETCH=100",
      ].join("\n"),
    );

    const result = await run(
      root,
      ["/bin/bash", join(root, "scripts/push-secrets.sh")],
      { FAIL_SECRET: "POLICY_AUD" },
    );
    const calls = readFileSync(log, "utf8");

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("stub wrangler failure for POLICY_AUD");
    expect(result.stderr).toContain("FAILED POLICY_AUD");
    expect(result.stderr).toContain("3 secret(s) updated; 1 failed.");
    expect(calls).toContain("secret\tMAX_POSTS_PER_FETCH\t100");
    expect(result.stdout).not.toContain("Redeploy is not needed");
  });
});

describe("package deployment", () => {
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts: { deploy: string };
  };

  it("builds before any remote migration or deploy command", async () => {
    const { root, log } = makeFixture();

    const result = await run(root, ["/bin/bash", "-c", packageJson.scripts.deploy]);

    expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(readFileSync(log, "utf8").split("\n").filter(Boolean)).toEqual([
      "bun\trun build\ttoken=",
      "wrangler\td1 migrations apply DB --remote",
      "wrangler\tdeploy",
    ]);
  });

  it("does not contact Wrangler when the asset build fails", async () => {
    const { root, log } = makeFixture();

    const result = await run(root, ["/bin/bash", "-c", packageJson.scripts.deploy], {
      FAIL_BUN: "run build",
    });

    expect(result.exitCode).toBe(23);
    expect(readFileSync(log, "utf8")).toBe("bun\trun build\ttoken=\n");
  });
});
