# ECR repository and the release image, built from this repository by the
# docker provider and pushed by digest. Tasks run "<repo>@sha256:..." so a
# tag can never change what runs.

resource "aws_ecr_repository" "app" {
  name                 = var.name
  image_tag_mutability = "MUTABLE"
  force_delete         = true # development: destroy removes pushed images

  image_scanning_configuration {
    scan_on_push = true
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 10 images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 10
      }
      action = { type = "expire" }
    }]
  })
}

locals {
  # Everything the Dockerfile copies (see .dockerignore). A change to any of
  # these files gives a new tag, a rebuild and a new digest.
  source_files = sort(tolist(setunion(
    fileset(var.source_dir, "backend/**/*.{go,sql,json}"),
    fileset(var.source_dir, "frontend/src/**"),
    fileset(var.source_dir, "frontend/public/**"),
    fileset(var.source_dir, "frontend/{package.json,package-lock.json,.npmrc,index.html,vite.config.ts,tsconfig.json,components.json}"),
    fileset(var.source_dir, "fixtures/public/**"),
    fileset(var.source_dir, "{Dockerfile,.dockerignore,go.mod,go.sum}"),
  )))
  source_hash = sha1(join("", [for f in local.source_files : filesha1("${var.source_dir}/${f}")]))
  image_tag   = "${var.app_version}-${substr(local.source_hash, 0, 12)}"
}

resource "docker_image" "app" {
  name         = "${aws_ecr_repository.app.repository_url}:${local.image_tag}"
  keep_locally = true

  build {
    context    = var.source_dir
    dockerfile = "Dockerfile"
    platform   = "linux/amd64"
    build_args = {
      VERSION  = var.app_version
      REVISION = local.source_hash
    }
  }

  triggers = {
    source_hash = local.source_hash
  }
}

resource "docker_registry_image" "app" {
  name          = docker_image.app.name
  keep_remotely = true

  triggers = {
    image_id = docker_image.app.image_id
  }
}

locals {
  image = "${aws_ecr_repository.app.repository_url}@${docker_registry_image.app.sha256_digest}"
}
