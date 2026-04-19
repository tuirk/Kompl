export const COMPILE_STEPS = [
  // Prelude — v18 onboarding v2 ingest pipeline. Only runs when the
  // session has collect_staging rows (see /api/compile/run gate). For
  // legacy /confirm sessions + source recompiles, these are marked
  // done-but-skipped so resetForRetry doesn't treat them as "first
  // non-done" and wipe already-done compile steps.
  { key: 'health_check',  label: 'Checking services'       },
  { key: 'ingest_files',  label: 'Converting files'        },
  { key: 'ingest_urls',   label: 'Fetching URLs'           },
  { key: 'ingest_texts',  label: 'Saving notes & tweets'   },
  // Existing compile pipeline — untouched.
  { key: 'extract',  label: 'Extracting knowledge'      },
  { key: 'resolve',  label: 'Resolving entities'        },
  { key: 'match',    label: 'Checking existing wiki'    },
  { key: 'plan',     label: 'Planning wiki structure'   },
  { key: 'draft',    label: 'Writing pages'             },
  { key: 'crossref', label: 'Cross-referencing'         },
  { key: 'commit',   label: 'Finalizing'                },
  { key: 'schema',   label: 'Setting up wiki structure' },
] as const;

export type CompileStepKey = (typeof COMPILE_STEPS)[number]['key'];

export const COMPILE_STEP_KEYS: readonly CompileStepKey[] =
  COMPILE_STEPS.map((s) => s.key);

export const COMPILE_STEP_LABELS: Record<CompileStepKey, string> =
  Object.fromEntries(COMPILE_STEPS.map((s) => [s.key, s.label])) as Record<
    CompileStepKey,
    string
  >;
