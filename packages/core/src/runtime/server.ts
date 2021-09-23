import Fastify, { FastifyInstance } from "fastify";
import spawn from "cross-spawn";
import { ChildProcess } from "child_process";
import crypto from "crypto";

import * as Runner from "./runner";

const API_VERSION = "2018-06-01";

type ServerOpts = {
  port: number;
};

type Payload = {
  event: any;
  context: any;
  deadline: number;
};

type InvokeOpts = {
  function: Runner.Opts;
  payload: Payload;
  runtime: string;
  environment: Record<string, string>;
};

type Response = any;

export class Server {
  private readonly fastify: FastifyInstance;
  private readonly pools: Record<string, Pool> = {};
  private readonly opts: ServerOpts;

  constructor(opts: ServerOpts) {
    this.fastify = Fastify();
    this.opts = opts;

    this.fastify.get<{
      Params: {
        fun: string;
      };
    }>(`/:fun/${API_VERSION}/runtime/invocation/next`, async (req, res) => {
      const payload = await this.next(req.params.fun);
      res.headers({
        "Lambda-Runtime-Aws-Request-Id": payload.context.awsRequestId,
        "Lambda-Runtime-Deadline-Ms": payload.deadline,
        "Lambda-Runtime-Invoked-Function-Arn":
          payload.context.invokedFunctionArn,
        "Lambda-Runtime-Client-Context": JSON.stringify(
          payload.context.identity || {}
        ),
        "Lambda-Runtime-Cognito-Identity": JSON.stringify(
          payload.context.clientContext || {}
        ),
      });

      res.send(payload);
    });

    this.fastify.post<{
      Params: {
        fun: string;
        awsRequestId: string;
      };
    }>(
      `/:fun/${API_VERSION}/runtime/invocation/:awsRequestId/response`,
      (req, res) => {
        this.success(req.params.fun, req.params.awsRequestId, req.body);
        res.code(202).send("ok");
      }
    );
  }

  listen() {
    this.fastify.listen({
      port: this.opts.port,
    });
  }

  private pool(fun: string) {
    const result = this.pools[fun] || {
      pending: [],
      waiting: [],
      processes: [],
      requests: {},
    };
    this.pools[fun] = result;
    return result;
  }

  private async next(fun: string) {
    const pool = this.pool(fun);

    // Process pending payloads if any
    const pending = pool.pending.pop();
    if (pending) return pending;

    return new Promise<Payload>((resolve) => {
      pool.waiting.push(resolve);
    });
  }

  public async invoke(opts: InvokeOpts) {
    const fun = Server.generateFunctionID(opts.function);
    const pool = this.pool(fun);
    return new Promise((resolve) => {
      pool.requests[opts.payload.context.awsRequestId] = resolve;
      this.trigger(fun, opts);
    });
  }

  public async drain(opts: Runner.Opts) {
    const fun = Server.generateFunctionID(opts);
    const pool = this.pool(fun);
    for (const proc of pool.processes) {
      proc.kill();
    }
    pool.waiting = [];
    pool.processes = [];
  }

  private static generateFunctionID(opts: Runner.Opts) {
    return crypto.createHash("sha256").update(opts.srcPath).digest("hex");
  }

  public success(fun: string, request: string, response: Response) {
    const pool = this.pool(fun);
    const r = pool.requests[request];
    r(response);
  }

  private async trigger(fun: string, opts: InvokeOpts) {
    const pool = this.pool(fun);
    const w = pool.waiting.pop();
    if (w) return w(opts.payload);
    // Spawn new worker if one not immediately available
    pool.pending.push(opts.payload);
    const cmd = Runner.resolve(opts.runtime)(opts.function);
    const api = `http://127.0.0.1:${this.opts.port}/${fun}`;
    const proc = spawn(cmd.command, cmd.args, {
      env: {
        ...opts.environment,
        ...cmd.env,
        AWS_LAMBDA_RUNTIME_API: api,
      },
      stdio: "inherit",
    });
    pool.processes.push(proc);
  }
}

type Pool = {
  waiting: ((p: Payload) => void)[];
  processes: ChildProcess[];
  requests: Record<string, (any: Response) => void>;
  pending: Payload[];
};
