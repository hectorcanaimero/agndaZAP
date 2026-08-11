/**
 * Cliente HTTP para captura de leads desde la landing pública.
 *
 * Espeja el shape de `createAppointment` (discriminated union) para que el
 * caller distinga 200/OK vs 429/400/etc sin try/catch inflado. Toast + inline
 * error se manejan en el componente, no acá.
 */

import { API_URL } from './api';

export interface CreateLeadPayload {
  name: string;
  phone: string;
  clinicType?: string;
  notes?: string;
  consent: true;
  locale: string;
  honeypot?: string;
}

export type CreateLeadResponse =
  | { ok: true }
  | { ok: false; status: number; message: string };

export async function submitLead(
  payload: CreateLeadPayload,
): Promise<CreateLeadResponse> {
  const res = await fetch(`${API_URL}/api/public/leads`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (res.status === 201 || res.status === 200) {
    return { ok: true };
  }

  const message =
    (body as { message?: string } | null)?.message ?? `HTTP ${res.status}`;
  return { ok: false, status: res.status, message };
}
