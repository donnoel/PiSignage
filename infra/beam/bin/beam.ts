#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { BeamFoundationStack } from "../lib/beam-foundation-stack";

const app = new cdk.App();

const environmentName = app.node.tryGetContext("beam:environment") ?? "dev";
const region = app.node.tryGetContext("beam:region") ?? process.env.CDK_DEFAULT_REGION ?? "us-west-2";

new BeamFoundationStack(app, "BeamDevFoundationStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region
  },
  environmentName
});
