'use client';

// Which Subsonic endpoints each source fully backs. The router declares what
// each endpoint leans on (router subsonic/coverage.ts, tested against its
// handlers); each column is a source's capabilities. Rows that differ are
// hoisted to the top, since they are the only ones carrying information.

import { Fragment } from 'react';
import type { MusicEndpointCoverage } from '../../../lib/schemas.generated';
import { coverageColumns, coverageRows, type Channel, type CoverageCell, type CoverageRow } from './model';
import s from './router.module.css';

const MARKS: Record<CoverageCell, { glyph: string; label: string; why: string }> = {
  full: { glyph: '●', label: 'full', why: 'answers in full' },
  degraded: { glyph: '◐', label: 'degraded', why: 'answers ok, with less — the station carries on without it' },
  unsupported: { glyph: '×', label: 'unsupported', why: 'answers an error the station already handles' },
  unknown: { glyph: '·', label: 'unknown', why: 'not built since the router started — select or Test it to find out' },
};

export function ServiceMatrix({ endpoints, channels }: { endpoints: MusicEndpointCoverage[]; channels: Channel[] }) {
  if (!endpoints.length || !channels.length) {
    return <p className={s.empty}>The router did not report its endpoints — it may be older than this controller.</p>;
  }
  const columns = coverageColumns(channels);
  const rows = coverageRows(endpoints, channels);
  const differs = rows.filter((r) => r.varies);
  const same = rows.filter((r) => !r.varies);

  const sectionRow = (key: string, text: string, className = s.sectionRow) => (
    <tr key={key} className={className}>
      <td colSpan={columns.length + 1}>{text}</td>
    </tr>
  );

  const dataRow = (row: CoverageRow) => (
    <tr key={row.endpoint}>
      <td title={row.needs ? `leans on the optional ${row.needs} op` : undefined}>
        {row.endpoint}
        {row.feature && <small>{row.feature}</small>}
      </td>
      {columns.map((col) => {
        const mark = MARKS[row.cells[col.key] ?? 'unknown'];
        return (
          <td key={col.key} className={s.cell} data-cell={row.cells[col.key]} title={`${col.label} — ${mark.label}: ${mark.why}`}>
            <span aria-hidden="true">{mark.glyph}</span>
            <span className="sr-only">{mark.label}</span>
          </td>
        );
      })}
    </tr>
  );

  return (
    <div>
      <div className={s.matrixWrap}>
        <table className={s.matrix}>
          <thead>
            <tr>
              <th scope="col">endpoint</th>
              {columns.map((col) => (
                <th key={col.key} scope="col" data-col data-onair={col.onAir} title={col.onAir ? 'serving the station' : 'standby'}>
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {differs.length > 0 && sectionRow('differs', 'Differs by source')}
            {differs.map(dataRow)}
            {same.length > 0 && sectionRow('same', differs.length ? 'Same across every source' : 'Same across every source — no differences found')}
            {same.map((row, i) => (
              <Fragment key={row.endpoint}>
                {(i === 0 || same[i - 1]!.group !== row.group) && sectionRow(`group-${row.group}-${i}`, row.group, s.groupRow)}
                {dataRow(row)}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      <div className={s.matrixLegend}>
        {(['full', 'degraded', 'unsupported', 'unknown'] as const).map((key) => (
          <span key={key}>
            <span className={s.cell} data-cell={key} aria-hidden="true">{MARKS[key].glyph}</span>
            {MARKS[key].label}
          </span>
        ))}
      </div>
    </div>
  );
}
