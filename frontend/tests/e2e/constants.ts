export const testApiPort = 18080;
export const testApiBaseUrl = `http://localhost:${testApiPort}/api/v1`;

// HTTPS browser group (playwright.https.config.ts): the API serves the built
// SPA and the API from one TLS origin, like `dev.sh serve-https`.
export const testHttpsPort = 18443;
export const testHttpsOrigin = `https://localhost:${testHttpsPort}`;
export const testHttpsApiBaseUrl = `${testHttpsOrigin}/api/v1`;
