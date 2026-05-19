import React, { useState } from 'react';
import { Box, Text } from 'ink';
import TextInput from 'ink-text-input';
import { c, glyph } from '../theme.js';

// Listener request form, dressed as a Winamp "Add URL" dialog. Submits to
// POST /request, then polls GET /request/:id for the booth's outcome —
// same flow as the web RequestDrawer.
//
// Field order: name → request text → submit on Enter. While this panel is
// mounted, App suppresses its own shortcuts (except Esc), so the
// TextInputs own the keyboard.
export default function RequestForm({ apiUrl }) {
  const [field, setField] = useState('name');   // name | text | sent
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [status, setStatus] = useState(null);   // { kind, message }

  const poll = async (id) => {
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const res = await fetch(`${apiUrl}/request/${id}`);
        if (res.status === 404) {
          setStatus({ kind: 'error', message: 'Request lost — try again.' });
          return;
        }
        const d = await res.json();
        if (d.status === 'resolved') {
          const track = d.track ? ` — ${d.track.title} by ${d.track.artist}` : '';
          setStatus({ kind: 'ok', message: `${d.ack || 'Queued.'}${track}` });
          return;
        }
        if (d.status === 'failed') {
          setStatus({ kind: 'error', message: d.message || 'Nothing matched that.' });
          return;
        }
      } catch {}
    }
    setStatus({ kind: 'error', message: 'Timed out waiting on the booth.' });
  };

  const submit = async () => {
    if (!text.trim()) { setField('text'); return; }
    setField('sent');
    setStatus({ kind: 'pending', message: 'Sending to the booth…' });
    try {
      const res = await fetch(`${apiUrl}/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.trim(), name: name.trim() }),
      });
      const data = await res.json();
      if (!data.success) {
        setStatus({ kind: 'error', message: data.message || 'Request rejected.' });
        return;
      }
      setStatus({ kind: 'pending', message: 'In the booth — waiting for a pick…' });
      await poll(data.requestId);
    } catch {
      setStatus({ kind: 'error', message: 'Network error — is the controller up?' });
    }
  };

  const statusColor = status
    ? { ok: c.ok, error: c.danger, pending: c.warn }[status.kind]
    : undefined;
  const focusTextField = field === 'text';

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={c.chrome}>CALLSIGN  </Text>
        <Text color={c.chrome}>[ </Text>
        <TextInput
          value={name}
          onChange={setName}
          focus={field === 'name'}
          placeholder="anon"
          onSubmit={() => setField('text')}
        />
        <Text color={c.chrome}> ]</Text>
      </Box>
      <Box>
        <Text color={c.chrome}>URL/PATH  </Text>
        <Text color={c.chrome}>[ </Text>
        <TextInput
          value={text}
          onChange={setText}
          focus={focusTextField}
          placeholder="an artist, a song, or a vibe…"
          onSubmit={submit}
        />
        <Text color={c.chrome}> ]</Text>
      </Box>
      <Box marginTop={1}>
        <Text color={c.chrome}>[ </Text>
        <Text color={focusTextField ? c.title : c.chrome} bold={focusTextField}>OK</Text>
        <Text color={c.chrome}> ]   [ </Text>
        <Text color={c.chrome}>CANCEL</Text>
        <Text color={c.chrome}> ]</Text>
        <Text color={c.chrome}>     {glyph.shimL} Enter sends · Esc cancels {glyph.shimR}</Text>
      </Box>
      <Box marginTop={1}>
        {status
          ? <Text color={statusColor}>{status.message}</Text>
          : <Text dimColor>Enter advances; Enter on URL/PATH sends.</Text>}
      </Box>
    </Box>
  );
}
