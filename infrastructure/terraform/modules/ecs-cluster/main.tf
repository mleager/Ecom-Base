# ECS cluster on an EC2 capacity provider (mirrors tf-ecs): ECS-optimized
# Amazon Linux 2023 AMI from SSM, a launch template, an Auto Scaling group in
# the private subnets and capacity-provider managed scaling. Instances are
# reached only through SSM Session Manager; there is no SSH key or ingress.
#
# awsvpc tasks each take one ENI. A t3.small has 3 ENIs (1 for the host), so
# 2 tasks per instance: 2 API tasks + Mailpit need 2 instances, and a rolling
# deploy (200% maximum) scales out to a third.

data "aws_ssm_parameter" "ecs_node_ami" {
  name = "/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended/image_id"
}

resource "aws_ecs_cluster" "this" {
  name = var.name

  # Container Insights costs extra; off for development.
  setting {
    name  = "containerInsights"
    value = "disabled"
  }
}

# --- Instance role: ECS agent + SSM Session Manager --------------------------

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "node" {
  name               = "${var.name}-ecs-node"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "node_ecs" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role"
}

resource "aws_iam_role_policy_attachment" "node_ssm" {
  role       = aws_iam_role.node.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "node" {
  name = "${var.name}-ecs-node"
  role = aws_iam_role.node.name
}

# --- Instance security group: no ingress -------------------------------------

resource "aws_security_group" "node" {
  name        = "${var.name}-ecs-node"
  description = "ECS container instances: no ingress; SSM and ECS agent egress"
  vpc_id      = var.vpc_id

  tags = {
    Name = "${var.name}-ecs-node"
  }
}

resource "aws_vpc_security_group_egress_rule" "node_all" {
  security_group_id = aws_security_group.node.id
  description       = "ECS agent, SSM, ECR and port-forwarding targets"
  ip_protocol       = "-1"
  cidr_ipv4         = "0.0.0.0/0"
}

# --- Launch template and Auto Scaling group ----------------------------------

resource "aws_launch_template" "node" {
  name_prefix   = "${var.name}-ecs-"
  image_id      = data.aws_ssm_parameter.ecs_node_ami.value
  instance_type = var.instance_type

  vpc_security_group_ids = [aws_security_group.node.id]

  iam_instance_profile {
    arn = aws_iam_instance_profile.node.arn
  }

  # IMDSv2 only; awsvpc tasks are also blocked from IMDS by the agent.
  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  block_device_mappings {
    device_name = "/dev/xvda"

    ebs {
      volume_size           = 30
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }

  user_data = base64encode(<<-EOF
    #!/bin/bash
    cat >>/etc/ecs/ecs.config <<'CONFIG'
    ECS_CLUSTER=${var.name}
    ECS_AWSVPC_BLOCK_IMDS=true
    ECS_ENABLE_CONTAINER_METADATA=true
    CONFIG
  EOF
  )

  tag_specifications {
    resource_type = "instance"

    tags = {
      Name = "${var.name}-ecs-node"
    }
  }
}

resource "aws_autoscaling_group" "node" {
  name                = "${var.name}-ecs"
  min_size            = var.min_size
  max_size            = var.max_size
  desired_capacity    = var.min_size
  vpc_zone_identifier = var.private_subnet_ids
  force_delete        = true

  launch_template {
    id      = aws_launch_template.node.id
    version = aws_launch_template.node.latest_version
  }

  tag {
    key                 = "AmazonECSManaged"
    value               = true
    propagate_at_launch = true
  }

  # Managed scaling owns the desired count after creation.
  lifecycle {
    ignore_changes = [desired_capacity]
  }

  # The ECS agent needs its permissions and egress for as long as instances
  # run: on create to register, on destroy to report stopped tasks. Nothing
  # else references these, so without this destroy removes them first and
  # service deletion hangs in DRAINING.
  depends_on = [
    aws_iam_role_policy_attachment.node_ecs,
    aws_iam_role_policy_attachment.node_ssm,
    aws_vpc_security_group_egress_rule.node_all,
  ]
}

resource "aws_ecs_capacity_provider" "this" {
  name = "${var.name}-ec2"

  auto_scaling_group_provider {
    auto_scaling_group_arn         = aws_autoscaling_group.node.arn
    managed_termination_protection = "DISABLED"

    managed_scaling {
      status                    = "ENABLED"
      target_capacity           = 100
      minimum_scaling_step_size = 1
      maximum_scaling_step_size = 1
    }
  }
}

resource "aws_ecs_cluster_capacity_providers" "this" {
  cluster_name       = aws_ecs_cluster.this.name
  capacity_providers = [aws_ecs_capacity_provider.this.name]

  default_capacity_provider_strategy {
    capacity_provider = aws_ecs_capacity_provider.this.name
    base              = 1
    weight            = 100
  }
}
