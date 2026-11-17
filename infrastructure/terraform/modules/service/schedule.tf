# Scheduled jobs (M17 task 10, review M3). EventBridge Scheduler starts one
# ECS task every 5 minutes (job_schedule). The task runs two containers in
# order:
#
#   reconcile  reconcile --apply, as ecom_app: settles orders stranded in
#              pending_payment after their reservation deadline (OPERATIONS.md)
#   maintain   maintain guests, as ecom_migrator: removes expired guest data
#              (task 8); it starts when reconcile has stopped, whatever its
#              exit code, so a failed recovery doesn't hold up the cleanup
#
# Both are safe to overlap with a previous run (row locks with SKIP LOCKED),
# and both stop within about 2 minutes.
#
# A task that stops with any non-zero container exit code, or fails to start,
# publishes its ECS event to the SNS topic below. alert_email subscribes an
# address. A RunTask call the scheduler cannot make at all (for example a
# permissions error) raises the TargetErrorCount alarm on the same topic.

resource "aws_ecs_task_definition" "scheduled" {
  family                   = "${var.name}-scheduled-jobs"
  network_mode             = "awsvpc"
  requires_compatibilities = ["EC2"]
  cpu                      = 128
  memory                   = 256
  execution_role_arn       = aws_iam_role.execution["scheduled"].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }

  container_definitions = jsonencode([
    {
      name              = "reconcile"
      image             = local.image
      essential         = false
      memoryReservation = 64
      command           = ["reconcile", "--apply", "--limit", "100"]
      environment       = [{ name = "APP_ENV", value = "production" }]
      secrets           = [{ name = "DATABASE_URL", valueFrom = local.role_secret.app.DATABASE_URL }]
      logConfiguration = {
        logDriver = "awslogs"
        options   = local.scheduled_log_options
      }
    },
    {
      name              = "maintain"
      image             = local.image
      essential         = true
      memoryReservation = 64
      command           = ["maintain", "guests"]
      environment       = [{ name = "APP_ENV", value = "production" }]
      secrets           = [{ name = "DATABASE_URL", valueFrom = local.role_secret.migrator.DATABASE_URL }]
      dependsOn         = [{ containerName = "reconcile", condition = "COMPLETE" }]
      logConfiguration = {
        logDriver = "awslogs"
        options   = local.scheduled_log_options
      }
    },
  ])
}

locals {
  scheduled_log_options = merge(local.log_options, { "awslogs-stream-prefix" = "scheduled" })
}

resource "aws_scheduler_schedule_group" "jobs" {
  name = "${var.name}-jobs"
}

data "aws_iam_policy_document" "scheduler_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["scheduler.amazonaws.com"]
    }
  }
}

# The scheduler may start only this task family, only on this cluster, and
# pass only its execution role.
data "aws_iam_policy_document" "scheduler_run_task" {
  statement {
    actions   = ["ecs:RunTask"]
    resources = ["${aws_ecs_task_definition.scheduled.arn_without_revision}:*"]

    condition {
      test     = "ArnEquals"
      variable = "ecs:cluster"
      values   = [var.cluster_id]
    }
  }

  statement {
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.execution["scheduled"].arn]

    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "scheduler" {
  name               = "${var.name}-scheduler"
  assume_role_policy = data.aws_iam_policy_document.scheduler_assume.json
}

resource "aws_iam_role_policy" "scheduler_run_task" {
  name   = "run-scheduled-jobs"
  role   = aws_iam_role.scheduler.id
  policy = data.aws_iam_policy_document.scheduler_run_task.json
}

resource "aws_scheduler_schedule" "jobs" {
  name        = "${var.name}-reconcile-maintain"
  group_name  = aws_scheduler_schedule_group.jobs.name
  description = "reconcile --apply, then maintain guests (M17 task 10)"
  state       = var.schedule_jobs ? "ENABLED" : "DISABLED"

  schedule_expression = var.job_schedule

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = var.cluster_id
    role_arn = aws_iam_role.scheduler.arn

    ecs_parameters {
      task_definition_arn = aws_ecs_task_definition.scheduled.arn
      task_count          = 1
      group               = "family:${aws_ecs_task_definition.scheduled.family}"

      capacity_provider_strategy {
        capacity_provider = var.capacity_provider_name
        weight            = 1
      }

      network_configuration {
        subnets          = var.private_subnet_ids
        security_groups  = [aws_security_group.jobs.id]
        assign_public_ip = false
      }
    }

    # The next run is at most 5 minutes away; don't stack retries on it.
    retry_policy {
      maximum_retry_attempts = 0
    }
  }

  depends_on = [
    aws_iam_role_policy.execution_secrets,
    aws_iam_role_policy_attachment.execution,
    aws_iam_role_policy.scheduler_run_task,
  ]
}

# Alerts. AWS-managed SNS encryption would stop EventBridge from publishing,
# so the topic is unencrypted; messages carry task ARNs and exit codes only.
resource "aws_sns_topic" "job_alerts" {
  name = "${var.name}-job-alerts"
}

resource "aws_sns_topic_subscription" "job_alerts_email" {
  count = var.alert_email == null ? 0 : 1

  topic_arn = aws_sns_topic.job_alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_cloudwatch_event_rule" "job_failed" {
  name        = "${var.name}-scheduled-job-failed"
  description = "A scheduled-jobs task stopped with a non-zero exit code or failed to start"

  event_pattern = jsonencode({
    source        = ["aws.ecs"]
    "detail-type" = ["ECS Task State Change"]
    detail = {
      clusterArn = [var.cluster_id]
      group      = ["family:${aws_ecs_task_definition.scheduled.family}"]
      lastStatus = ["STOPPED"]
      "$or" = [
        { containers = { exitCode = [{ "anything-but" = 0 }] } },
        { stopCode = ["TaskFailedToStart"] },
      ]
    }
  })
}

resource "aws_cloudwatch_event_target" "job_failed" {
  rule = aws_cloudwatch_event_rule.job_failed.name
  arn  = aws_sns_topic.job_alerts.arn
}

resource "aws_cloudwatch_metric_alarm" "scheduler_errors" {
  alarm_name          = "${var.name}-scheduler-target-errors"
  alarm_description   = "EventBridge Scheduler could not start the scheduled-jobs task"
  namespace           = "AWS/Scheduler"
  metric_name         = "TargetErrorCount"
  dimensions          = { ScheduleGroup = aws_scheduler_schedule_group.jobs.name }
  statistic           = "Sum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.job_alerts.arn]
}

data "aws_iam_policy_document" "job_alerts" {
  statement {
    sid       = "EventBridgeJobFailures"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.job_alerts.arn]

    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_event_rule.job_failed.arn]
    }
  }

  statement {
    sid       = "CloudWatchSchedulerAlarm"
    actions   = ["sns:Publish"]
    resources = [aws_sns_topic.job_alerts.arn]

    principals {
      type        = "Service"
      identifiers = ["cloudwatch.amazonaws.com"]
    }

    condition {
      test     = "ArnEquals"
      variable = "aws:SourceArn"
      values   = [aws_cloudwatch_metric_alarm.scheduler_errors.arn]
    }
  }
}

resource "aws_sns_topic_policy" "job_alerts" {
  arn    = aws_sns_topic.job_alerts.arn
  policy = data.aws_iam_policy_document.job_alerts.json
}
