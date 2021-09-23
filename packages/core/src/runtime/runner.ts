export type Opts = {
  srcPath: string;
  outPath: string;
};

type Handler = (info: Opts) => Command;

type Command = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

export const NodeRunner: Handler = (opts) => {
  const handler = opts.srcPath.split(".").pop();
  return {
    command: "./node_modules/.bin/aws-lambda-ric",
    args: [opts.outPath.replace(".js", "." + handler)],
    env: {},
  };
};

export function resolve(runtime: string): Handler {
  if (runtime.startsWith("node")) return NodeRunner;
  throw new Error(`Unknown runtime ${runtime}`);
}
