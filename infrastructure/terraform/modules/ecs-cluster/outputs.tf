output "cluster_id" {
  value = aws_ecs_cluster.this.id
}

output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

# Services depend on the cluster/capacity-provider association, so destroy
# removes services before the capacity provider.
output "capacity_provider_name" {
  value      = aws_ecs_capacity_provider.this.name
  depends_on = [aws_ecs_cluster_capacity_providers.this]
}

output "node_security_group_id" {
  description = "Security group of the container instances (source of SSM port forwarding)"
  value       = aws_security_group.node.id
}

output "autoscaling_group_name" {
  value = aws_autoscaling_group.node.name
}
