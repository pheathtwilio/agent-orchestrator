const startedAt = Date.now();

export interface HealthResponse {
  status: "ok";
  uptime: number;
  version: string;
  timestamp: string;
}

/**
 * Returns health data including process uptime (in seconds) and package version.
 * `startedAt` is captured at module load time, so uptime reflects how long the
 * server process has been running.
 */
export function getHealthResponse(): HealthResponse {
  return {
    status: "ok",
    uptime: Math.floor((Date.now() - startedAt) / 1000),
    version: process.env.npm_package_version ?? "0.1.0",
    timestamp: new Date().toISOString(),
  };
}
