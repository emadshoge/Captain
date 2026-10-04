'use client';

import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react';
import { messageFor } from '../lib/api';

export function SimBadge({ simulated }: { simulated: boolean | null | undefined }) {
  return simulated ? (
    <span className="badge" title="Simulated device — not real hardware">
      SIMULATED
    </span>
  ) : null;
}

export function ErrorText({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="error">
      {message}
    </p>
  ) : null;
}

export function Notice({ message }: { message: string | null }) {
  return message ? (
    <p role="status" className="notice">
      {message}
    </p>
  ) : null;
}

export interface Column<T> {
  label: string;
  render: (row: T) => ReactNode;
}

export function Table<T>({
  rows,
  columns,
  rowKey,
  empty = 'Nothing to show.',
}: {
  rows: T[] | null;
  columns: Column<T>[];
  rowKey: (row: T) => string;
  empty?: string;
}) {
  if (rows === null) return <p aria-busy="true">Loading…</p>;
  if (rows.length === 0) return <p className="muted">{empty}</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.label} scope="col">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((c) => (
                <td key={c.label}>{c.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Loads data with cancellation; `reload` re-runs it. */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const value = await load();
        if (!cancelled) {
          setData(value);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(messageFor(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version]);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { data, error, reload };
}

export interface FieldSpec {
  name: string;
  label: string;
  type?: 'text' | 'textarea' | 'number' | 'select' | 'datetime-local';
  options?: { value: string; label: string }[];
  required?: boolean;
  initial?: string;
  placeholder?: string;
}

/**
 * A form for one staff action. Financial and destructive actions pass
 * `confirm`: the submit stays disabled until the confirmation box is ticked.
 * Reasons are fields like any other (the API requires and audits them).
 */
export function ActionForm({
  title,
  fields,
  submitLabel,
  confirm,
  danger,
  onSubmit,
  testId,
}: {
  title?: string;
  fields: FieldSpec[];
  submitLabel: string;
  confirm?: string;
  danger?: boolean;
  onSubmit: (values: Record<string, string>) => Promise<string | void>;
  testId?: string;
}) {
  const initial = Object.fromEntries(
    fields.map((f) => [f.name, f.initial ?? f.options?.[0]?.value ?? '']),
  );
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const message = await onSubmit(values);
      setNotice(message ?? 'Done.');
      setValues(initial);
      setConfirmed(false);
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  const missing = fields.some((f) => f.required !== false && !values[f.name]?.trim());
  return (
    <form onSubmit={submit} className="card" data-testid={testId} aria-label={title ?? submitLabel}>
      {title ? <h3>{title}</h3> : null}
      {fields.map((f) => (
        <label key={f.name}>
          {f.label}
          {f.type === 'select' ? (
            <select
              name={f.name}
              value={values[f.name]}
              onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
            >
              {f.options?.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : f.type === 'textarea' ? (
            <textarea
              name={f.name}
              value={values[f.name]}
              placeholder={f.placeholder}
              rows={5}
              onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
            />
          ) : (
            <input
              name={f.name}
              type={f.type === 'number' ? 'text' : (f.type ?? 'text')}
              inputMode={f.type === 'number' ? 'decimal' : undefined}
              value={values[f.name]}
              placeholder={f.placeholder}
              onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
            />
          )}
        </label>
      ))}
      {confirm ? (
        <label className="confirm">
          <span>
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />{' '}
            {confirm}
          </span>
        </label>
      ) : null}
      <ErrorText message={error} />
      <Notice message={notice} />
      <button
        type="submit"
        className={danger ? 'danger' : undefined}
        disabled={busy || missing || (!!confirm && !confirmed)}
      >
        {submitLabel}
      </button>
    </form>
  );
}

/** A single-click action with an inline confirmation step. */
export function ConfirmButton({
  label,
  confirmLabel,
  onConfirm,
}: {
  label: string;
  confirmLabel?: string;
  onConfirm: () => Promise<void>;
}) {
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!asking) {
    return (
      <button className="secondary" onClick={() => setAsking(true)}>
        {label}
      </button>
    );
  }
  return (
    <span className="inline">
      <button
        onClick={async () => {
          try {
            await onConfirm();
            setAsking(false);
          } catch (e) {
            setError(messageFor(e));
          }
        }}
      >
        {confirmLabel ?? `Confirm ${label.toLowerCase()}`}
      </button>
      <button className="secondary" onClick={() => setAsking(false)}>
        Cancel
      </button>
      <ErrorText message={error} />
    </span>
  );
}
