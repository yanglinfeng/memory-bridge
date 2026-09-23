export const CLIENT_IDENTITY_ID_PATTERN =
  /^[A-Za-z0-9_-][A-Za-z0-9._:-]{0,127}$/u;

/**
 * Validates stable client identity components shared by headers, persisted
 * session bindings, and schema backfills.
 */
export function isClientIdentityId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    CLIENT_IDENTITY_ID_PATTERN.test(value)
  );
}
