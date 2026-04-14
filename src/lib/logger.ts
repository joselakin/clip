type LogLevel = "debug" | "info" | "warn" | "error";

type LogMeta = Record<string, unknown>;

const LOG_LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function getMinLogLevel(): LogLevel {
  const fromEnv = process.env.LOG_LEVEL?.trim().toLowerCase();
  if (fromEnv === "debug" || fromEnv === "info" || fromEnv === "warn" || fromEnv === "error") {
    return fromEnv;
  }
  return "info";
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_WEIGHT[level] >= LOG_LEVEL_WEIGHT[getMinLogLevel()];
}

function stringifySafely(payload: unknown): string {
  try {
    return JSON.stringify(payload, (_key, value) => {
      if (typeof value === "bigint") {
        return value.toString();
      }
      if (value instanceof Error) {
        return {
          name: value.name,
          message: value.message,
          stack: value.stack,
        };
      }
      return value;
    });
  } catch {
    return JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      scope: "logger",
      message: "failed_to_stringify_log_payload",
    });
  }
}

function writeLog(level: LogLevel, scope: string, message: string, meta?: LogMeta) {
  if (!shouldLog(level)) {
    return;
  }

  const payload = {
    ts: new Date().toISOString(),
    level,
    scope,
    message,
    ...(meta ? { meta } : {}),
  };

  const line = stringifySafely(payload);

  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
}

export function createLogger(scope: string) {
  return {
    debug: (message: string, meta?: LogMeta) => writeLog("debug", scope, message, meta),
    info: (message: string, meta?: LogMeta) => writeLog("info", scope, message, meta),
    warn: (message: string, meta?: LogMeta) => writeLog("warn", scope, message, meta),
    error: (message: string, meta?: LogMeta) => writeLog("error", scope, message, meta),
  };
}
