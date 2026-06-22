#!/usr/bin/env bash
set -euo pipefail

REGION="${BEAM_AWS_REGION:-us-west-2}"
ENVIRONMENT="${BEAM_ENVIRONMENT:-dev}"
APPLICATION_TAG="${BEAM_APPLICATION_TAG:-Application}"
APP_RUNNER_SERVICE_NAME="${BEAM_APP_RUNNER_SERVICE_NAME:-beam-${ENVIRONMENT}-dashboard}"
LAMBDA_LOG_GROUP="${BEAM_LAMBDA_LOG_GROUP:-/aws/lambda/beam-${ENVIRONMENT}-heartbeat}"
LOG_RETENTION_DAYS="${BEAM_LOG_RETENTION_DAYS:-30}"
ECR_RETAIN_TAGGED_IMAGES="${BEAM_ECR_RETAIN_TAGGED_IMAGES:-10}"
BUDGET_ALERT_EMAIL="${BEAM_BUDGET_ALERT_EMAIL:-donnoel@icloud.com}"
BUDGET_AMOUNT_USD="${BEAM_DAILY_BUDGET_AMOUNT_USD:-1}"

account_id="$(aws sts get-caller-identity --query Account --output text)"
ecr_repository="${BEAM_ECR_REPOSITORY:-cdk-hnb659fds-container-assets-${account_id}-${REGION}}"
unfiltered_budget_name="${BEAM_UNFILTERED_BUDGET_NAME:-beam-${ENVIRONMENT}-account-daily-cost-guardrail}"

budget_file="$(mktemp)"
trap 'rm -f "${budget_file}" "${lifecycle_policy_file:-}"' EXIT
cat >"${budget_file}" <<JSON
{
  "BudgetName": "${unfiltered_budget_name}",
  "BudgetLimit": {
    "Amount": "${BUDGET_AMOUNT_USD}",
    "Unit": "USD"
  },
  "BudgetType": "COST",
  "TimeUnit": "DAILY"
}
JSON

echo "Ensuring unfiltered daily account budget ${unfiltered_budget_name}..."
if aws budgets describe-budget --account-id "${account_id}" --budget-name "${unfiltered_budget_name}" >/dev/null 2>&1; then
  aws budgets update-budget \
    --account-id "${account_id}" \
    --new-budget "file://${budget_file}"
else
  aws budgets create-budget \
    --account-id "${account_id}" \
    --budget "file://${budget_file}"
fi

for threshold in 80 100; do
  existing_notification_count="$(
    aws budgets describe-notifications-for-budget \
      --account-id "${account_id}" \
      --budget-name "${unfiltered_budget_name}" \
      --query "length(Notifications[?Threshold==\`${threshold}.0\` && NotificationType==\`ACTUAL\`])" \
      --output text
  )"
  if [[ "${existing_notification_count}" == "0" ]]; then
    aws budgets create-notification \
      --account-id "${account_id}" \
      --budget-name "${unfiltered_budget_name}" \
      --notification "NotificationType=ACTUAL,ComparisonOperator=GREATER_THAN,Threshold=${threshold},ThresholdType=PERCENTAGE" \
      --subscribers "SubscriptionType=EMAIL,Address=${BUDGET_ALERT_EMAIL}" >/dev/null
  fi
done

echo "Activating Beam cost allocation tags for account ${account_id}..."
aws ce update-cost-allocation-tags-status \
  --cost-allocation-tags-status "[
    {\"TagKey\":\"${APPLICATION_TAG}\",\"Status\":\"Active\"},
    {\"TagKey\":\"Environment\",\"Status\":\"Active\"},
    {\"TagKey\":\"ManagedBy\",\"Status\":\"Active\"}
  ]" >/dev/null

echo "Setting Lambda log retention on ${LAMBDA_LOG_GROUP} to ${LOG_RETENTION_DAYS} day(s)..."
aws logs put-retention-policy \
  --region "${REGION}" \
  --log-group-name "${LAMBDA_LOG_GROUP}" \
  --retention-in-days "${LOG_RETENTION_DAYS}"

echo "Setting App Runner log retention for ${APP_RUNNER_SERVICE_NAME} log groups..."
app_runner_log_groups="$(
  aws logs describe-log-groups \
    --region "${REGION}" \
    --log-group-name-prefix "/aws/apprunner/${APP_RUNNER_SERVICE_NAME}" \
    --query 'logGroups[].logGroupName' \
    --output text
)"
if [[ -z "${app_runner_log_groups}" || "${app_runner_log_groups}" == "None" ]]; then
  echo "No App Runner log groups found for ${APP_RUNNER_SERVICE_NAME}; skipping."
else
  for log_group in ${app_runner_log_groups}; do
    aws logs put-retention-policy \
      --region "${REGION}" \
      --log-group-name "${log_group}" \
      --retention-in-days "${LOG_RETENTION_DAYS}"
    echo "  retained ${log_group}"
  done
fi

echo "Applying ECR lifecycle policy to ${ecr_repository}, retaining ${ECR_RETAIN_TAGGED_IMAGES} tagged images..."
lifecycle_policy_file="$(mktemp)"
cat >"${lifecycle_policy_file}" <<JSON
{
  "rules": [
    {
      "rulePriority": 1,
      "description": "Expire untagged CDK asset images older than 7 days",
      "selection": {
        "tagStatus": "untagged",
        "countType": "sinceImagePushed",
        "countUnit": "days",
        "countNumber": 7
      },
      "action": {
        "type": "expire"
      }
    },
    {
      "rulePriority": 2,
      "description": "Retain the latest ${ECR_RETAIN_TAGGED_IMAGES} tagged CDK asset images for Beam rollback, expire older tagged images",
      "selection": {
        "tagStatus": "tagged",
        "tagPatternList": ["*"],
        "countType": "imageCountMoreThan",
        "countNumber": ${ECR_RETAIN_TAGGED_IMAGES}
      },
      "action": {
        "type": "expire"
      }
    }
  ]
}
JSON
aws ecr put-lifecycle-policy \
  --region "${REGION}" \
  --repository-name "${ecr_repository}" \
  --lifecycle-policy-text "file://${lifecycle_policy_file}" >/dev/null

echo "Live cost guardrails applied."
