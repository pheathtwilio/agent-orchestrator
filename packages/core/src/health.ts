export interface HealthCheckResponse {
  status: "ok";
  timestamp: string;
  version: string;
}

/**
 * Returns a health check response with the current system status.
 *
 * @returns An object containing the health status, current timestamp, and version
 */
export function getHealthCheck(): HealthCheckResponse {
  return {
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "0.1.0",
  };
}
