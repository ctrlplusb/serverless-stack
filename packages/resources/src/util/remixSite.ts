import path from "path";
import url from "url";
import fs from "fs-extra";
import spawn from "cross-spawn";
import { readPackageSync } from "read-pkg";
import * as z from "zod";

import { getBuildCmdEnvironment } from "../BaseSite.js";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

// This aids us in ensuring the user is providing our expected remix.config.js
// values. We will follow a required convention as is typical in some of the
// official Remix templates for other deployment targets.
// @see https://remix.run/docs/en/v1/api/conventions#remixconfigjs
const expectedRemixConfigSchema = z.object({
  // The path to the browser build, relative to remix.config.js. Defaults to
  // "public/build". Should be deployed to static hosting.
  assetsBuildDirectory: z.literal("public/build"),
  // The URL prefix of the browser build with a trailing slash. Defaults to
  // "/build/". This is the path the browser will use to find assets.
  // Note: Remix additionally has a "public" folder, which should be considered
  // different to this. We seperately need to deploy the "public" folder and
  // ensure the files/directories are mapped relative to the root of the
  // domain.
  publicPath: z.literal("/build/"),
  // The path to the server build file, relative to remix.config.js. This file
  // should end in a .js extension and should be deployed to your server.
  serverBuildPath: z.literal("build/index.js"),
  // The target of the server build.
  serverBuildTarget: z.literal("node-cjs"),
  // A server entrypoint, relative to the root directory that becomes your
  // server's main module. If specified, Remix will compile this file along with
  // your application into a single file to be deployed to your server.
  server: z.string().optional(),
});

export type RemixConfig = z.infer<typeof expectedRemixConfigSchema>;

const expectedRemixConfig: RemixConfig = {
  assetsBuildDirectory: "public/build",
  publicPath: "/build/",
  serverBuildPath: "build/index.js",
  serverBuildTarget: "node-cjs",
};

export function build(args: {
  sitePath: string;
  environment?: Record<string, string>;
}) {
  // Given that Remix apps tend to involve concatenation of other commands
  // such as Tailwind compilation, we feel that it is safest to target the
  // "build" script for the app in order to ensure all outputs are generated.

  // validate site path exists
  if (!fs.existsSync(args.sitePath)) {
    throw new Error(`No path found at "${path.resolve(args.sitePath)}"`);
  }

  // Ensure that the site has a build script defined
  if (!fs.existsSync(path.join(args.sitePath, "package.json"))) {
    throw new Error(`No package.json found at "${args.sitePath}".`);
  }
  const packageJson = readPackageSync({
    cwd: args.sitePath,
    normalize: false,
  });
  if (!packageJson.scripts || !packageJson.scripts.build) {
    throw new Error(
      `No "build" script found within package.json in "${args.sitePath}".`
    );
  }

  // Run build
  const buildResult = spawn.sync("npm", ["run", "build"], {
    cwd: args.sitePath,
    stdio: "inherit",
    env: {
      ...process.env,
      ...getBuildCmdEnvironment(args.environment),
    },
  });
  if (buildResult.status !== 0) {
    throw new Error('The app "build" script failed.');
  }

  // Validate server build output exists
  const serverBuildFile = path.join(
    args.sitePath,
    expectedRemixConfig.serverBuildPath
  );
  if (!fs.existsSync(serverBuildFile)) {
    throw new Error(`No server build output found at "${serverBuildFile}"`);
  }
}

export function validateRemixConfig(args: { sitePath: string }): RemixConfig {
  const result = spawn.sync("node", [
    path.resolve(
      __dirname,
      "../../assets/RemixSite/config/read-remix-config.cjs"
    ),
    "--path",
    path.resolve(args.sitePath, "remix.config.js"),
  ]);
  if (result.error != null) {
    throw new Error(`Failed to read the Remix config file.\n${result.error}`);
  }
  if (result.status !== 0) {
    throw new Error(`Failed to read the Remix config file.\n${result.stderr}`);
  }
  const output = result.stdout.toString();

  const remixConfigParse = expectedRemixConfigSchema.safeParse(
    JSON.parse(output)
  );
  if (remixConfigParse.success === false) {
    throw new Error(
      `\nYour remix.config.js has invalid values.

It needs to use the default Remix config values for the following properties:

module.exports = {
  assetsBuildDirectory: "public/build",
  publicPath: "/build/",
  serverBuildPath: "build/index.js",
  serverBuildTarget: "node-cjs",
}
`
    );
  }
  return remixConfigParse.data;
}

/**
 * Create a Lambda handler for the Remix server bundle.
 */
export function injectServerHandlerIntoBuild(args: {
  sitePath: string;
  remixConfig: RemixConfig;
  edge: boolean;
}): { directory: string; handler: string } {
  if (args.remixConfig.server != null) {
    // In this path we are using a user-specified server. We'll assume
    // that they have built an appropriate Lambda handler for the Remix
    // "core server build".
    //
    // The Remix compiler will have bundled their server implementation into
    // the server build ouput path. We therefore need to reference the
    // serverBuildPath from the remix.config.js to determine our server build
    // entry.
    //
    // Supporting this customisation of the server supports two cases:
    // 1. It enables power users to override our own implementation with an
    //    implementation that meets their specific needs.
    // 2. It provides us with the required stepping stone to enable a
    //    "Serverless Stack" template within the Remix repository (we would
    //    still need to reach out to the Remix team for this).

    return {
      directory: path.dirname(
        path.join(args.sitePath, args.remixConfig.serverBuildPath)
      ),
      handler: path
        .basename(args.remixConfig.serverBuildPath)
        .replace(/(\.js|\.ts)/, ".handler"),
    };
  }

  // In this path we are assuming that the Remix build only outputs the
  // "core server build". We can safely assume this as we have guarded the
  // remix.config.js to ensure it matches our expectations for the build
  // configuration. We need to ensure that the "core server build" is
  // wrapped with an appropriate Lambda handler. We will utilise an internal
  // asset template to create this wrapper within the "core server build"
  // output directory.

  // Resolve the path to create the server lambda handler at;
  const serverPath = path.join(args.sitePath, "build/server.js");

  // Copy the appropriate lambda handler based on edge vs apig;
  fs.copyFileSync(
    path.resolve(
      __dirname,
      args.edge
        ? "../../assets/RemixSite/server/edge-server-template.js"
        : "../../assets/RemixSite/server/apig-server-template.js"
    ),
    serverPath
  );

  // Additionally copy the required polyfill module;
  fs.copyFileSync(
    path.resolve(__dirname, "../../assets/RemixSite/server/polyfills.js"),
    path.join(args.sitePath, "build/polyfills.js")
  );

  return {
    directory: args.sitePath,
    handler: "build/server.handler",
  };
}
