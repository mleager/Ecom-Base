#!/usr/bin/env bash
# Run a one-off ECS task, wait for it to stop and fail unless every container
# exited 0. Terraform runs it for db-bootstrap and migrate (terraform_data in
# jobs.tf); people run it for reconcile (README, "Run a one-off task"). A CI
# pipeline can run the same script between pushing an image and updating the
# service.
#
#   run-task.sh <task-definition> [<container> <command> [<arg>...]]
#
# With a container and command, that container's command is overridden, for
# example: run-task.sh ecom-development-api api reconcile --dry-run
#
# Environment (terraform output -raw one_off_task_env prints these):
#   AWS_REGION, CLUSTER, SUBNETS (comma-separated), SECURITY_GROUPS
#   (comma-separated), CAPACITY_PROVIDER, LOG_GROUP
#   STARTED_BY       defaults to run-task.sh
#   TIMEOUT_SECONDS  defaults to 1200; the task is stopped after that
set -euo pipefail

fail() { printf 'run-task: %s\n' "$*" >&2; exit 1; }

[[ $# -ge 1 && $# -ne 2 ]] || fail 'usage: run-task.sh <task-definition> [<container> <command> [<arg>...]]'
task_definition=$1
shift

for setting in AWS_REGION CLUSTER SUBNETS SECURITY_GROUPS CAPACITY_PROVIDER LOG_GROUP; do
  [[ -n ${!setting:-} ]] || fail "$setting is required"
done
command -v aws >/dev/null || fail 'the AWS CLI is required'
command -v python3 >/dev/null || fail 'python3 is required'
started_by=${STARTED_BY:-run-task.sh}
timeout_seconds=${TIMEOUT_SECONDS:-1200}

overrides='{}'
if [[ $# -ge 2 ]]; then
  overrides=$(python3 -c 'import json, sys; print(json.dumps({"containerOverrides": [{"name": sys.argv[1], "command": sys.argv[2:]}]}))' "$@")
fi
network=$(python3 -c 'import json, sys; print(json.dumps({"awsvpcConfiguration": {"subnets": sys.argv[1].split(","), "securityGroups": sys.argv[2].split(","), "assignPublicIp": "DISABLED"}}))' "$SUBNETS" "$SECURITY_GROUPS")

# A new execution role takes a few seconds to propagate in IAM; until then
# ECS answers "unable to assume the role". Retry that, and only that.
for attempt in $(seq 1 12); do
  if result=$(aws ecs run-task --region "$AWS_REGION" --cluster "$CLUSTER" \
    --task-definition "$task_definition" \
    --capacity-provider-strategy "capacityProvider=$CAPACITY_PROVIDER,weight=1,base=0" \
    --network-configuration "$network" --overrides "$overrides" \
    --started-by "$started_by" --output json 2>&1); then
    break
  fi
  if [[ $result == *'unable to assume the role'* && $attempt -lt 12 ]]; then
    printf 'run-task: execution role not usable yet (attempt %d of 12); retrying in 10s\n' "$attempt"
    sleep 10
    continue
  fi
  printf '%s\n' "$result" >&2
  fail "could not start $task_definition"
done
task_arn=$(python3 -c 'import json, sys; d = json.load(sys.stdin); t = d.get("tasks") or []; print(t[0]["taskArn"] if t else "")' <<<"$result")
if [[ -z $task_arn ]]; then
  printf '%s\n' "$result" >&2
  fail "ECS did not start $task_definition"
fi
task_id=${task_arn##*/}
printf 'run-task: started %s (%s)\n' "$task_definition" "$task_id"

# A task waiting for capacity stays PROVISIONING while the Auto Scaling group
# adds an instance, so the wait is longer than the CLI's 10-minute waiter.
deadline=$((SECONDS + timeout_seconds))
status=
while :; do
  status=$(aws ecs describe-tasks --region "$AWS_REGION" --cluster "$CLUSTER" --tasks "$task_arn" \
    --query 'tasks[0].lastStatus' --output text)
  [[ $status == STOPPED ]] && break
  if (( SECONDS >= deadline )); then
    aws ecs stop-task --region "$AWS_REGION" --cluster "$CLUSTER" --task "$task_arn" \
      --reason "run-task.sh timeout after ${timeout_seconds}s" >/dev/null || true
    fail "$task_definition did not finish within ${timeout_seconds}s (last status $status); stopped it"
  fi
  sleep 10
done

details=$(aws ecs describe-tasks --region "$AWS_REGION" --cluster "$CLUSTER" --tasks "$task_arn" --output json)
summary=$(python3 - "$details" <<'PY'
import json, sys
task = json.loads(sys.argv[1])["tasks"][0]
ok = True
for c in task["containers"]:
    code = c.get("exitCode")
    print(f"  {c['name']}: exit {code if code is not None else 'none'}" + (f" ({c['reason']})" if c.get("reason") else ""))
    if code != 0:
        ok = False
print(f"  stopped: {task.get('stoppedReason', 'unknown')}")
print("OK" if ok else "FAILED")
PY
)
printf '%s\n' "${summary%$'\n'*}"

# Container output: awslogs names each stream "<prefix>/<container>/<task id>",
# with the prefix from the container's log options. The commands print JSON
# lines and never their credentials.
definition=$(aws ecs describe-task-definition --region "$AWS_REGION" \
  --task-definition "$(python3 -c 'import json, sys; print(json.loads(sys.argv[1])["tasks"][0]["taskDefinitionArn"])' "$details")" \
  --query 'taskDefinition.containerDefinitions' --output json)
streams=$(python3 - "$definition" "$task_id" <<'PY'
import json, sys
for c in json.loads(sys.argv[1]):
    options = (c.get("logConfiguration") or {}).get("options") or {}
    if options.get("awslogs-stream-prefix"):
        print(f"{options['awslogs-stream-prefix']}/{c['name']}/{sys.argv[2]}")
PY
)
for stream in $streams; do
  printf -- '--- %s (last 40 lines)\n' "$stream"
  aws logs get-log-events --region "$AWS_REGION" --log-group-name "$LOG_GROUP" --log-stream-name "$stream" \
    --limit 40 --query 'events[].message' --output text 2>/dev/null | tr '\t' '\n' || true
done

[[ ${summary##*$'\n'} == OK ]] || fail "$task_definition failed"
printf 'run-task: %s succeeded\n' "$task_definition"
