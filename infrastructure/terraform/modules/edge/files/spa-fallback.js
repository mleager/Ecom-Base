// CloudFront Function (viewer request) on the default S3 behavior only.
// Rewrites extensionless page paths (/, /orders/123, /account) to /index.html
// so deep links load the SPA. Paths with a file extension (/assets/x.js,
// /fixtures/v1/mug.svg) go to S3 unchanged. /api/* never reaches this
// function, so API 404s stay JSON: no distribution-wide custom error responses.
function handler(event) {
  var request = event.request;
  var uri = request.uri;
  var lastSegment = uri.substring(uri.lastIndexOf('/') + 1);

  if (lastSegment.indexOf('.') === -1) {
    request.uri = '/index.html';
  }

  return request;
}
