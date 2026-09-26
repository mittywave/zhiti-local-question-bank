/** Mutate the Cloudflare config once. Returning override arrays would concatenate
 * them with wrangler.jsonc (defu), duplicating binding names in built Workers. */
export function ensureLocalBindings(config, hosting = {}) {
  config.compatibility_flags = [...new Set([...(config.compatibility_flags ?? []), 'nodejs_compat'])];
  config.d1_databases ??= [];
  config.r2_buckets ??= [];
  const d1 = hosting.d1 || 'DB', r2 = hosting.r2 || 'HOMEWORK_ASSETS';
  if (!config.d1_databases.some(item => item.binding === d1)) {
    config.d1_databases.push({binding:d1,
      database_name:hosting.d1 ? 'site-creator-d1' : 'zhiti-question-bank',
      database_id:hosting.d1 ? '00000000-0000-4000-8000-000000000000' : '8d93b3dc-001f-4f32-adba-4bb5dc971c17'});
  }
  if (!config.r2_buckets.some(item => item.binding === r2)) {
    config.r2_buckets.push({binding:r2,bucket_name:hosting.r2 ? 'site-creator-r2' : 'zhiti-homework-assets'});
  }
}
