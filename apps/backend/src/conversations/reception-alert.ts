import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Deja un aviso para recepción en la conversación de WhatsApp del paciente.
 *
 * No sale nada por WhatsApp: el mensaje se persiste como `OUT` y aparece en la
 * bandeja del panel, que es donde el operador mira. Es el único canal que
 * tenemos hoy hacia la clínica.
 *
 * Es una función suelta y no un `@Injectable` a propósito: el worker de
 * recordatorios se construye a mano en `main.ts` (`createRemindersWorker`),
 * fuera del contenedor de Nest, así que un provider inyectable no le serviría y
 * acabaríamos con dos copias de esta lógica. Y duplicar la resolución de
 * conversación es justo lo que ya nos costó un bug
 * (ver [[notas/2026-09-11-conversation-chatid-canonico]]).
 *
 * @returns `true` si el aviso quedó escrito; `false` si el paciente no tiene
 * conversación (agendó por la web y nunca escribió) — el caller decide si eso
 * merece un log o no. Nunca lanza: un aviso que falla no puede tumbar la
 * operación que lo motivó, que ya está persistida.
 */
export async function alertReception(
  prisma: PrismaService,
  input: {
    clinicId: string;
    patientId: string;
    /** Teléfono del paciente, para encontrar la conversación si no está ligada. */
    phone: string;
    /** Texto del aviso, ya formateado por el caller. */
    body: string;
    /**
     * Saca la conversación del bot y la marca para atención humana. Reservado
     * para lo que de verdad necesita que alguien llame: no queremos que la
     * bandeja se llene de hilos "pendientes" que nadie tiene que atender.
     */
    needsHuman: boolean;
  },
  logger: Logger = new Logger('ReceptionAlert'),
): Promise<boolean> {
  const { clinicId, patientId, phone, body, needsHuman } = input;

  try {
    // Mismo criterio que el resto del sistema: por `patientId` si está ligado,
    // si no por teléfono, y `updatedAt desc` para desempatar cuando hay dos
    // filas del mismo paciente (una `@lid` y una `@c.us`).
    const conversation = await prisma.conversation.findFirst({
      where: { clinicId, OR: [{ patientId }, { phone }] },
      orderBy: { updatedAt: 'desc' },
      select: { id: true },
    });

    if (!conversation) return false;

    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        ...(needsHuman ? { state: 'NEEDS_HUMAN', flowStep: null } : {}),
        messages: { create: { direction: 'OUT', body } },
      },
    });
    return true;
  } catch (e) {
    // Sin PII en el log: el `body` lleva nombre del paciente y horario.
    logger.error(
      `no se pudo avisar a recepción clinicId=${clinicId}: ${(e as Error).message}`,
    );
    return false;
  }
}
