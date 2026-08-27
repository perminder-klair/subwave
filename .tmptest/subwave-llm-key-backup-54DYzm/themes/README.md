# Custom themes

Drop `.json` files in this directory to add themes to the SUB/WAVE picker.

Each file:

```json
{
  "id": "my-theme",
  "name": "My Theme",
  "description": "Optional short blurb",
  "mode": "dark",
  "tokens": {
    "--bg": "#000000",
    "--ink": "#ffffff",
    "--accent": "#ff6b3d"
  }
}
```

Allowed token keys: --bg, --surface, --surface-border, --field, --ink, --muted, --ink-faint, --accent, --accent-2, --accent-soft, --line, --soft-border, --overlay, --display-font, --mono-font, --grain.

`id` should match the filename (`my-theme.json` → `id: "my-theme"`) and may
only contain lowercase letters, digits, and dashes. Built-in ids
(blueprint, classic-dark, classic-light, cyberpunk, flare, recon, signal, vinyl) are reserved — files claiming those ids are skipped.

Tokens you omit inherit from the mode baseline (light or dark) declared in
`web/app/globals.css`. After dropping a new file in, use the **Refresh themes**
button in admin → Settings → Theme to make it appear in the picker without a
controller restart.
