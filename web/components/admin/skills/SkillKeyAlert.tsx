'use client';

import Link from 'next/link';
import { V3Alert } from '../../ui/alert';
import type { Skill } from './shared';

const LINK_CLASS = 'font-bold text-vermilion underline decoration-[1.5px] underline-offset-2';

// Why a skill can't air for want of a key. A key on file that the search provider
// refuses takes a different fix from a missing one: a saved key shadows
// SEARCH_API_KEY, so sending the operator to .env would change nothing. The card
// behind this alert is clickable, so its links stop the click.
export default function SkillKeyAlert({ skill }: { skill: Skill }) {
  const getKey = skill.keyUrl && (
    <>
      {' '}
      <a
        href={skill.keyUrl}
        target="_blank"
        rel="noreferrer"
        onClick={e => e.stopPropagation()}
        className={LINK_CLASS}
      >
        Get a key here
      </a>.
    </>
  );

  if (skill.keyProblem) {
    return (
      <V3Alert tone="error" title="Wrong API key">
        {skill.keyProblem}. Paste one in{' '}
        <Link href="/admin/settings?section=search" onClick={e => e.stopPropagation()} className={LINK_CLASS}>
          Settings &rarr; Web search
        </Link>{' '}
        and save. Until then this skill stays inert and never fires autonomously, even when
        enabled.
        {getKey}
      </V3Alert>
    );
  }

  return (
    <V3Alert tone="error" title="API key not set">
      This skill needs the <code>{skill.requiresKey || 'required API key'}</code> environment
      variable set in <code>.env</code>. Until then it stays inert and never
      fires autonomously, even when enabled.
      {getKey}
    </V3Alert>
  );
}
