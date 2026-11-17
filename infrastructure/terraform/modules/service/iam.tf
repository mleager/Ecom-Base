data "aws_iam_policy_document" "ecs_tasks_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

# One execution role per task definition. The ECS agent uses it to pull from
# ECR, write logs and resolve the "secrets" entries; each can read only the
# secrets its own task needs. The containers themselves get no AWS role.
locals {
  execution_secret_arns = {
    api       = [aws_secretsmanager_secret.service["api"].arn, var.database.role_secrets.app.arn]
    mail      = [aws_secretsmanager_secret.service["mail"].arn]
    migrate   = [var.database.role_secrets.migrator.arn]
    bootstrap = [var.database.master_secret_arn, var.database.role_secrets.migrator.arn, var.database.role_secrets.app.arn]
  }
}

resource "aws_iam_role" "execution" {
  for_each = local.execution_secret_arns

  name               = "${var.name}-${each.key}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_tasks_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  for_each = local.execution_secret_arns

  role       = aws_iam_role.execution[each.key].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

data "aws_iam_policy_document" "execution_secrets" {
  for_each = local.execution_secret_arns

  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = each.value
  }
}

resource "aws_iam_role_policy" "execution_secrets" {
  for_each = local.execution_secret_arns

  name   = "read-${each.key}-secrets"
  role   = aws_iam_role.execution[each.key].id
  policy = data.aws_iam_policy_document.execution_secrets[each.key].json
}
