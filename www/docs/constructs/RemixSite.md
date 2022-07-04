---
description: "Docs for the sst.RemixSite construct in the @serverless-stack/resources package"
---
<!--
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
!!                                                           !!
!!  This file has been automatically generated, do not edit  !!
!!                                                           !!
!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
-->
The `RemixSite` construct is a higher level CDK construct that makes it easy
to create a Remix app. It provides a simple way to build and deploy your site
to CloudFront.

By default server rendering is performed within an APIGatewayV2 Lambda,
however, it also supports the use of Lambda@Edge (via the `edge` prop). Additionally
it supports environment variables against the Lambda@Edge deployment
despite this being a limitation of Lambda@Edge.

The browser build and public statics are backed by an S3 Bucket. CloudFront
cache policies are configured, whilst also allowing for customization, and we
include cache invalidation on deployment.

The construct enables you to customize many of the deployment features,
including the ability to configure a custom domain for the website URL.

It enables you to [automatically set the environment
variables](#configuring-environment-variables) for your Remix app directly
from the outputs in your SST app.


## Constructor
```ts
new RemixSite(scope, id, props)
```
_Parameters_
- __scope__ <span class="mono">[Construct](https://docs.aws.amazon.com/cdk/api/v2/docs/constructs.Construct.html)</span>
- __id__ <span class="mono">string</span>
- __props__ <span class="mono">[RemixSiteProps](#remixsiteprops)</span>

### Creating a Remix app

We recommend bootstrapping your Remix application via the following steps in order to ensure maximum compatibility with this construct;

1. Within your SST project run the Remix CLI to create an application;

   ```bash title="Create a Remix application"
   npx create-remix@latest
   ```

2. When presented with the type of deployment question, select "Remix App Server";

   ![Selecting "Remix App Server" deployment](/img/remix/bootstrap-remix.png)

3. After the installation has completed add the following dependency to your Remix application's `package.json`;

   ```bash title="Install sst-env"
   npm install --save-dev @serverless-stack/static-site-env
   ```

   > Or use your package manager of choices form of the above.

4. Update the package.json scripts for your Remix application;

   ```diff title="Update package.json scripts"
     "scripts": {
       "build": "remix build",
   -   "dev": "remix dev",
   +   "dev": "sst-env -- remix dev",
   -   "start": "remix-serve build"
     },
   ```

5. Create your stack and add the `RemixSite` construct, pointing at the new application;

   ```js title="Create RemixSite instance"
   new RemixSite(stack, "RemixSite", {
     path: "path/to/site",
   });
   ```

> **Note**
>
> We depend on your "build" script to bundle your Remix application. We are aware that Remix does not enable you to customise their underlying build configuration and that it is often the case that the "build" script is extended to perform additional functions such as Tailwind compilation. Therefore we feel that targetting the "build" script rather than the `remix build` command directly will ensure that all your required build artifacts are available prior to deployment.
>
> The `path` **must** be pointing to the root of your Remix application.

### Environment variables

The `RemixSite` construct allows you to set the environment variables in your Remix app based on outputs from other constructs in your SST app. So you don't have to hard code the config from your backend. Let's look at how.

To expose environment variables to your Remix application you should utilise the `RemixSite` construct `environment` configuration property rather than an `.env` file within your Remix application root.

```js {3-6}
new RemixSite(this, "RemixSite", {
  path: "path/to/site",
  environment: {
    API_URL: api.url,
    USER_POOL_CLIENT: auth.cognitoUserPoolClient.userPoolClientId,
  },
});
```

Where `api.url` or `auth.cognitoUserPoolClient.userPoolClientId` are coming from other constructs in your SST app.

:::caution
Remix only supports environment variables within the server runtime environment. It does not inline replace environment variables like some other solutions (e.g. Create React App).

If your require environment variables within your routes/components then we recommend that you [follow their guide](https://remix.run/docs/en/v1/guides/envvars#browser-environment-variables), returning the required environment variables within the `loader` associated within your Remix route.

```js title="app/routes/index.tsx"
// Loaders will only be included in your server build. Therefore the environment
// variables will be available;
export async function loader() {
  return json({
    ENV: {
      apiUrl: process.env.API_URL,
      userPoolClient: process.env.USER_POOL_CLIENT,
    }
  });
}
```

If other modules within your application require access to an environment variable then we recommend that you pass the environment variable to the respective module via the loader;

```js title="app/routes/index.tsx"
import apiClient from "~/lib/api-client.js";

export async function loader() {
  const articles = await apiClient(process.env.API_URL).fetchArticles();

  return json({
    articles
  });
}
```
:::

#### While deploying

On `sst deploy` we deploy your Remix server.

:::caution
If you configured your `RemixSite` to deploy to Lamba@Edge, it is important to understand that Lambda@Edge does not support runtime environment variables.

To get around this limitation your environment variables will first be replaced by placeholder values, `{{ API_URL }}` and `{{ USER_POOL_CLIENT }}`. After the referenced resources have been created, the Api and User Pool in this case, the placeholders in the Lambda JS will be replaced with the actual values.

We only replace environment variables within the code that is deployed to your Lamba@Edge. i.e. the server for your Remix application. Deployments to APIGatewayV2 support runtime environment variables.
:::

#### While developing

To use these values while developing, run `sst start` to start the [Live Lambda Development](/live-lambda-development.md) environment.

``` bash
npm start
```

Then in your Remix app to reference these variables, add the [`sst-env`](/packages/static-site-env.md) package.

```bash
npm install --save-dev @serverless-stack/static-site-env
```

And tweak the Remix `dev` script to:

```json title="package.json" {2}
"scripts": {
  "build": "remix build",
  "dev": "sst-env -- remix dev",
  "start": "remix-serve build"
},
```

Now you can start your Remix app as usual and it'll have the environment variables from your SST app.

``` bash
npm run dev
```

There are a couple of things happening behind the scenes here:

1. The `sst start` command generates a file with the values specified by the `RemixSite` construct's `environment` prop.
2. The `sst-env` CLI will traverse up the directories to look for the root of your SST app.
3. It'll then find the file that's generated in step 1.
4. It'll load these as environment variables before running the start command.

:::note
`sst-env` only works if the Remix app is located inside the SST app or inside one of its subdirectories. For example:

```
/
  sst.json
  remix-app/
```
:::


### Deploying to Lamba@Edge

```js {3}
new RemixSite(this, "Site", {
  path: "path/to/site",
  edge: true,
});
```

### Custom domains

You can configure the website with a custom domain hosted either on [Route 53](https://aws.amazon.com/route53/) or [externally](#configuring-externally-hosted-domain).

#### Using the basic config (Route 53 domains)

```js {3}
new RemixSite(this, "Site", {
  path: "path/to/site",
  customDomain: "domain.com",
});
```

#### Redirect www to non-www (Route 53 domains)

```js {3-6}
new RemixSite(this, "Site", {
  path: "path/to/site",
  customDomain: {
    domainName: "domain.com",
    domainAlias: "www.domain.com",
  },
});
```

#### Configuring domains across stages (Route 53 domains)

```js {3-7}
new RemixSite(this, "Site", {
  path: "path/to/site",
  customDomain: {
    domainName:
      scope.stage === "prod" ? "domain.com" : `${scope.stage}.domain.com`,
    domainAlias: scope.stage === "prod" ? "www.domain.com" : undefined,
  },
});
```

#### Using the full config (Route 53 domains)

```js {3-7}
new RemixSite(this, "Site", {
  path: "path/to/site",
  customDomain: {
    domainName: "domain.com",
    domainAlias: "www.domain.com",
    hostedZone: "domain.com",
  },
});
```

#### Importing an existing certificate (Route 53 domains)

```js {8}
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";

new RemixSite(this, "Site", {
  path: "path/to/site",
  customDomain: {
    domainName: "domain.com",
    cdk: {
      certificate: Certificate.fromCertificateArn(this, "MyCert", certArn),
    },
  },
});
```

Note that, the certificate needs be created in the `us-east-1`(N. Virginia) region as required by AWS CloudFront.

#### Specifying a hosted zone (Route 53 domains)

If you have multiple hosted zones for a given domain, you can choose the one you want to use to configure the domain.

```js {8-11}
import { HostedZone } from "aws-cdk-lib/aws-route53";

new RemixSite(this, "Site", {
  path: "path/to/site",
  customDomain: {
    domainName: "domain.com",
    cdk: {
      hostedZone: HostedZone.fromHostedZoneAttributes(this, "MyZone", {
        hostedZoneId,
        zoneName,
      }),
    },
  },
});
```

#### Configuring externally hosted domain

```js {5-11}
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";

new RemixSite(this, "Site", {
  path: "path/to/site",
  cutomDomain: {
    isExternalDomain: true,
    domainName: "domain.com",
    cdk: {
      certificate: Certificate.fromCertificateArn(this, "MyCert", certArn),
    },
  },
});
```

Note that the certificate needs be created in the `us-east-1`(N. Virginia) region as required by AWS CloudFront, and validated. After the `Distribution` has been created, create a CNAME DNS record for your domain name with the `Distribution's` URL as the value. Here are more details on [configuring SSL Certificate on externally hosted domains](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/CNAMEs.html).

Also note that you can also migrate externally hosted domains to Route 53 by [following this guide](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/MigratingDNS.html).

### Configuring the Lambda Function

Configure the internally created CDK [`Lambda Function`](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_lambda.Function.html) instance.

```js {4-8}
new RemixSite(stack, "Site", {
  path: "path/to/site",
  defaults: {
    function: {
      timeout: 20,
      memorySize: 2048,
      permissions: ["sns"],
    }
  },
});
```

### Permissions

You can attach a set of [permissions](Permissions.md) to allow the Remix server lambda, enabling it to access other AWS resources.

```js {5}
const site = new RemixSite(this, "Site", {
  path: "path/to/site",
});

site.attachPermissions(["sns"]);
```

### Advanced examples

#### Configuring the Lambda Function

Configure the internally created CDK [`Lambda Function`](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_lambda.Function.html) instance.

```js {4-8}
new RemixSite(this, "Site", {
  path: "path/to/site",
  defaults: {
    function: {
      timeout: 20,
      memorySize: 2048,
      permissions: ["sns"],
    },
  },
});
```

#### Reusing CloudFront cache policies

CloudFront has a limit of 20 cache policies per AWS account. This is a hard limit, and cannot be increased. Each `RemixSite` creates 3 cache policies. If you plan to deploy multiple Remix sites, you can have the constructs share the same cache policies by reusing them across sites.

```js
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";

const cachePolicies = {
  browserBuildCachePolicy: new cloudfront.CachePolicy(this, "BrowserBuildStaticsCache", RemixSite.browserBuildCachePolicyProps),
  publicCachePolicy: new cloudfront.CachePolicy(this, "PublicStaticsCache", RemixSite.publicCachePolicyProps),
  serverResponseCachePolicy: new cloudfront.CachePolicy(this, "ServerResponseCache", RemixSite.serverResponseCachePolicyProps),
};

new RemixSite(this, "Site1", {
  path: "path/to/site1",
  cdk: {
    cachePolicies,
  }
});

new RemixSite(this, "Site2", {
  path: "path/to/site2",
  cdk: {
    cachePolicies,
  }
});
```

## RemixSiteProps


### bundle?

_Type_ : <span class="mono">[FunctionBundleNodejsProps](Function#functionbundlenodejsprops)</span>

Pass in a custom bundling configuration for the server lambda.

### customDomain?

_Type_ : <span class='mono'><span class="mono">string</span> | <span class="mono">[RemixDomainProps](#remixdomainprops)</span></span>

The customDomain for this website. SST supports domains that are hosted
either on [Route 53](https://aws.amazon.com/route53/) or externally.
Note that you can also migrate externally hosted domains to Route 53 by
[following this guide](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/MigratingDNS.html).


```js {3}
new RemixSite(stack, "RemixSite", {
  path: "path/to/site",
  customDomain: "domain.com",
});
```

```js {3-6}
new RemixSite(stack, "RemixSite", {
  path: "path/to/site",
  customDomain: {
    domainName: "domain.com",
    domainAlias: "www.domain.com",
    hostedZone: "domain.com"
  },
});
```



### defaults.function.memorySize?

_Type_ : <span class="mono">number</span>

### defaults.function.permissions?

_Type_ : <span class="mono">[Permissions](Permissions)</span>

### defaults.function.timeout?

_Type_ : <span class="mono">number</span>



Override the configuration for the server render Lambda.

### disablePlaceholder?

_Type_ : <span class="mono">boolean</span>

When running `sst start`, a placeholder site is deployed. This is to ensure
that the site content remains unchanged, and subsequent `sst start` can
start up quickly.


```js {3}
new RemixSite(stack, "RemixSite", {
  path: "path/to/site",
  disablePlaceholder: true,
});
```

### edge?

_Type_ : <span class="mono">boolean</span>

_Default_ : <span class="mono">false</span>

If `true` your RemixSite server render handler will be deployed to
Lambda@Edge, else it will be deployed as an APIGatewayV2 Lambda.

### environment?

_Type_ : <span class="mono">Record&lt;<span class="mono">string</span>, <span class="mono">string</span>&gt;</span>

An object with the key being the environment variable name.


```js {3-6}
new RemixSite(stack, "RemixSite", {
  path: "path/to/site",
  environment: {
    API_URL: api.url,
    USER_POOL_CLIENT: auth.cognitoUserPoolClient.userPoolClientId,
  },
});
```

### path

_Type_ : <span class="mono">string</span>

Path to the directory where the website source is located.

### waitForInvalidation?

_Type_ : <span class="mono">boolean</span>

While deploying, SST waits for the CloudFront cache invalidation process to
finish. This ensures that the new content will be served once the deploy
command finishes. However, this process can sometimes take more than 5
mins. For non-prod environments it might make sense to pass in `false`.
That'll skip waiting for the cache to invalidate and speed up the deploy
process.


### cdk.bucket?

_Type_ : <span class="mono">[BucketProps](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_s3.BucketProps.html)</span>

Pass in bucket information to override the default settings this
construct uses to create the CDK Bucket internally.


### cdk.cachePolicies.browserBuildCachePolicy?

_Type_ : <span class="mono">[ICachePolicy](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_cloudfront.ICachePolicy.html)</span>

Override the CloudFront cache policy properties for browser build files.

### cdk.cachePolicies.publicCachePolicy?

_Type_ : <span class="mono">[ICachePolicy](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_cloudfront.ICachePolicy.html)</span>

Override the CloudFront cache policy properties for "public" folder
static files.
Note: This will not include the browser build files, which have a seperate
cache policy; @see `browserBuildCachePolicy`.

### cdk.cachePolicies.serverResponseCachePolicy?

_Type_ : <span class="mono">[ICachePolicy](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_cloudfront.ICachePolicy.html)</span>

Override the CloudFront cache policy properties for responses from the
server rendering Lambda.



The default cache policy that is used in the abscene of this property
is one that performs no caching of the server response.


Override the default CloudFront cache policies created internally.

### cdk.distribution?

_Type_ : <span class="mono">[RemixCdkDistributionProps](#remixcdkdistributionprops)</span>

Pass in a value to override the default settings this construct uses to
create the CDK `Distribution` internally.


Customise aspects of the CDK deployment.

## Properties
An instance of `RemixSite` has the following properties.
### browserBuildCachePolicyProps

_Type_ : <span class="mono">[CachePolicyProps](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_cloudfront.CachePolicyProps.html)</span>

The default CloudFront cache policy properties for browser build files.

### bucketArn

_Type_ : <span class="mono">string</span>

The ARN of the internally created S3 Bucket.

### bucketName

_Type_ : <span class="mono">string</span>

The name of the internally created S3 Bucket.

### customDomainUrl

_Type_ : <span class='mono'><span class="mono">undefined</span> | <span class="mono">string</span></span>

If the custom domain is enabled, this is the URL of the website with the
custom domain.

### distributionDomain

_Type_ : <span class="mono">string</span>

The domain name of the internally created CloudFront Distribution.

### distributionId

_Type_ : <span class="mono">string</span>

The ID of the internally created CloudFront Distribution.

### publicCachePolicyProps

_Type_ : <span class="mono">[CachePolicyProps](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_cloudfront.CachePolicyProps.html)</span>

The default CloudFront cache policy properties for "public" folder
static files.



This policy is not applied to the browser build files; they have a seperate
cache policy. @see `browserBuildCachePolicyProps`.

### serverResponseCachePolicyProps

_Type_ : <span class="mono">[CachePolicyProps](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_cloudfront.CachePolicyProps.html)</span>

The default CloudFront cache policy properties for responses from the
server rendering Lambda.



By default no caching is performed on the server rendering Lambda response.

### url

_Type_ : <span class="mono">string</span>

The CloudFront URL of the website.


### cdk.bucket

_Type_ : <span class="mono">[Bucket](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_s3.Bucket.html)</span>

The internally created CDK `Bucket` instance.

### cdk.certificate?

_Type_ : <span class="mono">[ICertificate](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_certificatemanager.ICertificate.html)</span>

The AWS Certificate Manager certificate for the custom domain.

### cdk.distribution

_Type_ : <span class="mono">[Distribution](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_cloudfront.Distribution.html)</span>

The internally created CDK `Distribution` instance.

### cdk.hostedZone?

_Type_ : <span class="mono">[IHostedZone](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_route53.IHostedZone.html)</span>

The Route 53 hosted zone for the custom domain.


Exposes CDK instances created within the construct.

## Methods
An instance of `RemixSite` has the following methods.
### attachPermissions

```ts
attachPermissions(permissions)
```
_Parameters_
- __permissions__ <span class="mono">[Permissions](Permissions)</span>


Attaches the given list of permissions to allow the Remix server side
rendering to access other AWS resources.


### Attaching permissions

```js {5}
const site = new RemixSite(stack, "Site", {
  path: "path/to/site",
});

site.attachPermissions(["sns"]);
```

## RemixDomainProps


### alternateNames?

_Type_ : <span class='mono'>Array&lt;<span class="mono">string</span>&gt;</span>

_Default_ : <span class="mono">`[]`</span>

Specify additional names that should route to the Cloudfront Distribution. Note, certificates for these names will not be automatically generated so the `certificate` option must be specified.

### domainAlias?

_Type_ : <span class="mono">string</span>

_Default_ : <span class="mono">no alias configured</span>

An alternative domain to be assigned to the website URL. Visitors to the alias will be redirected to the main domain. (ie. `www.domain.com`).
Use this to create a `www.` version of your domain and redirect visitors to the root domain.
### domainName

_Type_ : <span class="mono">string</span>

The domain to be assigned to the website URL (ie. domain.com).
Supports domains that are hosted either on [Route 53](https://aws.amazon.com/route53/) or externally.

### hostedZone?

_Type_ : <span class="mono">string</span>

_Default_ : <span class="mono">same as the `domainName`</span>

The hosted zone in Route 53 that contains the domain. By default, SST will look for a hosted zone matching the domainName that's passed in.
Set this option if SST cannot find the hosted zone in Route 53.
### isExternalDomain?

_Type_ : <span class="mono">boolean</span>

_Default_ : <span class="mono">`false`</span>

Set this option if the domain is not hosted on Amazon Route 53.


### cdk.certificate?

_Type_ : <span class="mono">[ICertificate](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_certificatemanager.ICertificate.html)</span>

Import the certificate for the domain. By default, SST will create a certificate with the domain name. The certificate will be created in the `us-east-1`(N. Virginia) region as required by AWS CloudFront.
Set this option if you have an existing certificate in the `us-east-1` region in AWS Certificate Manager you want to use.

### cdk.hostedZone?

_Type_ : <span class="mono">[IHostedZone](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_route53.IHostedZone.html)</span>

Import the underlying Route 53 hosted zone.


## RemixCdkDistributionProps


### defaultBehavior?

_Type_ : <span class="mono">[AddBehaviorOptions](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_cloudfront.AddBehaviorOptions.html)</span>
