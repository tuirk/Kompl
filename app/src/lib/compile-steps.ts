export const COMPILE_STEPS = [
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
