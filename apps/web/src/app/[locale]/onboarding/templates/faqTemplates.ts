/**
 * Templates de FAQs para pre-cargar en el step 1 del wizard.
 *
 * Si el user marca "Cargar 5 preguntas típicas por mí" (checkbox default true),
 * después del step 2 disparamos `Promise.allSettled` de N POST /faq con estos
 * templates. Errores parciales son tolerables — logueamos y seguimos.
 *
 * Estrategia: 4 comunes a todas las clínicas + 1-2 específicas por tipo. Total
 * ~5-6 por clinicType. Nada de placeholders que necesiten resolverse antes de
 * mostrar — el bot ya cae a fallback si el content menciona algo que el user
 * todavía no configuró (ej. dirección).
 */

import type { ClinicType } from './serviceTemplates';

export interface FaqTemplate {
  title: string;
  content: string;
}

const COMMON_FAQS = (clinicName: string): FaqTemplate[] => [
  {
    title: 'Horarios de atención',
    content: `En ${clinicName} atendemos de lunes a viernes de 9:00 a 18:00. Podés reservar tu cita por WhatsApp escribiéndonos con tu nombre completo y el servicio que necesitás.`,
  },
  {
    title: 'Ubicación',
    content: `Podés encontrar nuestra dirección en el perfil de WhatsApp Business de ${clinicName}. Si necesitás indicaciones detalladas o hay algún inconveniente con el domicilio, escribinos y te ayudamos.`,
  },
  {
    title: 'Formas de pago',
    content: `Aceptamos efectivo, transferencia bancaria y las principales tarjetas de crédito y débito. Consultá al momento de reservar si tu obra social o prepaga tiene convenio con nosotros.`,
  },
  {
    title: 'Cancelaciones y reprogramaciones',
    content: `Podés cancelar o reprogramar tu cita hasta 24 horas antes del turno sin costo. Escribinos por WhatsApp con tu nombre y el horario reservado — te ofrecemos alternativas disponibles.`,
  },
];

const TYPE_SPECIFIC: Record<ClinicType, FaqTemplate[]> = {
  dentistry: [
    {
      title: '¿Qué traer a la primera consulta?',
      content: `En tu primera consulta te vamos a hacer una evaluación completa. Trae tu documento y, si tenés, radiografías o tratamientos previos. La cita dura entre 30 y 45 minutos.`,
    },
    {
      title: 'Emergencias fuera de horario',
      content: `Si tenés una emergencia dental fuera del horario de atención (dolor agudo, traumatismo), escribinos por WhatsApp. Coordinamos la primera cita disponible del día siguiente.`,
    },
  ],
  aesthetics: [
    {
      title: 'Preparación antes del tratamiento',
      content: `Para tratamientos faciales, no te maquilles el día de la sesión. Para depilación, la piel debe estar limpia y con el vello de al menos 5mm. En caso de duda, consultanos al reservar.`,
    },
    {
      title: 'Cuidados posteriores',
      content: `Después de cada tratamiento te damos las indicaciones específicas por escrito. En general recomendamos evitar sol directo por 24-48hs y usar protector solar factor 50+.`,
    },
  ],
  general_medicine: [
    {
      title: 'Certificados y órdenes médicas',
      content: `Emitimos certificados médicos y órdenes para estudios en el momento de la consulta. Traé tu documento y, si aplica, la orden previa de tu obra social.`,
    },
    {
      title: 'Recetas y renovaciones',
      content: `Renovamos recetas de tratamientos crónicos en la consulta. Si necesitás una renovación urgente entre consultas, escribinos por WhatsApp y evaluamos el caso.`,
    },
  ],
  physiotherapy: [
    {
      title: 'Qué ropa usar',
      content: `Vení con ropa cómoda que permita movimiento libre (calzas, remera de algodón). Traé también tus estudios previos si los tenés (radiografías, resonancias, informes).`,
    },
    {
      title: 'Cantidad de sesiones típica',
      content: `Después de la evaluación inicial te vamos a proponer un plan de sesiones. Los tratamientos suelen requerir entre 6 y 12 sesiones, con una frecuencia de 2-3 por semana.`,
    },
  ],
  psychology: [
    {
      title: 'Confidencialidad',
      content: `Todo lo que hablamos en las sesiones es estrictamente confidencial, resguardado por el secreto profesional. Solo compartimos información con terceros bajo tu consentimiento expreso.`,
    },
    {
      title: 'Duración y frecuencia',
      content: `Las sesiones individuales duran 50 minutos y las de pareja 75 minutos. La frecuencia habitual es semanal, aunque se ajusta a cada caso durante las primeras entrevistas.`,
    },
  ],
  other: [],
};

/**
 * Devuelve el set completo de FAQs para pre-cargar. `clinicName` se inyecta
 * en el contenido para evitar templates genéricos que se sienten copiados.
 */
export function getFaqTemplates(
  clinicType: ClinicType,
  clinicName: string,
): FaqTemplate[] {
  return [...COMMON_FAQS(clinicName), ...TYPE_SPECIFIC[clinicType]];
}
