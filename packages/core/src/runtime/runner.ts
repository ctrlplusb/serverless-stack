import path from "path";
export type Opts = {
  srcPath: string;
  outPath: string;
  // Temporary
  transpiledHandler: any;
};

type Handler = (info: Opts) => Command;

type Command = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

export const NodeRunner: Handler = (opts) => {
  const handler = path
    .join(opts.transpiledHandler.srcPath, opts.transpiledHandler.entry)
    .replace(".js", "." + opts.transpiledHandler.handler);
  return {
    command: "./node_modules/.bin/aws-lambda-ric",
    args: [handler],
    env: {},
  };
};

export const GoRunner: Handler = (opts) => {
  return {
    command: opts.transpiledHandler.entry,
    args: [],
    env: {},
  };
};

export function resolve(runtime: string): Handler {
  if (runtime.startsWith("node")) return NodeRunner;
  if (runtime.startsWith("go")) return GoRunner;
  throw new Error(`Unknown runtime ${runtime}`);
}
