/** Redact common labeled secret values before retaining or returning child output. */
export function redactPotentialSecrets(value: string): string {
  return value
    .replace(/(api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .slice(-8_000);
}

export const SENSITIVE_FIELD_NAME = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|secret|cookie)/i;
