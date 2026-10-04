'use client';

import { useState } from 'react';
import { RequireStaff } from '../../components/session';
import { ActionForm, ErrorText, useLoad } from '../../components/ui';
import { api, messageFor } from '../../lib/api';

interface Me {
  email: string;
  displayName: string;
  roles: string[];
  mfaEnabled: boolean;
  mfaVerifiedThisSession: boolean;
}

function Account() {
  const me = useLoad(() => api.request<Me>('GET', '/v1/staff/me'), []);
  const [setup, setSetup] = useState<{ otpauthUri: string; secret: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <h1>Account</h1>
      <ErrorText message={me.error ?? error} />
      {me.data ? (
        <section className="card">
          <p>
            {me.data.displayName} · {me.data.email} · {me.data.roles.join(', ')}
          </p>
          <p data-testid="mfa-state">
            Authenticator: {me.data.mfaEnabled ? 'enrolled' : 'not enrolled'}
          </p>
        </section>
      ) : null}
      {me.data && !me.data.mfaEnabled ? (
        <section className="card">
          <h2>Set up an authenticator app</h2>
          {!setup ? (
            <button
              onClick={async () => {
                try {
                  setSetup(await api.request('POST', '/v1/staff/me/totp/setup', {}));
                } catch (e) {
                  setError(messageFor(e));
                }
              }}
            >
              Start setup
            </button>
          ) : (
            <>
              <p>Add this key to your authenticator app (shown once):</p>
              <code data-testid="totp-secret">{setup.secret}</code>
              <ActionForm
                fields={[{ name: 'code', label: 'Code from the app' }]}
                submitLabel="Confirm authenticator"
                onSubmit={async (v) => {
                  await api.request('POST', '/v1/staff/me/totp/confirm', { code: v.code });
                  setSetup(null);
                  me.reload();
                  return 'Authenticator enrolled.';
                }}
              />
            </>
          )}
        </section>
      ) : null}
    </>
  );
}

export default function AccountPage() {
  return (
    <RequireStaff>
      <Account />
    </RequireStaff>
  );
}
