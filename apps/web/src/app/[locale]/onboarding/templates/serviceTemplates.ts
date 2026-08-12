/**
 * Templates de servicios sugeridos por tipo de clínica.
 *
 * Se muestran como chips clickeables en el step 2 del wizard — al tocarlos,
 * pre-llenan el form (name + durationMin). El user puede editar antes de
 * crear, o directamente escribir uno libre ignorando los chips.
 *
 * Reciprocity + activation energy: dar 80% del trabajo hecho vs pantalla en
 * blanco. Duraciones basadas en tiempos típicos consultados con clínicas
 * reales durante research previo al piloto.
 *
 * `other` retorna array vacío — mostramos solo input libre.
 */

export type ClinicType =
  | 'dentistry'
  | 'aesthetics'
  | 'general_medicine'
  | 'physiotherapy'
  | 'psychology'
  | 'other';

export const CLINIC_TYPES: readonly ClinicType[] = [
  'dentistry',
  'aesthetics',
  'general_medicine',
  'physiotherapy',
  'psychology',
  'other',
] as const;

export interface ServiceTemplate {
  name: string;
  durationMin: number;
}

export const SERVICE_TEMPLATES: Record<ClinicType, ServiceTemplate[]> = {
  dentistry: [
    { name: 'Consulta de control', durationMin: 30 },
    { name: 'Limpieza dental', durationMin: 45 },
    { name: 'Extracción', durationMin: 60 },
    { name: 'Endodoncia', durationMin: 90 },
    { name: 'Blanqueamiento', durationMin: 60 },
  ],
  aesthetics: [
    { name: 'Limpieza facial', durationMin: 60 },
    { name: 'Masaje relajante', durationMin: 60 },
    { name: 'Depilación', durationMin: 30 },
    { name: 'Aplicación de bótox', durationMin: 45 },
    { name: 'Peeling químico', durationMin: 45 },
  ],
  general_medicine: [
    { name: 'Consulta médica', durationMin: 30 },
    { name: 'Control', durationMin: 20 },
    { name: 'Certificado médico', durationMin: 15 },
    { name: 'Vacunación', durationMin: 15 },
  ],
  physiotherapy: [
    { name: 'Sesión de kinesiología', durationMin: 45 },
    { name: 'Evaluación inicial', durationMin: 60 },
    { name: 'Reeducación postural', durationMin: 60 },
  ],
  psychology: [
    { name: 'Primera consulta', durationMin: 60 },
    { name: 'Sesión individual', durationMin: 50 },
    { name: 'Sesión de pareja', durationMin: 75 },
  ],
  other: [],
};
