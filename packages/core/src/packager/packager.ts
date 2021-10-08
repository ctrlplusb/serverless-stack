import { sync } from "cross-spawn";
import path from "path";
import fs from "fs";

type BaseOpts = {
  cwd: string;
  verbose: boolean;
};

type UpdateOpts = BaseOpts & {
  type: "dependencies" | "devDependencies";
  pkgs: string[];
};

type RunOpts = BaseOpts & {
  cmd: string;
  args: string[];
  env: Record<string, string>;
};

type SpawnOpts = {
  cmd: string;
  args: string[];
  cwd: string;
  verbose: boolean;
  env: Record<string, string>;
};

function spawn(opts: SpawnOpts) {
  return sync(opts.cmd, opts.args, {
    cwd: opts.cwd,
    stdio: opts.verbose ? "inherit" : undefined,
    env: opts.env,
  });
}

function Implementation<T extends string>(impl: {
  type: T;
  add: (opts: UpdateOpts) => void;
  run: (opts: RunOpts) => void;
}) {
  return impl;
}

const NPM = Implementation({
  type: "npm",
  add(opts: UpdateOpts) {
    return spawn({
      cmd: "npm",
      args: [
        "install",
        "--save-exact",
        ...opts.pkgs,
        opts.type === "dependencies" ? "--save" : "--save-dev",
      ],
      cwd: opts.cwd,
      verbose: opts.verbose,
      env: {},
    });
  },
  run(opts: RunOpts) {
    return spawn({
      cmd: "npm",
      args: ["run", opts.cmd, "--", ...opts.args],
      cwd: opts.cwd,
      verbose: opts.verbose,
      env: {},
    });
  },
});

const Yarn = Implementation({
  type: "yarn",
  add(opts: UpdateOpts) {
    return spawn({
      cmd: "yarn",
      args: [
        "add",
        "--exact",
        (opts.type === "devDependencies" && "--dev") || "",
        "-W",
        ...opts.pkgs,
      ].filter((item) => item),
      cwd: opts.cwd,
      verbose: opts.verbose,
      env: {},
    });
  },
  run(opts: RunOpts) {
    return spawn({
      cmd: "yarn",
      args: ["run", opts.cmd, ...opts.args],
      cwd: opts.cwd,
      verbose: opts.verbose,
      env: {},
    });
  },
});

type Manager = typeof NPM | typeof Yarn;

export function getManager(dir: string): Manager {
  const lock = path.join(dir, "yarn.lock");
  if (fs.existsSync(lock)) return Yarn;
  const upDir = path.resolve(dir, "..");
  if (upDir === dir) {
    return NPM;
  }
  return getManager(upDir);
}
