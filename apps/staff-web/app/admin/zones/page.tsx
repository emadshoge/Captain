'use client';

import { RequireStaff } from '../../../components/session';
import { ActionForm, ErrorText, Table, useLoad } from '../../../components/ui';
import { api } from '../../../lib/api';

interface Zone {
  id: string;
  name: string;
  kind: string;
  active: boolean;
  version: number;
  isDevFixture: boolean;
}

/** Zone rules are open decisions (D-ZONES); the map editor needs Mapbox (B5). */
function Zones() {
  const { data, error, reload } = useLoad(
    () => api.request<Zone[]>('GET', '/v1/operator/zones'),
    [],
  );
  return (
    <>
      <h1>Zones</h1>
      <ErrorText message={error} />
      <Table
        rows={data}
        rowKey={(z) => z.id}
        empty="No zones."
        columns={[
          { label: 'Name', render: (z) => `${z.name}${z.isDevFixture ? ' (DEV FIXTURE)' : ''}` },
          { label: 'Kind', render: (z) => z.kind },
          { label: 'Active', render: (z) => (z.active ? 'yes' : 'no') },
          { label: 'Version', render: (z) => z.version },
        ]}
      />
      <ActionForm
        title="New zone (GeoJSON polygon, [lng, lat] order)"
        fields={[
          { name: 'name', label: 'Name' },
          {
            name: 'kind',
            label: 'Kind',
            type: 'select',
            options: ['service_area', 'parking', 'no_parking', 'restricted', 'slow'].map((k) => ({
              value: k,
              label: k,
            })),
          },
          {
            name: 'geometry',
            label: 'Geometry (GeoJSON)',
            type: 'textarea',
            placeholder:
              '{"type":"Polygon","coordinates":[[[38.7,9.0],[38.8,9.0],[38.8,9.1],[38.7,9.1],[38.7,9.0]]]}',
          },
          { name: 'reason', label: 'Reason' },
        ]}
        submitLabel="Create zone"
        onSubmit={async (v) => {
          let geometry: unknown;
          try {
            geometry = JSON.parse(v.geometry ?? '');
          } catch {
            throw new Error('Geometry must be valid GeoJSON.');
          }
          await api.request('POST', '/v1/admin/zones', {
            name: v.name,
            kind: v.kind,
            geometry,
            reason: v.reason,
          });
          reload();
          return 'Zone created.';
        }}
      />
    </>
  );
}

export default function ZonesPage() {
  return (
    <RequireStaff permission="zones.manage">
      <Zones />
    </RequireStaff>
  );
}
