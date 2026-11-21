import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { V3AlertDialog } from '../../ui/alert-dialog';
import { ShowGenerationDialog, ShowGenerationNotice } from './ShowGenerationNotice';

const guide = 'https://github.com/perminder-klair/subwave/discussions/1817';

test('musical readiness guidance includes a safe external Musical Leanings link', () => {
  const html = renderToStaticMarkup(createElement(ShowGenerationNotice, {
    message: `Add musical detail to the Soul.\n\nHow to give your DJ Musical Leanings: ${guide}`,
  }));
  assert.match(html, /Add musical detail to the Soul/);
  assert.match(html, /href="https:\/\/github.com\/perminder-klair\/subwave\/discussions\/1817"/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.equal(html.split(guide).length - 1, 1);
});

test('generation failure uses the station alert dialog with one explicit dismissal action', () => {
  let dismissed = 0;
  const dialog = ShowGenerationDialog({ message: 'Not enough artist variety.', onDismiss: () => { dismissed++; } });
  assert.equal(dialog.type, V3AlertDialog);
  assert.equal(dialog.props.open, true);
  assert.equal(dialog.props.cancelLabel, null);
  assert.equal(dialog.props.confirmLabel, 'Dismiss');
  dialog.props.onOpenChange(true);
  assert.equal(dismissed, 0);
  dialog.props.onOpenChange(false);
  assert.equal(dismissed, 1);
  dialog.props.onConfirm();
  assert.equal(dismissed, 2);
  assert.equal(ShowGenerationDialog({ message: null, onDismiss: () => {} }).props.open, false);
});
