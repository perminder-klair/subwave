import * as React from 'react';
import {
  FieldSet,
  FieldLegend,
  FieldGroup,
  Field,
  FieldLabel,
  FieldContent,
  FieldDescription,
  FieldError,
  Input,
} from 'sub-wave-web';

// Onboarding-style grouped form: a legend over a FieldGroup of vertical
// Fields, each pairing a FieldLabel caption with a FieldContent column
// (control + description). Mirrors the /onboarding Navidrome step.
export const FieldSetGroup = () => (
  <div style={{ maxWidth: 460 }}>
    <FieldSet>
      <FieldLegend>Navidrome</FieldLegend>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="nd-url">Server URL</FieldLabel>
          <FieldContent>
            <Input id="nd-url" defaultValue="http://navidrome:4533" />
            <FieldDescription>
              The Subsonic-compatible endpoint the controller reads music from.
            </FieldDescription>
          </FieldContent>
        </Field>
        <Field>
          <FieldLabel htmlFor="nd-user">Username</FieldLabel>
          <FieldContent>
            <Input id="nd-user" defaultValue="operator" />
          </FieldContent>
        </Field>
      </FieldGroup>
    </FieldSet>
  </div>
);

// Invalid state — data-invalid on the Field tints the label destructive and
// FieldError renders the vermilion message below the control.
export const WithError = () => (
  <div style={{ maxWidth: 460 }}>
    <Field data-invalid>
      <FieldLabel htmlFor="stream-url">Site URL</FieldLabel>
      <FieldContent>
        <Input id="stream-url" defaultValue="notaurl" aria-invalid />
        <FieldError>Enter a full URL including https://</FieldError>
      </FieldContent>
    </Field>
  </div>
);

// A lone field with a helper description and no error — the common case.
export const SingleField = () => (
  <div style={{ maxWidth: 460 }}>
    <Field>
      <FieldLabel htmlFor="station-name">Station name</FieldLabel>
      <FieldContent>
        <Input id="station-name" defaultValue="SUB/WAVE" />
        <FieldDescription>Shown on the player masthead and lock screen.</FieldDescription>
      </FieldContent>
    </Field>
  </div>
);
