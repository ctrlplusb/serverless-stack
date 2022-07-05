import chalk from "chalk";
import path from "path";
import url from "url";
import fs from "fs-extra";
import spawn from "cross-spawn";
import indent from "indent-string";

import { Runtime } from "@serverless-stack/core";
import { Construct } from "constructs";
import {
  Duration,
  CfnOutput,
  RemovalPolicy,
  CustomResource,
} from "aws-cdk-lib";
import { BehaviorOptions } from "aws-cdk-lib/aws-cloudfront";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as s3Assets from "aws-cdk-lib/aws-s3-assets";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import { AwsCliLayer } from "aws-cdk-lib/lambda-layer-awscli";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as route53Patterns from "aws-cdk-lib/aws-route53-patterns";

import { Api } from "./Api.js";
import { App } from "./App.js";
import { Function, FunctionBundleNodejsProps } from "./Function.js";
import { Stack } from "./Stack.js";
import { SSTConstruct } from "./Construct.js";
import {
  BaseSiteDomainProps,
  BaseSiteCdkDistributionProps,
  BaseSiteEnvironmentOutputsInfo,
  buildErrorResponsesForRedirectToIndex,
} from "./BaseSite.js";
import { Permissions, attachPermissionsToRole } from "./util/permission.js";
import * as RemixSiteUtils from "./util/remixSite.js";
import type { RemixConfig } from "./util/remixSite.js";

// This references a directory named after Nextjs, but the underlying code
// appears to be generic enough to utilise in this case.
// I suggest we rename this folder to something like "edge-lambda";
import * as crossRegionHelper from "./nextjs-site/cross-region-helper.js";

const __dirname = url.fileURLToPath(new URL(".", import.meta.url));

export interface RemixDomainProps extends BaseSiteDomainProps {}
export interface RemixCdkDistributionProps
  extends BaseSiteCdkDistributionProps {}
export interface RemixSiteProps {
  /**
   * Pass in a custom bundling configuration for the server lambda.
   */
  bundle?: FunctionBundleNodejsProps;

  /**
   * Customise aspects of the CDK deployment.
   */
  cdk?: {
    /**
     * Pass in bucket information to override the default settings this
     * construct uses to create the CDK Bucket internally.
     */
    bucket?: s3.BucketProps;

    /**
     * Pass in a value to override the default settings this construct uses to
     * create the CDK `Distribution` internally.
     */
    distribution?: RemixCdkDistributionProps;
    /**
     * Override the default CloudFront cache policies created internally.
     */
    cachePolicies?: {
      /**
       * Override the CloudFront cache policy properties for browser build files.
       */
      browserBuildCachePolicy?: cloudfront.ICachePolicy;
      /**
       * Override the CloudFront cache policy properties for "public" folder
       * static files.
       *
       * Note: This will not include the browser build files, which have a seperate
       * cache policy; @see `browserBuildCachePolicy`.
       */
      publicCachePolicy?: cloudfront.ICachePolicy;
      /**
       * Override the CloudFront cache policy properties for responses from the
       * server rendering Lambda.
       *
       * @note
       *
       * The default cache policy that is used in the abscene of this property
       * is one that performs no caching of the server response.
       */
      serverResponseCachePolicy?: cloudfront.ICachePolicy;
    };
  };

  /**
   * Path to the directory where the website source is located.
   */
  path: string;

  /**
   * The customDomain for this website. SST supports domains that are hosted
   * either on [Route 53](https://aws.amazon.com/route53/) or externally.
   *
   * Note that you can also migrate externally hosted domains to Route 53 by
   * [following this guide](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/MigratingDNS.html).
   *
   * @example
   * ```js {3}
   * new RemixSite(stack, "RemixSite", {
   *   path: "path/to/site",
   *   customDomain: "domain.com",
   * });
   * ```
   *
   * ```js {3-6}
   * new RemixSite(stack, "RemixSite", {
   *   path: "path/to/site",
   *   customDomain: {
   *     domainName: "domain.com",
   *     domainAlias: "www.domain.com",
   *     hostedZone: "domain.com"
   *   },
   * });
   * ```
   */
  customDomain?: string | RemixDomainProps;

  /**
   * If `true` your RemixSite server render handler will be deployed to
   * Lambda@Edge, else it will be deployed as an APIGatewayV2 Lambda.
   *
   * @default false
   */
  edge?: boolean;

  /**
   * An object with the key being the environment variable name.
   *
   * @example
   * ```js {3-6}
   * new RemixSite(stack, "RemixSite", {
   *   path: "path/to/site",
   *   environment: {
   *     API_URL: api.url,
   *     USER_POOL_CLIENT: auth.cognitoUserPoolClient.userPoolClientId,
   *   },
   * });
   * ```
   */
  environment?: Record<string, string>;

  /**
   * When running `sst start`, a placeholder site is deployed. This is to ensure
   * that the site content remains unchanged, and subsequent `sst start` can
   * start up quickly.
   *
   * @example
   * ```js {3}
   * new RemixSite(stack, "RemixSite", {
   *   path: "path/to/site",
   *   disablePlaceholder: true,
   * });
   * ```
   */
  disablePlaceholder?: boolean;

  /**
   * Override the configuration for the server render Lambda.
   */
  defaults?: {
    function?: {
      timeout?: number;
      memorySize?: number;
      permissions?: Permissions;
    };
  };

  /**
   * While deploying, SST waits for the CloudFront cache invalidation process to
   * finish. This ensures that the new content will be served once the deploy
   * command finishes. However, this process can sometimes take more than 5
   * mins. For non-prod environments it might make sense to pass in `false`.
   * That'll skip waiting for the cache to invalidate and speed up the deploy
   * process.
   */
  waitForInvalidation?: boolean;
}

type LambdaSourceMeta = {
  directory: string;
  handler: string;
};

type ServerFunction = Api | lambda.IVersion;

/**
 * The `RemixSite` construct is a higher level CDK construct that makes it easy
 * to create a Remix app. It provides a simple way to build and deploy your site
 * to CloudFront.
 *
 * By default server rendering is performed within an APIGatewayV2 Lambda,
 * however, it also supports the use of Lambda@Edge (via the `edge` prop). Additionally
 * it supports environment variables against the Lambda@Edge deployment
 * despite this being a limitation of Lambda@Edge.
 *
 * The browser build and public statics are backed by an S3 Bucket. CloudFront
 * cache policies are configured, whilst also allowing for customization, and we
 * include cache invalidation on deployment.
 *
 * The construct enables you to customize many of the deployment features,
 * including the ability to configure a custom domain for the website URL.
 *
 * It enables you to [automatically set the environment
 * variables](#configuring-environment-variables) for your Remix app directly
 * from the outputs in your SST app.
 */
export class RemixSite extends Construct implements SSTConstruct {
  /**
   * The default CloudFront cache policy properties for browser build files.
   */
  public static browserBuildCachePolicyProps: cloudfront.CachePolicyProps = {
    queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
    headerBehavior: cloudfront.CacheHeaderBehavior.none(),
    cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    // The browser build file names all contain unique hashes based on their
    // content, we can therefore aggressively cache them as we shouldn't hit
    // unexpected collisions.
    defaultTtl: Duration.days(365),
    maxTtl: Duration.days(365),
    minTtl: Duration.days(365),
    enableAcceptEncodingBrotli: true,
    enableAcceptEncodingGzip: true,
    comment: "SST RemixSite Browser Build Default Cache Policy",
  };

  /**
   * The default CloudFront cache policy properties for "public" folder
   * static files.
   *
   * @note
   *
   * This policy is not applied to the browser build files; they have a seperate
   * cache policy. @see `browserBuildCachePolicyProps`.
   */
  public static publicCachePolicyProps: cloudfront.CachePolicyProps = {
    queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
    headerBehavior: cloudfront.CacheHeaderBehavior.none(),
    cookieBehavior: cloudfront.CacheCookieBehavior.none(),
    defaultTtl: Duration.hours(1),
    maxTtl: Duration.hours(1),
    minTtl: Duration.hours(1),
    enableAcceptEncodingBrotli: true,
    enableAcceptEncodingGzip: true,
    comment: "SST RemixSite Public Folder Default Cache Policy",
  };

  /**
   * The default CloudFront cache policy properties for responses from the
   * server rendering Lambda.
   *
   * @note
   *
   * By default no caching is performed on the server rendering Lambda response.
   */
  public static serverResponseCachePolicyProps: cloudfront.CachePolicyProps = {
    queryStringBehavior: cloudfront.CacheQueryStringBehavior.all(),
    headerBehavior: cloudfront.CacheHeaderBehavior.none(),
    cookieBehavior: cloudfront.CacheCookieBehavior.all(),
    defaultTtl: Duration.seconds(0),
    maxTtl: Duration.days(365),
    minTtl: Duration.seconds(0),
    enableAcceptEncodingBrotli: true,
    enableAcceptEncodingGzip: true,
    comment: "SST RemixSite Server Response Default Cache Policy",
  };

  /**
   * Exposes CDK instances created within the construct.
   */
  public readonly cdk: {
    /**
     * The internally created CDK `Bucket` instance.
     */
    bucket: s3.Bucket;
    /**
     * The internally created CDK `Distribution` instance.
     */
    distribution: cloudfront.Distribution;
    /**
     * The Route 53 hosted zone for the custom domain.
     */
    hostedZone?: route53.IHostedZone;
    /**
     * The AWS Certificate Manager certificate for the custom domain.
     */
    certificate?: acm.ICertificate;
  };
  private scope: Construct;
  private id: string;
  private props: RemixSiteProps;
  private awsCliLayer: AwsCliLayer;

  /**
   * Determines if a placeholder site should be deployed instead. We will set
   * this to `true` by default when performing local development, although the
   * user can choose to override this value.
   */
  private isPlaceholder: boolean;
  /**
   * The root SST directory used for builds.
   */
  private sstBuildDir: string;
  /**
   * S3Asset references to the zip files containing the static files for the
   * deployment.
   */
  private staticsS3Assets: s3Assets.Asset[];
  /**
   * The remix site config. It contains user configuration overrides which we
   * will need to consider when resolving Remix's build output.
   */
  private remixConfig: RemixConfig;
  private serverLambdaRole: iam.Role | undefined;
  private serverFunction: ServerFunction | undefined;

  constructor(scope: Construct, id: string, props: RemixSiteProps) {
    super(scope, id);

    try {
      const app = scope.node.root as App;
      const zipFileSizeLimitInMb = 200;

      this.scope = scope;
      this.id = id;
      this.isPlaceholder =
        (app.local || app.skipBuild) && !props.disablePlaceholder;
      this.sstBuildDir = app.buildDir;
      this.props = props;
      this.cdk = {} as any;
      this.awsCliLayer = new AwsCliLayer(this, "AwsCliLayer");
      this.registerSiteEnvironment();

      // Create Bucket which will be utilised to contain the statics
      this.cdk.bucket = this.createS3Bucket();

      // Create Custom Domain
      this.validateCustomDomainSettings();
      this.cdk.hostedZone = this.lookupHostedZone();
      this.cdk.certificate = this.createCertificate();

      // Prepare app
      if (this.isPlaceholder) {
        // Minimal configuration for the placeholder site
        this.remixConfig = {} as any;
        this.staticsS3Assets = this.createAppStubS3Assets();
        this.serverLambdaRole = undefined;
        this.serverFunction = undefined;
      } else {
        // Validate application exists at provided path;
        if (!fs.existsSync(props.path)) {
          throw new Error(`No path found`);
        }

        // Read and validate the remix config to ensure that it follows our
        // expected conventions;
        this.remixConfig = RemixSiteUtils.validateRemixConfig({
          sitePath: props.path,
        });

        // Build the Remix site (only if not running an SST test);
        // @ts-expect-error: "sstTest" is only passed in by SST tests
        if (!props.sstTest) {
          this.logInfo(`Building site...`);
          RemixSiteUtils.build({
            sitePath: props.path,
            environment: props.environment,
          });
        }

        // Create the server lambda handler code
        this.logInfo(`Injecting server handler alongside server build`);
        const lambdaSourceMeta = RemixSiteUtils.injectServerHandlerIntoBuild({
          edge: !!props.edge,
          sitePath: props.path,
          remixConfig: this.remixConfig,
        });

        // Create S3 assets from the browser build;
        this.staticsS3Assets = this.createStaticsS3Assets(zipFileSizeLimitInMb);

        // Create the server lambda role;
        this.serverLambdaRole = this.createServerFunctionRole();

        // Create the server lambda;
        this.serverFunction = props.edge
          ? this.createEdgeServerFunction({
              lambdaSourceMeta,
              sitePath: props.path,
            })
          : this.createApigServerFunction({
              lambdaSourceMeta,
            });
      }

      // Create S3 Deployment
      const s3deployCR = this.createS3Deployment();

      // Create CloudFront Distribution
      this.cdk.distribution = this.createCloudFrontDistribution();
      this.cdk.distribution.node.addDependency(s3deployCR);

      // Invalidate CloudFront to ensure updates reflect
      if (!this.isPlaceholder) {
        const invalidationCR = this.createCloudFrontInvalidation();
        invalidationCR.node.addDependency(this.cdk.distribution);
      }

      // Connect Custom Domain to CloudFront Distribution
      this.createRoute53Records();
    } catch (error) {
      // If running an SST test then re-throw the error so that it can be
      // tested
      // @ts-expect-error: "sstTest" is only passed in by SST tests
      if (props.sstTest) {
        throw error;
      }

      console.error(
        chalk.red(
          `\nError: There was a problem synthesizing the RemixSite at "${props.path}".`
        )
      );
      if (error instanceof Error) {
        if (error.stack) {
          console.error(chalk.red(indent(`\n${error.stack}`, 2)));
        } else if (error.message) {
          console.error(chalk.bold.red(indent(`\n${error.message}`, 2)));
        } else {
          console.error(chalk.bold.red(indent("\nAn unknown error occurred")));
        }
      }
      process.exit(1);
    }
  }

  // #region Public properties

  /**
   * The CloudFront URL of the website.
   */
  public get url(): string {
    return `https://${this.cdk.distribution.distributionDomainName}`;
  }

  /**
   * If the custom domain is enabled, this is the URL of the website with the
   * custom domain.
   */
  public get customDomainUrl(): string | undefined {
    const { customDomain } = this.props;
    if (!customDomain) {
      return;
    }

    if (typeof customDomain === "string") {
      return `https://${customDomain}`;
    } else {
      return `https://${customDomain.domainName}`;
    }
  }

  /**
   * The ARN of the internally created S3 Bucket.
   */
  public get bucketArn(): string {
    return this.cdk.bucket.bucketArn;
  }

  /**
   * The name of the internally created S3 Bucket.
   */
  public get bucketName(): string {
    return this.cdk.bucket.bucketName;
  }

  /**
   * The ID of the internally created CloudFront Distribution.
   */
  public get distributionId(): string {
    return this.cdk.distribution.distributionId;
  }

  /**
   * The domain name of the internally created CloudFront Distribution.
   */
  public get distributionDomain(): string {
    return this.cdk.distribution.distributionDomainName;
  }

  // #endregion

  // #region Public methods

  /**
   * Attaches the given list of permissions to allow the Remix server side
   * rendering to access other AWS resources.
   *
   * @example
   * ### Attaching permissions
   *
   * ```js {5}
   * const site = new RemixSite(stack, "Site", {
   *   path: "path/to/site",
   * });
   *
   * site.attachPermissions(["sns"]);
   * ```
   */
  public attachPermissions(permissions: Permissions): void {
    if (!this.serverLambdaRole) {
      return;
    }
    attachPermissionsToRole(this.serverLambdaRole, permissions);
  }

  public getConstructMetadata() {
    return {
      type: "RemixSite" as const,
      data: {
        distributionId: this.cdk.distribution.distributionId,
        customDomainUrl: this.customDomainUrl,
      },
    };
  }

  // #endregion

  // #region Statics

  private createStaticsS3Assets(fileSizeLimit: number): s3Assets.Asset[] {
    // First we need to create zip files containing the statics

    const script = path.resolve(__dirname, "../assets/BaseSite/archiver.cjs");
    const zipOutDir = path.resolve(
      path.join(this.sstBuildDir, `RemixSite-${this.node.id}-${this.node.addr}`)
    );
    // Remove zip dir to ensure no partX.zip remain from previous build
    fs.removeSync(zipOutDir);

    const result = spawn.sync(
      "node",
      [
        script,
        path.join(this.props.path, "public"),
        zipOutDir,
        `${fileSizeLimit}`,
      ],
      {
        stdio: "inherit",
      }
    );
    if (result.status !== 0) {
      throw new Error(`There was a problem generating the assets package.`);
    }

    // Create S3 Assets for each zip file
    const assets = [];
    for (let partId = 0; ; partId++) {
      const zipFilePath = path.join(zipOutDir, `part${partId}.zip`);
      if (!fs.existsSync(zipFilePath)) {
        break;
      }
      assets.push(
        new s3Assets.Asset(this, `Asset${partId}`, {
          path: zipFilePath,
        })
      );
    }
    return assets;
  }

  private createAppStubS3Assets(): s3Assets.Asset[] {
    return [
      new s3Assets.Asset(this, "Asset", {
        path: path.resolve(__dirname, "../assets/RemixSite/site-sub"),
      }),
    ];
  }

  private createS3Bucket(): s3.Bucket {
    const { cdk } = this.props;

    return new s3.Bucket(this, "S3Bucket", {
      publicReadAccess: true,
      autoDeleteObjects: true,
      removalPolicy: RemovalPolicy.DESTROY,
      ...cdk?.bucket,
    });
  }

  private createS3Deployment(): CustomResource {
    // Create a Lambda function that will be doing the uploading
    const uploader = new lambda.Function(this, "S3Uploader", {
      code: lambda.Code.fromAsset(
        path.join(__dirname, "../assets/BaseSite/custom-resource")
      ),
      layers: [this.awsCliLayer],
      runtime: lambda.Runtime.PYTHON_3_7,
      handler: "s3-upload.handler",
      timeout: Duration.minutes(15),
      memorySize: 1024,
    });
    this.cdk.bucket.grantReadWrite(uploader);
    this.staticsS3Assets.forEach((asset) => asset.grantRead(uploader));

    // Create the custom resource function
    const handler = new lambda.Function(this, "S3Handler", {
      code: lambda.Code.fromAsset(
        path.join(__dirname, "../assets/BaseSite/custom-resource")
      ),
      layers: [this.awsCliLayer],
      runtime: lambda.Runtime.PYTHON_3_7,
      handler: "s3-handler.handler",
      timeout: Duration.minutes(15),
      memorySize: 1024,
      environment: {
        UPLOADER_FUNCTION_NAME: uploader.functionName,
      },
    });
    this.cdk.bucket.grantReadWrite(handler);
    uploader.grantInvoke(handler);

    let FileOptions;

    if (!this.isPlaceholder) {
      const publicPath = path.join(this.props.path, "public");
      const publicFileOptions = [];
      for (const item of fs.readdirSync(publicPath)) {
        const itemPath = path.join(publicPath, item);
        publicFileOptions.push({
          exclude: "*",
          include: fs.statSync(itemPath).isDirectory()
            ? `/${item}/*`
            : `/${item}`,
          cacheControl: "public,max-age=3600,must-revalidate",
        });
      }
      const browserBuildFileOptions = {
        exclude: "*",
        include: `${this.remixConfig.publicPath}*`,
        cacheControl: "public,max-age=31536000,immutable",
      };
      const fileOptions = [browserBuildFileOptions, ...publicFileOptions];

      FileOptions = (fileOptions || []).map(
        ({ exclude, include, cacheControl }) => {
          return [
            "--exclude",
            exclude,
            "--include",
            include,
            "--cache-control",
            cacheControl,
          ];
        }
      );
    }

    // Create custom resource
    return new CustomResource(this, "S3Deployment", {
      serviceToken: handler.functionArn,
      resourceType: "Custom::SSTBucketDeployment",
      properties: {
        Sources: this.staticsS3Assets.map((asset) => ({
          BucketName: asset.s3BucketName,
          ObjectKey: asset.s3ObjectKey,
        })),
        DestinationBucketName: this.cdk.bucket.bucketName,
        FileOptions,
      },
    });
  }

  // #endregion

  // #region Server Lambda

  private createServerFunctionRole(): iam.Role {
    const role = new iam.Role(this, `ServerLambdaRole`, {
      assumedBy: this.props.edge
        ? new iam.CompositePrincipal(
            new iam.ServicePrincipal("lambda.amazonaws.com"),
            new iam.ServicePrincipal("edgelambda.amazonaws.com")
          )
        : new iam.ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromManagedPolicyArn(
          this,
          "LambdaPolicy",
          "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
        ),
      ],
    });

    // Attach permission
    this.cdk.bucket.grantReadWrite(role);
    if (this.props.defaults?.function?.permissions) {
      attachPermissionsToRole(role, this.props.defaults.function.permissions);
    }

    return role;
  }

  private createApigServerFunction(args: {
    lambdaSourceMeta: LambdaSourceMeta;
  }): Api {
    return new Api(this, "Api", {
      routes: {
        "ANY /{proxy+}": {
          function: {
            srcPath: args.lambdaSourceMeta.directory,
            handler: args.lambdaSourceMeta.handler,
            logRetention: logs.RetentionDays.THREE_DAYS,
            memorySize: this.props.defaults?.function?.memorySize || 512,
            currentVersionOptions: {
              removalPolicy: RemovalPolicy.DESTROY,
            },
            runtime: "nodejs16.x",
            timeout: `${this.props.defaults?.function?.timeout || 10} seconds`,
            role: this.serverLambdaRole,
            environment: this.props.environment,
          },
        },
      },
    });
  }

  private createEdgeServerFunction(args: {
    lambdaSourceMeta: LambdaSourceMeta;
    sitePath: string;
  }): lambda.IVersion {
    // Note: this function is a bit heavy. I intentionally moved everything into
    // it to make it much more clear where the responsibility boundary is, so
    // that we can hopefully transistion this method into a pure method, and
    // then finally move it out into an abstraction that can be reused by other
    // constructs. We need to get rid of "this" everywhere.

    const name = "Server";

    const createEdgeServerBundleAsset = (args: {
      lambdaSourceMeta: LambdaSourceMeta;
      sitePath: string;
    }) => {
      this.logInfo(`Bundling server`);

      const localId = path.posix
        .join(this.scope.node.path, this.id)
        .replace(/\$/g, "-")
        .replace(/\//g, "-")
        .replace(/\./g, "-");

      const bundle =
        this.props.bundle === undefined ? undefined : this.props.bundle;
      if (!bundle && args.sitePath === ".") {
        throw new Error(
          `Bundle cannot be disabled for the "${this.id}" function since the "srcPath" is set to the project root. Read more here — https://github.com/serverless-stack/sst/issues/78`
        );
      }

      const bundled = Runtime.Handler.bundle({
        id: localId,
        root: this.props.path,
        handler: args.lambdaSourceMeta.handler,
        runtime: lambda.Runtime.NODEJS_16_X.toString(),
        srcPath: args.lambdaSourceMeta.directory,
        bundle,
      })!;

      if (!("directory" in bundled)) {
        throw new Error(`Server bundle produced unexpected output`);
      }

      Function.copyFiles(
        bundle,
        args.lambdaSourceMeta.directory,
        bundled.directory
      );

      return {
        asset: new s3Assets.Asset(this, `ServerFunctionAsset`, {
          path: bundled.directory,
        }),
        directory: bundled.directory,
        handler: bundled.handler,
      };
    };

    const createEdgeLambdaCodeReplacer = (
      name: string,
      asset: s3Assets.Asset
    ): CustomResource => {
      // Note: Source code for the Lambda functions have "{{ ENV_KEY }}" in them.
      //       They need to be replaced with real values before the Lambda
      //       functions get deployed.

      const providerId = "LambdaCodeReplacerProvider";
      const resId = `${name}LambdaCodeReplacer`;
      const stack = Stack.of(this);
      let provider = stack.node.tryFindChild(providerId) as lambda.Function;

      // Create provider if not already created
      if (!provider) {
        provider = new lambda.Function(stack, providerId, {
          code: lambda.Code.fromAsset(
            // TODO: Move this file into a shared folder
            // This references a Nextjs directory, but the underlying
            // code appears to be generic enough to utilise in this case.
            path.join(__dirname, "../assets/NextjsSite/custom-resource")
          ),
          layers: [this.awsCliLayer],
          runtime: lambda.Runtime.PYTHON_3_7,
          handler: "lambda-code-updater.handler",
          timeout: Duration.minutes(15),
          memorySize: 1024,
        });
      }

      // Allow provider to perform search/replace on the asset
      provider.role?.addToPrincipalPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["s3:*"],
          resources: [
            `arn:aws:s3:::${asset.s3BucketName}/${asset.s3ObjectKey}`,
          ],
        })
      );

      // Create custom resource
      const resource = new CustomResource(this, resId, {
        serviceToken: provider.functionArn,
        resourceType: "Custom::SSTLambdaCodeUpdater",
        properties: {
          Source: {
            BucketName: asset.s3BucketName,
            ObjectKey: asset.s3ObjectKey,
          },
          ReplaceValues: [
            {
              files: "**/*.js",
              search: '"{{ _SST_REMIX_SITE_ENVIRONMENT_ }}"',
              replace: JSON.stringify(this.props.environment || {}),
            },
          ],
        },
      });

      return resource;
    };

    const createEdgeServerFunctionInUE1 = (
      name: string,
      asset: s3Assets.Asset,
      assetPath: string,
      handler: string
    ): lambda.IVersion => {
      const { defaults } = this.props;

      // Create function
      const fn = new lambda.Function(this, `${name}Function`, {
        description: `${name} handler for Remix`,
        handler,
        currentVersionOptions: {
          removalPolicy: RemovalPolicy.DESTROY,
        },
        logRetention: logs.RetentionDays.THREE_DAYS,
        code: lambda.Code.fromAsset(assetPath),
        runtime: lambda.Runtime.NODEJS_16_X,
        memorySize: defaults?.function?.memorySize || 512,
        timeout: Duration.seconds(defaults?.function?.timeout || 10),
        role: this.serverLambdaRole,
      });

      // Create alias
      fn.currentVersion.addAlias("live");

      // Deploy after the code is updated
      if (!this.isPlaceholder) {
        const updaterCR = createEdgeLambdaCodeReplacer(name, asset);
        fn.node.addDependency(updaterCR);
      }

      return fn.currentVersion;
    };

    const createEdgeServerFunctionInNonUE1 = (
      name: string,
      asset: s3Assets.Asset,
      _assetPath: string,
      handler: string
    ): lambda.IVersion => {
      const { defaults } = this.props;

      // If app region is NOT us-east-1, create a Function in us-east-1
      // using a Custom Resource

      // Create a S3 bucket in us-east-1 to store Lambda code. Create
      // 1 bucket for all Edge functions.
      const bucketCR = crossRegionHelper.getOrCreateBucket(this);
      const bucketName = bucketCR.getAttString("BucketName");

      // Create a Lambda function in us-east-1
      const functionCR = crossRegionHelper.createFunction(
        this,
        name,
        this.serverLambdaRole!,
        bucketName,
        {
          Description: `${name} handler for Remix`,
          Handler: handler,
          Code: {
            S3Bucket: asset.s3BucketName,
            S3Key: asset.s3ObjectKey,
          },
          Runtime: lambda.Runtime.NODEJS_16_X.name,
          MemorySize: defaults?.function?.memorySize || 512,
          Timeout: Duration.seconds(
            defaults?.function?.timeout || 10
          ).toSeconds(),
          Role: this.serverLambdaRole!.roleArn,
        }
      );
      const functionArn = functionCR.getAttString("FunctionArn");

      // Create a Lambda function version in us-east-1
      const versionCR = crossRegionHelper.createVersion(
        this,
        name,
        functionArn
      );
      const versionId = versionCR.getAttString("Version");
      crossRegionHelper.updateVersionLogicalId(functionCR, versionCR);

      // Deploy after the code is updated
      if (!this.isPlaceholder) {
        const updaterCR = createEdgeLambdaCodeReplacer(name, asset);
        functionCR.node.addDependency(updaterCR);
      }

      return lambda.Version.fromVersionArn(
        this,
        `${name}FunctionVersion`,
        `${functionArn}:${versionId}`
      );
    };

    const { asset, directory, handler } = createEdgeServerBundleAsset(args);

    // Create function based on region
    const root = this.node.root as App;
    return root.region === "us-east-1"
      ? createEdgeServerFunctionInUE1(name, asset, directory, handler)
      : createEdgeServerFunctionInNonUE1(name, asset, directory, handler);
  }

  // #endregion

  // #region CloudFront Distribution

  private createCloudFrontDistribution(): cloudfront.Distribution {
    const { cdk, customDomain } = this.props;
    const cfDistributionProps = cdk?.distribution || {};

    // Validate input
    if (cfDistributionProps.certificate) {
      throw new Error(
        `Do not configure the "cfDistribution.certificate". Use the "customDomain" to configure the RemixSite domain certificate.`
      );
    }
    if (cfDistributionProps.domainNames) {
      throw new Error(
        `Do not configure the "cfDistribution.domainNames". Use the "customDomain" to configure the RemixSite domain.`
      );
    }

    // Build domainNames
    const domainNames = [];
    if (!customDomain) {
      // no domain
    } else if (typeof customDomain === "string") {
      domainNames.push(customDomain);
    } else {
      domainNames.push(customDomain.domainName);
    }

    const origin = new origins.S3Origin(this.cdk.bucket);
    const viewerProtocolPolicy =
      cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS;

    // Return the placeholder site if intended to be a placeholder;
    if (this.isPlaceholder) {
      return new cloudfront.Distribution(this, "Distribution", {
        defaultRootObject: "index.html",
        errorResponses: buildErrorResponsesForRedirectToIndex("index.html"),
        domainNames,
        certificate: this.cdk.certificate,
        defaultBehavior: {
          origin,
          viewerProtocolPolicy,
        },
      });
    }

    // Build cache policies
    const browserBuildCachePolicy =
      cdk?.cachePolicies?.browserBuildCachePolicy ??
      this.createCloudFrontBrowserBuildAssetsCachePolicy();
    const publicCachePolicy =
      cdk?.cachePolicies?.publicCachePolicy ??
      this.createCloudFrontPublicCachePolicy();
    const serverResponseCachePolicy =
      cdk?.cachePolicies?.serverResponseCachePolicy ??
      this.createCloudFrontServerResponseCachePolicy();

    let defaultBehavior: BehaviorOptions;

    if (this.serverFunction instanceof Api) {
      const apiId = this.serverFunction.httpApiId;
      const region = Stack.of(this).region;
      const urlSuffix = Stack.of(this).urlSuffix;
      const apiDomain = `${apiId}.execute-api.${region}.${urlSuffix}`;
      defaultBehavior = {
        viewerProtocolPolicy,
        origin: new origins.HttpOrigin(apiDomain),
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
        compress: true,
        cachePolicy: serverResponseCachePolicy,
        ...(cfDistributionProps.defaultBehavior || {}),
      };
    } else if (this.serverFunction != null) {
      defaultBehavior = {
        viewerProtocolPolicy,
        origin,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
        compress: true,
        cachePolicy: serverResponseCachePolicy,
        ...(cfDistributionProps.defaultBehavior || {}),
        edgeLambdas: [
          {
            includeBody: true,
            eventType: cloudfront.LambdaEdgeEventType.ORIGIN_REQUEST,
            functionVersion: this.serverFunction,
          },
          ...(cfDistributionProps.defaultBehavior?.edgeLambdas || []),
        ],
      };
    } else {
      throw new Error('Internal error: "serverFunction" not set');
    }

    const additionalBehaviours: Record<string, cloudfront.BehaviorOptions> = {};

    // Create additional behaviours for public folder statics
    const publicPath = path.join(this.props.path, "public");
    const publicBehaviourOptions: cloudfront.BehaviorOptions = {
      viewerProtocolPolicy,
      origin,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
      cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
      compress: true,
      cachePolicy: publicCachePolicy,
    };
    for (const item of fs.readdirSync(publicPath)) {
      if (item === "build") {
        // This is the browser build, so it will have its own cache policy
        additionalBehaviours["/build/*"] = {
          ...publicBehaviourOptions,
          cachePolicy: browserBuildCachePolicy,
        };
      } else {
        // This is a public asset, so it will use the public cache policy
        const itemPath = path.join(publicPath, item);
        additionalBehaviours[
          fs.statSync(itemPath).isDirectory() ? `/${item}/*` : `/${item}`
        ] = publicBehaviourOptions;
      }
    }

    // Create Distribution
    return new cloudfront.Distribution(this, "Distribution", {
      // these values can be overwritten by cfDistributionProps
      defaultRootObject: "",
      // Override props.
      ...cfDistributionProps,
      // these values can NOT be overwritten by cfDistributionProps
      domainNames,
      certificate: this.cdk.certificate,
      defaultBehavior,
      additionalBehaviors: {
        ...additionalBehaviours,
        ...(cfDistributionProps.additionalBehaviors || {}),
      },
    });
  }

  private createCloudFrontBrowserBuildAssetsCachePolicy(): cloudfront.CachePolicy {
    return new cloudfront.CachePolicy(
      this,
      "BrowserBuildAssetsCache",
      RemixSite.browserBuildCachePolicyProps
    );
  }

  private createCloudFrontPublicCachePolicy(): cloudfront.CachePolicy {
    return new cloudfront.CachePolicy(
      this,
      "PublicAssetsCache",
      RemixSite.publicCachePolicyProps
    );
  }

  private createCloudFrontServerResponseCachePolicy(): cloudfront.CachePolicy {
    return new cloudfront.CachePolicy(
      this,
      "ServerResponseCache",
      RemixSite.serverResponseCachePolicyProps
    );
  }

  private createCloudFrontInvalidation(): CustomResource {
    // Create a Lambda function that will be doing the invalidation
    const invalidator = new lambda.Function(this, "CloudFrontInvalidator", {
      code: lambda.Code.fromAsset(
        path.join(__dirname, "../assets/BaseSite/custom-resource")
      ),
      layers: [this.awsCliLayer],
      runtime: lambda.Runtime.PYTHON_3_7,
      handler: "cf-invalidate.handler",
      timeout: Duration.minutes(15),
      memorySize: 1024,
    });

    // Grant permissions to invalidate CF Distribution
    invalidator.addToRolePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: [
          "cloudfront:GetInvalidation",
          "cloudfront:CreateInvalidation",
        ],
        resources: ["*"],
      })
    );

    // We need a versionId so that CR gets updated on each deploy
    let versionId: string | undefined;
    if (this.isPlaceholder) {
      versionId = "live";
    } else {
      // We will generate a hash based on the contents of the "public" folder
      // which will be used to indicate if we need to invalidate our CloudFront
      // cache. As the browser build files are always uniquely hash in their
      // filenames according to their content we can ignore the browser build
      // files.

      const result = spawn.sync("node", [
        path.resolve(__dirname, "../assets/nodejs/folder-hash.cjs"),
        "--path",
        path.resolve(this.props.path, "public"),
        // Ignore the browser build files;
        "--ignore",
        "build",
      ]);
      if (result.error != null) {
        throw new Error(
          `Failed to to create version hash for "public" directory.\n${result.error}`
        );
      }
      if (result.status !== 0) {
        throw new Error(
          `Failed to to create version hash for "public" directory.\n${result.stderr}`
        );
      }
      versionId = result.stdout.toString();
      if (versionId == null) {
        throw new Error(
          `Could not resolve the versionId hash for the Remix "public" dir.`
        );
      }

      this.logInfo(`CloudFront invalidation version: ${versionId}`);
    }

    const waitForInvalidation =
      this.props.waitForInvalidation === false ? false : true;

    return new CustomResource(this, "CloudFrontInvalidation", {
      serviceToken: invalidator.functionArn,
      resourceType: "Custom::SSTCloudFrontInvalidation",
      properties: {
        BuildId: versionId,
        DistributionId: this.cdk.distribution.distributionId,
        DistributionPaths: ["/*"],
        WaitForInvalidation: waitForInvalidation,
      },
    });
  }

  // #endregion

  // #region Custom Domain

  protected validateCustomDomainSettings() {
    const { customDomain } = this.props;

    if (!customDomain) {
      return;
    }

    if (typeof customDomain === "string") {
      return;
    }

    if (customDomain.isExternalDomain === true) {
      if (!customDomain.cdk?.certificate) {
        throw new Error(
          `A valid certificate is required when "isExternalDomain" is set to "true".`
        );
      }
      if (customDomain.domainAlias) {
        throw new Error(
          `Domain alias is only supported for domains hosted on Amazon Route 53. Do not set the "customDomain.domainAlias" when "isExternalDomain" is enabled.`
        );
      }
      if (customDomain.hostedZone) {
        throw new Error(
          `Hosted zones can only be configured for domains hosted on Amazon Route 53. Do not set the "customDomain.hostedZone" when "isExternalDomain" is enabled.`
        );
      }
    }
  }

  protected lookupHostedZone(): route53.IHostedZone | undefined {
    const { customDomain } = this.props;

    // Skip if customDomain is not configured
    if (!customDomain) {
      return;
    }

    let hostedZone;

    if (typeof customDomain === "string") {
      hostedZone = route53.HostedZone.fromLookup(this, "HostedZone", {
        domainName: customDomain,
      });
    } else if (customDomain.cdk?.hostedZone) {
      hostedZone = customDomain.cdk.hostedZone;
    } else if (typeof customDomain.hostedZone === "string") {
      hostedZone = route53.HostedZone.fromLookup(this, "HostedZone", {
        domainName: customDomain.hostedZone,
      });
    } else if (typeof customDomain.domainName === "string") {
      // Skip if domain is not a Route53 domain
      if (customDomain.isExternalDomain === true) {
        return;
      }

      hostedZone = route53.HostedZone.fromLookup(this, "HostedZone", {
        domainName: customDomain.domainName,
      });
    } else {
      hostedZone = customDomain.hostedZone;
    }

    return hostedZone;
  }

  private createCertificate(): acm.ICertificate | undefined {
    const { customDomain } = this.props;

    if (!customDomain) {
      return;
    }

    let acmCertificate;

    // HostedZone is set for Route 53 domains
    if (this.cdk.hostedZone) {
      if (typeof customDomain === "string") {
        acmCertificate = new acm.DnsValidatedCertificate(this, "Certificate", {
          domainName: customDomain,
          hostedZone: this.cdk.hostedZone,
          region: "us-east-1",
        });
      } else if (customDomain.cdk?.certificate) {
        acmCertificate = customDomain.cdk.certificate;
      } else {
        acmCertificate = new acm.DnsValidatedCertificate(this, "Certificate", {
          domainName: customDomain.domainName,
          hostedZone: this.cdk.hostedZone,
          region: "us-east-1",
        });
      }
    }
    // HostedZone is NOT set for non-Route 53 domains
    else {
      if (typeof customDomain !== "string") {
        acmCertificate = customDomain.cdk?.certificate;
      }
    }

    return acmCertificate;
  }

  protected createRoute53Records(): void {
    const { customDomain } = this.props;

    if (!customDomain || !this.cdk.hostedZone) {
      return;
    }

    let recordName;
    let domainAlias;
    if (typeof customDomain === "string") {
      recordName = customDomain;
    } else {
      recordName = customDomain.domainName;
      domainAlias = customDomain.domainAlias;
    }

    // Create DNS record
    const recordProps = {
      recordName,
      zone: this.cdk.hostedZone,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.CloudFrontTarget(this.cdk.distribution)
      ),
    };
    new route53.ARecord(this, "AliasRecord", recordProps);
    new route53.AaaaRecord(this, "AliasRecordAAAA", recordProps);

    // Create Alias redirect record
    if (domainAlias) {
      new route53Patterns.HttpsRedirect(this, "Redirect", {
        zone: this.cdk.hostedZone,
        recordNames: [domainAlias],
        targetDomain: recordName,
      });
    }
  }

  // #endregion

  // #region Helper Functions

  private registerSiteEnvironment() {
    const environmentOutputs: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.props.environment || {})) {
      const outputId = `SstSiteEnv_${key}`;
      const output = new CfnOutput(this, outputId, { value });
      environmentOutputs[key] = Stack.of(this).getLogicalId(output);
    }

    const root = this.node.root as App;
    root.registerSiteEnvironment({
      id: this.node.id,
      path: this.props.path,
      stack: Stack.of(this).node.id,
      environmentOutputs,
    } as BaseSiteEnvironmentOutputsInfo);
  }

  private logInfo(msg: string) {
    console.log(chalk.grey(`RemixSite(${this.props.path}): ${msg}`));
  }

  // #endregion
}
