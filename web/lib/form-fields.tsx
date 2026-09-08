'use client';

// Bound field components: the react-hook-form half of lib/form.ts.
// Each takes `control` + `name`, subscribes with useController, and renders the
// whole Field composition with the ARIA already wired through fieldAria.
// Deliberately only five, chosen from what the converted forms actually use.
// Anything else (chip inputs, month/day pickers, sliders, the avatar picker)
// drops to a raw <Controller>.
import { useId } from 'react';
import type {
  ComponentPropsWithoutRef,
  InputHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';
import {
  useController,
  type Control,
  type FieldPath,
  type FieldValues,
} from 'react-hook-form';
import { fieldAria } from '@/lib/form';
import {
  Field,
  FieldContent,
  FieldLabel,
  FieldTitle,
  FieldDescription,
  FieldError,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

export interface Option {
  value: string;
  label: string;
}

interface BaseProps<T extends FieldValues> {
  control: Control<T>;
  name: FieldPath<T>;
  label: string;
  description?: string;
  disabled?: boolean;
  className?: string;
}

// One hook call shared by all five, so the id derivation and the fieldAria call
// happen in exactly one place.
function useBoundField<T extends FieldValues>(
  control: Control<T>,
  name: FieldPath<T>,
  hasDescription: boolean,
) {
  // useId, not the field name: two forms on one page would otherwise mint the
  // same element ids.
  const uid = useId();
  const baseId = `${uid}-${name}`;
  const { field, fieldState } = useController({ control, name });
  const aria = fieldAria(baseId, fieldState.error, { hasDescription });
  return { field, fieldState, aria };
}

// Native attributes a caller may need on the underlying element (autoComplete,
// maxLength, min/max/step, autoFocus...). Everything the component controls is
// omitted so a stray rest prop can't fight the controlled value/handlers.
type TextFieldRest = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'onBlur' | 'ref' | 'id' | 'name' | 'className' | 'disabled' | 'placeholder' | 'type'
>;

export function TextField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  placeholder,
  numeric,
  type,
  disabled,
  className,
  ...rest
}: BaseProps<T> & { placeholder?: string; numeric?: boolean; type?: string } & TextFieldRest) {
  const { field, fieldState, aria } = useBoundField(control, name, !!description);
  return (
    <Field data-invalid={aria.invalid || undefined} className={className}>
      <FieldLabel {...aria.labelProps}>{label}</FieldLabel>
      <Input
        {...rest}
        {...aria.controlProps}
        type={type ?? (numeric ? 'number' : 'text')}
        placeholder={placeholder}
        disabled={disabled}
        // A zod z.coerce.number() field has an INPUT type of unknown, so the
        // value arriving here is not necessarily a string. Stringify for the DOM
        // and hand back a number on change when `numeric`.
        value={field.value == null ? '' : String(field.value)}
        onChange={e => {
          const raw = e.target.value;
          if (!numeric) { field.onChange(raw); return; }
          if (raw === '') { field.onChange(''); return; }
          const n = Number(raw);
          field.onChange(Number.isFinite(n) ? n : raw);
        }}
        onBlur={field.onBlur}
        ref={field.ref}
      />
      {description && (
        <FieldDescription {...aria.descriptionProps}>{description}</FieldDescription>
      )}
      <FieldError {...aria.errorProps} errors={fieldState.error ? [fieldState.error] : undefined} />
    </Field>
  );
}

type TextareaFieldRest = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  'value' | 'onChange' | 'onBlur' | 'ref' | 'id' | 'name' | 'className' | 'disabled' | 'placeholder' | 'rows'
>;

export function TextareaField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  placeholder,
  rows,
  disabled,
  className,
  ...rest
}: BaseProps<T> & { placeholder?: string; rows?: number } & TextareaFieldRest) {
  const { field, fieldState, aria } = useBoundField(control, name, !!description);
  return (
    <Field data-invalid={aria.invalid || undefined} className={className}>
      <FieldLabel {...aria.labelProps}>{label}</FieldLabel>
      <Textarea
        {...rest}
        {...aria.controlProps}
        rows={rows}
        placeholder={placeholder}
        disabled={disabled}
        value={field.value == null ? '' : String(field.value)}
        onChange={e => field.onChange(e.target.value)}
        onBlur={field.onBlur}
        ref={field.ref}
      />
      {description && (
        <FieldDescription {...aria.descriptionProps}>{description}</FieldDescription>
      )}
      <FieldError {...aria.errorProps} errors={fieldState.error ? [fieldState.error] : undefined} />
    </Field>
  );
}

type SelectFieldRest = Omit<
  ComponentPropsWithoutRef<typeof SelectTrigger>,
  'value' | 'onBlur' | 'ref' | 'id' | 'children' | 'className' | 'disabled'
>;

export function SelectField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  options,
  placeholder,
  disabled,
  className,
  ...rest
}: BaseProps<T> & { options: Option[]; placeholder?: string } & SelectFieldRest) {
  const { field, fieldState, aria } = useBoundField(control, name, !!description);
  return (
    <Field data-invalid={aria.invalid || undefined} className={className}>
      <FieldLabel {...aria.labelProps}>{label}</FieldLabel>
      <Select
        value={field.value == null ? '' : String(field.value)}
        onValueChange={field.onChange}
        disabled={disabled}
      >
        <SelectTrigger {...rest} {...aria.controlProps} onBlur={field.onBlur} ref={field.ref}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {/* SelectItem always inside a SelectGroup — shadcn composition rule. */}
          <SelectGroup>
            {options.map(o => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {description && (
        <FieldDescription {...aria.descriptionProps}>{description}</FieldDescription>
      )}
      <FieldError {...aria.errorProps} errors={fieldState.error ? [fieldState.error] : undefined} />
    </Field>
  );
}

type SwitchFieldRest = Omit<
  ComponentPropsWithoutRef<typeof Switch>,
  'checked' | 'onCheckedChange' | 'onBlur' | 'ref' | 'id' | 'className' | 'disabled'
>;

export function SwitchField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  disabled,
  className,
  ...rest
}: BaseProps<T> & SwitchFieldRest) {
  const { field, fieldState, aria } = useBoundField(control, name, !!description);
  return (
    // Switch FIRST, then a FieldContent column holding label + description. The
    // horizontal variant gives a direct-child label `flex-auto`, so as siblings
    // the switch landed wherever the label text ended (#1403). Leading with the
    // control pins every switch to one left-aligned column.
    <Field
      orientation="horizontal"
      data-invalid={aria.invalid || undefined}
      className={className}
    >
      <Switch
        {...rest}
        {...aria.controlProps}
        checked={!!field.value}
        onCheckedChange={field.onChange}
        onBlur={field.onBlur}
        disabled={disabled}
        ref={field.ref}
      />
      <FieldContent>
        <FieldLabel {...aria.labelProps}>{label}</FieldLabel>
        {description && (
          <FieldDescription {...aria.descriptionProps}>{description}</FieldDescription>
        )}
        <FieldError {...aria.errorProps} errors={fieldState.error ? [fieldState.error] : undefined} />
      </FieldContent>
    </Field>
  );
}

// ToggleGroup's own props are a `type`-discriminated union, and Omit over a
// union collapses to its SHARED keys only -- which is what's wanted: the
// type-specific `value`/`onValueChange` stay owned here.
type ToggleGroupFieldRest = Omit<
  ComponentPropsWithoutRef<typeof ToggleGroup>,
  'type' | 'value' | 'defaultValue' | 'onValueChange' | 'disabled' | 'children' | 'className'
>;

// ToggleGroup's root is `justify-center` and its default item variant is
// transparent-no-border, so a bound group read as centred plain text beside the
// bordered ChipRow pills (#1403). Left-align it, let it wrap, and default the
// items to `outline`. `variant` is still forwardable; className is owned here.
const TOGGLE_GROUP_ROW = 'w-fit flex-wrap justify-start';

// The item's on-state has to READ as on: `outline`'s data-[state=on]:bg-accent
// is a faint tint in this palette, while the ChipRow chips beside it invert to
// bg-ink/text-bg. Match them so one filter row can't look selected and the next
// look empty at the same value.
const TOGGLE_GROUP_ITEM = 'min-h-9 rounded-none border-ink px-2 text-[12px] hover:bg-[var(--ink-soft)] data-[state=on]:bg-ink data-[state=on]:text-bg';

export function ToggleGroupField<T extends FieldValues>({
  control,
  name,
  label,
  description,
  options,
  disabled,
  className,
  multiple,
  ...rest
}: BaseProps<T> & { options: Option[]; multiple?: boolean } & ToggleGroupFieldRest) {
  const { field, fieldState, aria } = useBoundField(control, name, !!description);
  // `multiple` is opt-in and defaults to the original single-select radio
  // behaviour (unclickable-to-empty). Array-valued fields need Radix's own
  // `type="multiple"`, whose value/onValueChange shape is a string[]; both
  // branches read/write the same `field`, coerced to the shape Radix expects.
  return (
    <Field data-invalid={aria.invalid || undefined} className={className}>
      {/* A ToggleGroup is a group of buttons with no single labelable control,
          so it names itself via aria-labelledby. FieldTitle, not FieldLabel:
          FieldLabel renders a <label> whose htmlFor would point at a <div>. */}
      <FieldTitle {...aria.labelledByProps}>{label}</FieldTitle>
      {multiple ? (
        <ToggleGroup
          variant="outline"
          {...rest}
          {...aria.groupProps}
          className={TOGGLE_GROUP_ROW}
          type="multiple"
          value={Array.isArray(field.value) ? field.value.map(String) : []}
          onValueChange={(v: string[]) => field.onChange(v)}
          disabled={disabled}
        >
          {options.map(o => (
            <ToggleGroupItem key={o.value} value={o.value} className={TOGGLE_GROUP_ITEM}>{o.label}</ToggleGroupItem>
          ))}
        </ToggleGroup>
      ) : (
        <ToggleGroup
          variant="outline"
          {...rest}
          {...aria.groupProps}
          className={TOGGLE_GROUP_ROW}
          type="single"
          value={field.value == null ? '' : String(field.value)}
          onValueChange={(v: string) => { if (v) field.onChange(v); }}
          disabled={disabled}
        >
          {options.map(o => (
            <ToggleGroupItem key={o.value} value={o.value} className={TOGGLE_GROUP_ITEM}>{o.label}</ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}
      {description && (
        <FieldDescription {...aria.descriptionProps}>{description}</FieldDescription>
      )}
      <FieldError {...aria.errorProps} errors={fieldState.error ? [fieldState.error] : undefined} />
    </Field>
  );
}
