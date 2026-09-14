// react-hook-form + zod wiring for the admin entity editors: `useZodForm` and
// `fieldAria` here, the five bound field components in lib/form-fields.tsx.
// Schemas come from lib/schemas.generated.ts, the CI-drift-checked mirror of
// controller/src/schemas/**, so this resolver enforces the controller's rules.
//
// PITFALL — a registered field that ISN'T a key of the bound schema is SILENTLY
// DROPPED, not a type error: handleSubmit's callback receives the resolver's
// PARSED OUTPUT and z.object() strips undeclared keys. Two safe patterns:
// (1) every registered field is a real key of the bound schema, or (2) a UI-only
// field is read via form.getValues(name) / useWatch(), which bypass the resolver.
// The dev-only probe below catches violations of (1).


import { zodResolver } from '@hookform/resolvers/zod';
import {
  useForm,
  type DefaultValues,
  type FieldValues,
  type Path,
  type UseFormReturn,
} from 'react-hook-form';
// Value import, not type-only: the phantom-field probe does a runtime
// `instanceof z.ZodObject` check.
import { z } from 'zod';

// All THREE generics on purpose: handleSubmit's callback receives z.output<S>.
// With only z.input<S>, a z.coerce.number() field types as string with no error.
export function useZodForm<S extends z.ZodType<FieldValues, FieldValues>>(
  schema: S,
  defaultValues: DefaultValues<z.input<S>>,
): UseFormReturn<z.input<S>, unknown, z.output<S>> {
  const form = useForm<z.input<S>, unknown, z.output<S>>({
    // Inside this function TS only knows S by its constraint. The assertion is on
    // the SCHEMA so the Resolver type stays derived from @hookform/resolvers.
    resolver: zodResolver(schema as unknown as z.ZodType<z.output<S>, z.input<S>>),
    defaultValues,
    // Validate as the operator types, so a Save button's disabled state tracks validity.
    mode: 'onChange',
  });

  // A plain call, not a hook; NODE_ENV is inlined, so prod strips this as dead code.
  if (process.env.NODE_ENV !== 'production') {
    installPhantomFieldProbe(form, schema, defaultValues);
  }

  return form;
}

// Dev-only phantom-field probe (see the PITFALL above). A lint rule can't do
// this: several bound schemas have no statically visible shape. At mount it
// diffs the outermost ZodObject's `.shape` against defaultValues; at submit it
// wraps `values` in a Proxy that warns on the first read BY NAME, so only a
// literal `values.key` trips it. console.error rather than throw, since the trap
// fires inside arbitrary onValid code.

function resolveTopLevelObjectSchema(schema: z.ZodType, depth = 0): z.ZodObject | null {
  if (depth > 12) return null; // defensive only — nothing here nests this deep
  if (schema instanceof z.ZodObject) return schema;
  // Structural: zod4 carries `innerType` on every optional/nullable/default/readonly wrapper.
  const def = schema.def as unknown as { type: string; innerType?: z.ZodType; out?: z.ZodType };
  if (def.innerType) return resolveTopLevelObjectSchema(def.innerType, depth + 1);
  // `.out` produces the pipe's OUTPUT type. Never fall back to `.in` — the
  // pre-transform shape is not what handleSubmit receives.
  if (def.type === 'pipe' && def.out) return resolveTopLevelObjectSchema(def.out, depth + 1);
  return null;
}

function declaredTopLevelKeys(schema: z.ZodType): Set<string> | null {
  const obj = resolveTopLevelObjectSchema(schema);
  if (!obj) return null;
  // .passthrough()/.catchall(x) let unrecognised keys survive; nothing is dropped.
  const catchall = (obj.def as unknown as { catchall?: z.ZodType }).catchall;
  if (catchall && (catchall.def as unknown as { type?: string }).type !== 'never') return null;
  return new Set(Object.keys(obj.shape));
}

function warnDroppedField(key: string): void {
  console.error(
    `useZodForm: "${key}" is in this form's defaultValues but the bound schema doesn't `
    + `declare it as a key, so z.object() strips it — handleSubmit's callback never receives `
    + `"${key}"; reading values.${key} there is always undefined. This is the bug class `
    + `PlaylistBuilderPanel's saveMode shipped with (see the PITFALL comment atop this file). `
    + `Fix it one of two ways: (1) add "${key}" to the schema's declared shape, or (2) if it's `
    + `deliberately not part of the wire schema, read it via form.getValues('${key}') or `
    + `useWatch({ control, name: '${key}' }) instead of destructuring it off handleSubmit's `
    + 'parsed values.',
  );
}

// Wraps `values` in a Proxy that warns the first time application code reads one
// of `phantomKeys` BY NAME. structuredClone/postMessage/IndexedDB reject a
// Proxy, so spread it into a plain object first.

function wrapWithPhantomFieldWarnings(
  values: unknown,
  phantomKeys: readonly string[],
  warned: Set<string>,
): unknown {
  if (!values || typeof values !== 'object') return values;
  return new Proxy(values as Record<string, unknown>, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && !warned.has(prop) && phantomKeys.includes(prop)) {
        warned.add(prop);
        warnDroppedField(prop);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

// Structural stand-in for react-hook-form's UseFormHandleSubmit, erased to
// `unknown` on both sides of the callback.
type AnyHandleSubmit = (
  onValid?: (values: unknown, event?: unknown) => unknown,
  onInvalid?: (errors: unknown, event?: unknown) => unknown,
) => (event?: unknown) => Promise<unknown>;

const PHANTOM_PROBE_STATE = Symbol('useZodForm.phantomProbeState');

// Keyed on the schema REFERENCE last walked, not a boolean: a bound schema can
// change identity without a remount, and a set-once marker would leave a stale
// wrapper warning behind.

type PhantomProbeState = { schema: z.ZodType; original: AnyHandleSubmit };

// react-hook-form keeps the full UseFormReturn's identity stable, so state
// stashed on it survives re-renders.
function installPhantomFieldProbe(
  form: { handleSubmit: unknown },
  schema: z.ZodType,
  defaultValues: unknown,
): void {
  const marker = form as unknown as Record<symbol, PhantomProbeState | undefined>;
  const state = marker[PHANTOM_PROBE_STATE];

  // Already derived (or proven undecidable) for this schema.
  if (state && state.schema === schema) return;

  // The PRISTINE handleSubmit, reused as the rebuild base on every schema change:
  // wrapping an already-wrapped `form.handleSubmit` would stack Proxies.
  const original = state ? state.original : (form.handleSubmit as unknown as AnyHandleSubmit);
  marker[PHANTOM_PROBE_STATE] = { schema, original };

  const declared = declaredTopLevelKeys(schema);
  const phantomKeys = declared
    ? Object.keys((defaultValues as Record<string, unknown> | undefined) ?? {})
      .filter((key) => !declared.has(key))
    : []; // can't prove anything is dropped — stay silent

  if (phantomKeys.length === 0) {
    // Restore unconditionally so a schema swap un-arms a now-stale wrapper.
    form.handleSubmit = original as unknown as typeof form.handleSubmit;
    return;
  }

  const warned = new Set<string>();
  const wrapped: AnyHandleSubmit = (onValid, onInvalid) =>
    original(
      onValid
        ? (values: unknown, event?: unknown) =>
          onValid(wrapWithPhantomFieldWarnings(values, phantomKeys, warned), event)
        : onValid,
      onInvalid,
    );
  form.handleSubmit = wrapped as unknown as typeof form.handleSubmit;
}

// ARIA wiring for one field, derived from a single base id. The Field primitives
// in components/ui/field.tsx are presentational and never associate the message
// with the control, so a user tabbing BACK to a bad input gets nothing.
export function fieldAria(
  baseId: string,
  error?: { message?: string },
  opts?: { hasDescription?: boolean },
) {
  const errorId = `${baseId}-error`;
  const descriptionId = `${baseId}-description`;
  const invalid = !!error;
  // Reference only ids that are actually in the DOM: FieldError renders null when
  // there is no error, and a dangling aria-describedby is handled inconsistently.
  const describedBy =
    [opts?.hasDescription ? descriptionId : null, invalid ? errorId : null]
      .filter(Boolean)
      .join(' ') || undefined;
  return {
    invalid,
    // For a Field wrapping a real control: label points at it, control owns the id.
    labelProps: { htmlFor: baseId },
    controlProps: {
      id: baseId,
      // Absent rather than aria-invalid="false" — the attribute only means anything when set.
      'aria-invalid': invalid || undefined,
      'aria-describedby': describedBy,
    },
    // For a Field wrapping a GROUP of controls (chips, checkboxes): htmlFor would
    // point at a <div>, which is invalid, so the group names itself via aria-labelledby.
    labelledByProps: { id: `${baseId}-label` },
    groupProps: {
      'aria-labelledby': `${baseId}-label`,
      'aria-invalid': invalid || undefined,
      'aria-describedby': describedBy,
    },
    descriptionProps: { id: descriptionId },
    errorProps: { id: errorId },
  } as const;
}

// Maps the controller's `fieldErrors` payload back onto individual inputs: its dotted
// paths ('webhooks.1.url') are already react-hook-form's setError syntax. Generic over
// all three UseFormReturn parameters so a useZodForm-built form needs no restating.
export function applyServerFieldErrors<
  TFieldValues extends FieldValues,
  TContext,
  TTransformedValues,
>(
  form: UseFormReturn<TFieldValues, TContext, TTransformedValues>,
  fieldErrors: Record<string, string> | undefined,
): boolean {
  if (!fieldErrors) return false;
  const entries = Object.entries(fieldErrors);
  for (const [path, message] of entries) {
    form.setError(path as Path<TFieldValues>, { type: 'server', message });
  }
  return entries.length > 0;
}
