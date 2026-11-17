output "vpc_id" {
  value = aws_vpc.this.id
}

output "vpc_cidr" {
  value = aws_vpc.this.cidr_block
}

output "public_subnet_ids" {
  value = aws_subnet.public[*].id
  # Consumers with public addresses then depend on the internet gateway, so
  # destroy removes them before detaching the gateway.
  depends_on = [aws_internet_gateway.this, aws_route_table_association.public]
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
  # Consumers (ECS instances and tasks, RDS, the internal ALB) then depend on
  # the NAT route (and, through the NAT gateway, the public route), so destroy
  # removes them first. Without a route out, the ECS agent cannot
  # report stopped tasks, their ENIs stay attached and service deletion hangs.
  depends_on = [aws_route_table_association.private, aws_nat_gateway.this]
}

output "nat_public_ip" {
  value = aws_eip.nat.public_ip
}
