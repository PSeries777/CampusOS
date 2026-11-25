export const documentDefaults = Object.freeze({
  documentUploadConcurrency: 2,
  documentUploadTimeoutMs: 120_000,
  documentArchiveMaxEntries: 1_000,
});

function integerSetting(env, name, fallback, maximum) {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

export function readDocumentConfig(env) {
  return {
    documentUploadConcurrency: integerSetting(env, 'DOCUMENT_UPLOAD_CONCURRENCY', documentDefaults.documentUploadConcurrency, 16),
    documentUploadTimeoutMs: integerSetting(env, 'DOCUMENT_UPLOAD_TIMEOUT_MS', documentDefaults.documentUploadTimeoutMs, 900_000),
    documentArchiveMaxEntries: integerSetting(env, 'DOCUMENT_ARCHIVE_MAX_ENTRIES', documentDefaults.documentArchiveMaxEntries, 10_000),
  };
}
