// Each Playwright worker owns one Vite server and one API port, both offset by
// the worker's parallel index, so workers never share a browser origin or API.
export const baseApiPort = 18080;
export const baseVitePort = 5173;
export const maxWorkers = 16;

// Playwright sets TEST_PARALLEL_INDEX in every worker process before it loads
// test files, so specs can use these at module scope. The harness checks it
// against workerInfo.parallelIndex. Outside a worker (the config process) it is 0.
function parallelIndex(): number {
  const raw = process.env.TEST_PARALLEL_INDEX;
  if (raw === undefined) return 0;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value >= maxWorkers) throw new Error('Browser harness worker index is invalid.');
  return value;
}

export const workerIndex = parallelIndex();
export const testApiPort = baseApiPort + workerIndex;
export const testApiBaseUrl = `http://localhost:${testApiPort}/api/v1`;
export const testVitePort = baseVitePort + workerIndex;
/** This worker's Vite origin: the browser origin the API accepts (CSRF Origin, CORS, email links). */
export const testOrigin = `http://localhost:${testVitePort}`;

// HTTPS browser group (playwright.https.config.ts): the API serves the built
// SPA and the API from one TLS origin, like `dev.sh serve-https`. One worker.
export const testHttpsPort = 18443;
export const testHttpsOrigin = `https://localhost:${testHttpsPort}`;
export const testHttpsApiBaseUrl = `${testHttpsOrigin}/api/v1`;
