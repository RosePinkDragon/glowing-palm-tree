/** Sequential tests exercise both shell states and restore the caller's values even on failure. */
export async function withSupabaseTestEnvironment(mode: 'unset' | 'configured', run: () => Promise<void>): Promise<void> {
  const values = {
    EXPO_PUBLIC_SUPABASE_URL: 'https://shell-environment.invalid',
    EXPO_PUBLIC_SUPABASE_ANON_KEY: 'sb_publishable_environment',
  };
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (mode === 'configured') process.env[key] = value;
      else delete process.env[key];
    }
    await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
