#!/usr/bin/env bash
# Publishes the SPA from the release image to the private S3 bucket, in the
# order MILESTONE_17.md requires, then invalidates /index.html.
#
# Inputs (environment): IMAGE (local image name), BUCKET, DISTRIBUTION_ID,
# AWS_REGION. Needs docker and the AWS CLI with the same credentials as
# Terraform.
#
#   1. assets/*       public, max-age=31536000, immutable  (never deleted: the
#                     previous release's files stay for tabs already open)
#   2. fixtures/v1/*  public, max-age=3600
#   3. other files    no-cache
#   4. index.html     no-cache, uploaded LAST
#   5. invalidate /index.html
set -euo pipefail

: "${IMAGE:?}" "${BUCKET:?}" "${DISTRIBUTION_ID:?}" "${AWS_REGION:?}"
export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"

work=$(mktemp -d)
container=
cleanup() {
  if [[ -n $container ]]; then docker rm -f "$container" >/dev/null 2>&1 || true; fi
  rm -rf "$work"
}
trap cleanup EXIT

container=$(docker create "$IMAGE")
docker cp "$container:/app/dist" "$work/dist"
dist=$work/dist
[[ -f $dist/index.html && -d $dist/assets ]] || {
  echo "publish-spa: $IMAGE has no /app/dist/index.html or assets/" >&2
  exit 1
}

s3="s3://$BUCKET"

# Hashed names: an existing key never changes, so sync (no --delete) is enough.
aws s3 sync "$dist/assets" "$s3/assets" \
  --cache-control 'public, max-age=31536000, immutable' --only-show-errors

# cp, not sync: extracted files keep the image's old mtimes, so sync could
# skip a changed file of the same size.
if [[ -d $dist/fixtures/v1 ]]; then
  aws s3 cp "$dist/fixtures/v1" "$s3/fixtures/v1" --recursive \
    --cache-control 'public, max-age=3600' --only-show-errors
fi

aws s3 cp "$dist" "$s3" --recursive \
  --exclude 'assets/*' --exclude 'fixtures/v1/*' --exclude 'index.html' \
  --cache-control 'no-cache' --only-show-errors

aws s3 cp "$dist/index.html" "$s3/index.html" \
  --cache-control 'no-cache' --content-type 'text/html; charset=utf-8' --only-show-errors

invalidation=$(aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" \
  --paths '/index.html' --query 'Invalidation.Id' --output text)
echo "publish-spa: uploaded to $s3; invalidation $invalidation for /index.html"
