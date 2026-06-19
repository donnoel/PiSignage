import * as cdk from "aws-cdk-lib";
import { Duration, RemovalPolicy, Stack } from "aws-cdk-lib";
import type { StackProps } from "aws-cdk-lib";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as apprunner from "aws-cdk-lib/aws-apprunner";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as ecrAssets from "aws-cdk-lib/aws-ecr-assets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as nodeLambda from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import path from "node:path";
import type { Construct } from "constructs";

type BeamFoundationStackProps = StackProps & {
  environmentName: string;
};

type BeamTableDefinition = {
  id: string;
  partitionKey: string;
  sortKey?: string;
};

const tableDefinitions: BeamTableDefinition[] = [
  { id: "Accounts", partitionKey: "accountId" },
  { id: "Devices", partitionKey: "deviceId" },
  { id: "Screens", partitionKey: "screenId" },
  { id: "Playlists", partitionKey: "playlistId" },
  { id: "Assets", partitionKey: "assetId" },
  { id: "Heartbeats", partitionKey: "deviceId" },
  { id: "Releases", partitionKey: "releaseId" },
  { id: "Activity", partitionKey: "accountId", sortKey: "timestamp" }
];

export class BeamFoundationStack extends Stack {
  constructor(scope: Construct, id: string, props: BeamFoundationStackProps) {
    super(scope, id, props);

    const namePrefix = `beam-${props.environmentName}`;
    const budgetAlertEmail = "donnoel@icloud.com";

    const sourceMediaBucket = this.createPrivateBucket("SourceMediaBucket", `${namePrefix}-source-media`);
    const playbackMediaBucket = this.createPrivateBucket("PlaybackMediaBucket", `${namePrefix}-playback-media`);
    const thumbnailBucket = this.createPrivateBucket("ThumbnailBucket", `${namePrefix}-thumbnails`);
    const logBucket = this.createPrivateBucket("LogBucket", `${namePrefix}-logs`);

    const tablesById = Object.fromEntries(
      tableDefinitions.map((definition) => [definition.id, this.createTable(definition, namePrefix)])
    );
    const tables = Object.values(tablesById);
    const assetsTable = tableById(tablesById, "Assets");
    const devicesTable = tableById(tablesById, "Devices");
    const heartbeatsTable = tableById(tablesById, "Heartbeats");
    const playlistsTable = tableById(tablesById, "Playlists");
    const releasesTable = tableById(tablesById, "Releases");
    const screensTable = tableById(tablesById, "Screens");
    const heartbeatFunctionName = `${namePrefix}-heartbeat`;
    const logGroups = ["api", "device", "media", "dashboard"].map((serviceName) =>
      new logs.LogGroup(this, `${serviceName}LogGroup`, {
        logGroupName: `/beam/${props.environmentName}/${serviceName}`,
        removalPolicy: RemovalPolicy.DESTROY,
        retention: logs.RetentionDays.ONE_MONTH
      })
    );

    new cloudwatch.Dashboard(this, "OperationsDashboard", {
      dashboardName: `${namePrefix}-operations`,
      widgets: [
        [
          new cloudwatch.TextWidget({
            height: 3,
            markdown: [
              "# Beam dev foundation",
              "",
              "This dashboard is reserved for the first AWS alpha. Application metrics will be added with the API and device-agent work."
            ].join("\n"),
            width: 24
          })
        ],
        [
          new cloudwatch.GraphWidget({
            height: 6,
            left: [
              new cloudwatch.Metric({
                dimensionsMap: {
                  BucketName: playbackMediaBucket.bucketName,
                  FilterId: "EntireBucket"
                },
                metricName: "BytesDownloaded",
                namespace: "AWS/S3",
                period: Duration.hours(24),
                statistic: "Sum"
              })
            ],
            title: "Playback media bytes downloaded",
            width: 12
          }),
          new cloudwatch.GraphWidget({
            height: 6,
            left: [
              new cloudwatch.Metric({
                dimensionsMap: {
                  BucketName: playbackMediaBucket.bucketName,
                  FilterId: "EntireBucket"
                },
                metricName: "AllRequests",
                namespace: "AWS/S3",
                period: Duration.hours(24),
                statistic: "Sum"
              }),
              new cloudwatch.Metric({
                dimensionsMap: {
                  BucketName: sourceMediaBucket.bucketName,
                  FilterId: "EntireBucket"
                },
                metricName: "AllRequests",
                namespace: "AWS/S3",
                period: Duration.hours(24),
                statistic: "Sum"
              })
            ],
            title: "S3 request counts",
            width: 12
          })
        ]
      ]
    });

    new budgets.CfnBudget(this, "DailyCostBudget", {
      budget: {
        budgetLimit: {
          amount: 1,
          unit: "USD"
        },
        budgetName: `${namePrefix}-daily-cost-guardrail`,
        budgetType: "COST",
        costFilters: {
          TagKeyValue: ["user:Application$Beam"]
        },
        timeUnit: "DAILY"
      },
      notificationsWithSubscribers: [
        {
          notification: {
            comparisonOperator: "GREATER_THAN",
            notificationType: "ACTUAL",
            threshold: 80,
            thresholdType: "PERCENTAGE"
          },
          subscribers: [
            {
              address: budgetAlertEmail,
              subscriptionType: "EMAIL"
            }
          ]
        },
        {
          notification: {
            comparisonOperator: "GREATER_THAN",
            notificationType: "ACTUAL",
            threshold: 100,
            thresholdType: "PERCENTAGE"
          },
          subscribers: [
            {
              address: budgetAlertEmail,
              subscriptionType: "EMAIL"
            }
          ]
        }
      ]
    });

    const heartbeatFunction = new nodeLambda.NodejsFunction(this, "HeartbeatFunctionRestored", {
      bundling: {
        externalModules: []
      },
      description: "Accepts Beam device heartbeat events for the dev environment.",
      entry: path.join(__dirname, "..", "lambda", "heartbeat", "index.mjs"),
      environment: {
        DEFAULT_ACCOUNT_ID: "beam-dev",
        DEVICES_TABLE_NAME: devicesTable.tableName,
        HEARTBEATS_TABLE_NAME: heartbeatsTable.tableName,
        NEXT_HEARTBEAT_IN_SECONDS: "60"
      },
      functionName: `${heartbeatFunctionName}-v2`,
      handler: "index.handler",
      logGroup: new logs.LogGroup(this, "HeartbeatFunctionLogGroup", {
        logGroupName: `/aws/lambda/${heartbeatFunctionName}`,
        removalPolicy: RemovalPolicy.DESTROY,
        retention: logs.RetentionDays.ONE_MONTH
      }),
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(10)
    });
    heartbeatFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:DescribeTable", "dynamodb:GetItem", "dynamodb:PutItem"],
      resources: [heartbeatsTable.tableArn]
    }));
    heartbeatFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ["dynamodb:DescribeTable", "dynamodb:PutItem"],
      resources: [devicesTable.tableArn]
    }));

    const api = new apigateway.RestApi(this, "BeamApiRestored", {
      deployOptions: {
        stageName: props.environmentName,
        throttlingBurstLimit: 20,
        throttlingRateLimit: 10
      },
      description: "Beam dev API.",
      restApiName: `${namePrefix}-api-v2`
    });
    const plan = api.addUsagePlan("DevDeviceUsagePlan", {
      name: `${namePrefix}-device-dev`,
      throttle: {
        burstLimit: 20,
        rateLimit: 10
      }
    });
    plan.addApiStage({
      stage: api.deploymentStage
    });
    const apiKey = api.addApiKey("DevDeviceApiKey", {
      apiKeyName: `${namePrefix}-device-dev`
    });
    plan.addApiKey(apiKey);

    const v1 = api.root.addResource("v1");
    const devices = v1.addResource("devices");
    const device = devices.addResource("{deviceId}");
    const heartbeat = device.addResource("heartbeat");
    heartbeat.addMethod("POST", new apigateway.LambdaIntegration(heartbeatFunction), {
      apiKeyRequired: true
    });
    heartbeat.addMethod("GET", new apigateway.LambdaIntegration(heartbeatFunction), {
      apiKeyRequired: true
    });

    const dashboardImage = new ecrAssets.DockerImageAsset(this, "DashboardImage", {
      directory: path.join(__dirname, "..", "..", ".."),
      file: "Dockerfile.dashboard",
      platform: ecrAssets.Platform.LINUX_AMD64
    });
    const dashboardAccessRole = new iam.Role(this, "DashboardAppRunnerAccessRole", {
      assumedBy: new iam.ServicePrincipal("build.apprunner.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AWSAppRunnerServicePolicyForECRAccess")
      ]
    });
    const dashboardInstanceRole = new iam.Role(this, "DashboardAppRunnerInstanceRole", {
      assumedBy: new iam.ServicePrincipal("tasks.apprunner.amazonaws.com")
    });
    dashboardInstanceRole.addToPolicy(new iam.PolicyStatement({
      actions: ["dynamodb:BatchGetItem", "dynamodb:DescribeTable", "dynamodb:GetItem", "dynamodb:PutItem"],
      resources: [heartbeatsTable.tableArn]
    }));
    dashboardInstanceRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "dynamodb:DeleteItem",
        "dynamodb:DescribeTable",
        "dynamodb:PutItem",
        "dynamodb:Scan",
        "dynamodb:TransactWriteItems"
      ],
      resources: [devicesTable.tableArn, screensTable.tableArn]
    }));
    dashboardInstanceRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "dynamodb:DeleteItem",
        "dynamodb:DescribeTable",
        "dynamodb:PutItem",
        "dynamodb:Scan"
      ],
      resources: [playlistsTable.tableArn]
    }));
    dashboardInstanceRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "dynamodb:DeleteItem",
        "dynamodb:DescribeTable",
        "dynamodb:PutItem",
        "dynamodb:Scan"
      ],
      resources: [assetsTable.tableArn]
    }));
    dashboardInstanceRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "dynamodb:DescribeTable",
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:Scan"
      ],
      resources: [releasesTable.tableArn]
    }));
    dashboardInstanceRole.addToPolicy(new iam.PolicyStatement({
      actions: ["ce:GetCostAndUsage"],
      resources: ["*"]
    }));
    dashboardInstanceRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "s3:DeleteObject",
        "s3:GetObject",
        "s3:PutObject"
      ],
      resources: [`${sourceMediaBucket.bucketArn}/*`]
    }));
    dashboardInstanceRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        "s3:DeleteObject",
        "s3:GetObject",
        "s3:PutObject"
      ],
      resources: [`${playbackMediaBucket.bucketArn}/*`]
    }));
    const dashboardService = new apprunner.CfnService(this, "DashboardServiceV2", {
      serviceName: `${namePrefix}-dashboard`,
      sourceConfiguration: {
        authenticationConfiguration: {
          accessRoleArn: dashboardAccessRole.roleArn
        },
        autoDeploymentsEnabled: false,
        imageRepository: {
          imageConfiguration: {
            port: "3000",
            runtimeEnvironmentVariables: [
              {
                name: "BEAM_CLOUD_DEVICE_ID",
                value: "device-c5-aws-pilot"
              },
              {
                name: "BEAM_ASSETS_TABLE_NAME",
                value: assetsTable.tableName
              },
              {
                name: "BEAM_DASHBOARD_MODE",
                value: "cloud"
              },
              {
                name: "BEAM_CLOUD_API_URL",
                value: api.url
              },
              {
                name: "BEAM_DEVICES_TABLE_NAME",
                value: devicesTable.tableName
              },
              {
                name: "BEAM_HEARTBEATS_TABLE_NAME",
                value: heartbeatsTable.tableName
              },
              {
                name: "BEAM_PLAYLISTS_TABLE_NAME",
                value: playlistsTable.tableName
              },
              {
                name: "BEAM_PLAYBACK_MEDIA_BUCKET_NAME",
                value: playbackMediaBucket.bucketName
              },
              {
                name: "BEAM_RELEASES_TABLE_NAME",
                value: releasesTable.tableName
              },
              {
                name: "BEAM_SCREENS_TABLE_NAME",
                value: screensTable.tableName
              },
              {
                name: "BEAM_SOURCE_MEDIA_BUCKET_NAME",
                value: sourceMediaBucket.bucketName
              },
              {
                name: "BEAM_TRANSFER_BUDGET_DAILY_USD",
                value: "1"
              }
            ]
          },
          imageIdentifier: dashboardImage.imageUri,
          imageRepositoryType: "ECR"
        }
      },
      instanceConfiguration: {
        instanceRoleArn: dashboardInstanceRole.roleArn
      }
    });

    [
      sourceMediaBucket,
      playbackMediaBucket,
      thumbnailBucket,
      logBucket,
      ...tables,
      ...logGroups,
      heartbeatFunction,
      api,
      dashboardService
    ].forEach((resource) => {
      cdk.Tags.of(resource).add("Application", "Beam");
      cdk.Tags.of(resource).add("Environment", props.environmentName);
      cdk.Tags.of(resource).add("ManagedBy", "CDK");
    });

    new cdk.CfnOutput(this, "SourceMediaBucketName", {
      value: sourceMediaBucket.bucketName
    });
    new cdk.CfnOutput(this, "PlaybackMediaBucketName", {
      value: playbackMediaBucket.bucketName
    });
    new cdk.CfnOutput(this, "ThumbnailBucketName", {
      value: thumbnailBucket.bucketName
    });
    new cdk.CfnOutput(this, "ReleasesTableName", {
      value: releasesTable.tableName
    });
    new cdk.CfnOutput(this, "LogBucketName", {
      value: logBucket.bucketName
    });
    new cdk.CfnOutput(this, "BeamApiUrl", {
      value: api.url
    });
    new cdk.CfnOutput(this, "BeamDashboardServiceUrl", {
      value: `https://${dashboardService.attrServiceUrl}`
    });
  }

  private createPrivateBucket(id: string, bucketNamePrefix: string): s3.Bucket {
    return new s3.Bucket(this, id, {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      bucketName: `${bucketNamePrefix}-${this.account}-${this.region}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      lifecycleRules: [
        {
          id: "abort-incomplete-multipart-uploads",
          abortIncompleteMultipartUploadAfter: Duration.days(7),
          enabled: true
        },
        {
          enabled: true,
          expiration: Duration.days(7),
          id: "expire-temporary-objects",
          prefix: "tmp/"
        },
        {
          enabled: true,
          expiration: Duration.days(14),
          id: "expire-failed-processing-objects",
          prefix: "processing/failed/"
        },
        {
          enabled: true,
          expiration: Duration.days(30),
          id: "expire-obsolete-tagged-objects",
          tagFilters: {
            "beam-retention": "obsolete"
          }
        },
        {
          enabled: true,
          id: "trim-noncurrent-versions",
          noncurrentVersionExpiration: Duration.days(30),
          noncurrentVersionsToRetain: 3
        }
      ],
      metrics: [
        {
          id: "EntireBucket"
        }
      ],
      removalPolicy: RemovalPolicy.RETAIN,
      versioned: true
    });
  }

  private createTable(definition: BeamTableDefinition, namePrefix: string): dynamodb.Table {
    const table = new dynamodb.Table(this, `${definition.id}Table`, {
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      deletionProtection: false,
      partitionKey: {
        name: definition.partitionKey,
        type: dynamodb.AttributeType.STRING
      },
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true
      },
      removalPolicy: RemovalPolicy.RETAIN,
      sortKey: definition.sortKey
        ? {
            name: definition.sortKey,
            type: dynamodb.AttributeType.STRING
          }
        : undefined,
      tableName: `${namePrefix}-${definition.id.toLowerCase()}`
    });

    if (definition.partitionKey !== "accountId") {
      table.addGlobalSecondaryIndex({
        indexName: "byAccount",
        partitionKey: {
          name: "accountId",
          type: dynamodb.AttributeType.STRING
        },
        projectionType: dynamodb.ProjectionType.ALL
      });
    }

    return table;
  }
}

function tableById(tablesById: Record<string, dynamodb.Table>, id: string): dynamodb.Table {
  const table = tablesById[id];
  if (!table) {
    throw new Error(`Missing Beam table definition: ${id}`);
  }

  return table;
}
