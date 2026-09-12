/**
 * Copy del bot, por idioma de la clínica (B7).
 *
 * Antes todo estaba hardcodeado en español y `clinic.locale` solo cambiaba el
 * formato de las fechas, así que una clínica `pt` recibía un bot en español —
 * con fechas en portugués. Peor que uniforme.
 *
 * El catálogo es un `Record<BotLocale, BotCopy>`: si alguien añade una clave a
 * `es` y se olvida de `pt`, **no compila**. Es la única forma de que esto no
 * vuelva a quedar a medias, que es como estaba.
 *
 * Los textos con datos dentro son funciones y no plantillas con
 * `{placeholders}`: el compilador comprueba que cada idioma recibe los mismos
 * argumentos, y no hay forma de olvidarse de sustituir uno.
 *
 * Sobre el registro: en español, tuteo LATAM neutro, nunca voseo (ver
 * `docs/notas/2026-09-10-tono-espanol-neutro.md`). En portugués, "você",
 * registro de Brasil.
 */

export type BotLocale = 'es' | 'pt';

/** `clinic.locale` es un `String` libre en DB: cae a `es` si no reconocemos. */
export function botLocale(locale: string | null | undefined): BotLocale {
  return locale === 'pt' ? 'pt' : 'es';
}

export interface BotCopy {
  /** Pools que rotan variantes para no repetir siempre el mismo string. */
  pools: {
    greeting: readonly string[];
    greetingWithAppointment: readonly string[];
    fallback: readonly string[];
    handoff: readonly string[];
    closing: readonly string[];
    ctaAfterAnswer: readonly string[];
    confirmAppointment: readonly string[];
  };
  /** Aviso de asistente automático (ADR 0004 §7.1). */
  aiDisclosure: string;
  /** Saludo con cita próxima: la línea que describe el estado de la cita. */
  apptConfirmedLine(service: string, when: string): string;
  apptPendingLine(service: string, when: string): string;
  /** Cierre del agendamiento: línea con el link de gestión, o el fallback. */
  manageLine(url: string): string;
  manageLineFallback: string;
  status: { confirmed: string; scheduled: string; moved: string };

  // ── FSM ──
  noServices: string;
  askService(list: string): string;
  flowAborted: string;
  serviceGone: string;
  noProfessionals: string;
  askProfessional(list: string): string;
  anyProfessionalLabel: string;
  serviceLostProfessionals: string;
  professionalGone: string;
  slotsIntro: string;
  slotsIntroNextWeek: string;
  slotsIntroPreferenceMissed: string;
  slotsIntroReschedule: string;
  slotsMoreOption: string;
  slotsPrompt(labels: string, more: string, footer: string, intro: string): string;
  noSlots: string;
  agendaExhausted(link: string): string;
  agendaExhaustedWindows(link: string): string;
  agendaChanged: string;
  askName: string;
  askNameAgain: string;
  confirmPrompt(name: string, service: string, professional: string, when: string): string;
  confirmOnlyYesOrNo: string;
  nothingScheduled: string;
  flowLost: string;
  needPhone(link: string): string;
  createFailed: string;
  webFallback(message: string, link: string): string;
  rescheduleFooter(link: string): string;
  rescheduleSlots(link: string): string;
  rescheduleLimit(link: string | null): string;
  notUnderstoodService(list: string): string;
  notUnderstoodProfessional(list: string): string;
  notUnderstoodSlot(list: string): string;
  slotNotInList(max: number, list: string): string;
  slotTaken(labels: string): string;
  slotExpired(labels: string): string;
  noSlotsLeftForPair: string;

  // ── Recordatorio / gestión de cita ──
  cannotLinkChat: string;
  noUpcomingAppointment: string;
  appointmentConfirmed: string;
  appointmentCanceled: string;
  cancelNeedsWord(link: string | null): string;
  confirmNeedsWord: string;
  handoffOutsideHours(schedule: string): string;

  /** Aviso mientras la conversación espera a una persona (S29). */
  waitingForHuman: string;
  /** Respuesta a "¿cuándo es mi cita?" (M3-b). */
  appointmentInfo(service: string, professional: string, when: string, statusLine: string, link: string | null): string;
  noAppointmentToTell: string;

  // ── Processors (recordatorios y follow-up) ──
  reminder(patientName: string, service: string, clinic: string, when: string): string;
  reminderManageLine(url: string): string;
  followUpPrompt(patientName: string, clinic: string, professional: string): string;

  // ── Sub-FSM de feedback ──
  npsInvalid: string;
  npsThanks: string;
  npsAskComment: string;
  npsDone: string;

  /**
   * Aviso de transcripción de notas de voz (M10, PR3). Se envía una sola vez
   * por paciente, antes de procesar su primera nota de voz como si fuera
   * texto (ver docs/adr/0004-pii-y-compliance.md §7.2). `SttService` (PR2)
   * existe pero todavía no está cableado a `bot.service.ts`, así que esta
   * clave no se usa desde el bot hasta que ese cableado exista.
   */
  voiceNoteFirstTime: string;
}

const es: BotCopy = {
  pools: {
    greeting: [
      '¡Hola! Soy el asistente de {clinicName}. ¿Quieres agendar una cita? Escríbeme *agendar* y lo hacemos aquí mismo, o reserva en línea: {link}\n\nSi tienes otra duda, cuéntame.',
      'Hola 👋 Soy el asistente de {clinicName}. Escríbeme *agendar* para reservar tu cita por aquí, o hazlo en línea: {link}\n\nTambién puedo responder tus dudas.',
      '¡Hola! Gracias por escribir a {clinicName}. Para reservar una cita escríbeme *agendar*, o usa nuestra página: {link}\n\n¿En qué te ayudo?',
    ],
    greetingWithAppointment: [
      'Hola{patientName}. {statusLine}\n\nResponde *SÍ* para confirmarla, *REAGENDAR* para moverla o *CANCELAR* si no puedes ir.\n\nSi necesitas otra cosa, cuéntame.',
    ],
    fallback: [
      'Puedo ayudarte a *agendar*, *reagendar* o *cancelar* una cita, o responder dudas. ¿Qué necesitas?',
      'Cuéntame qué necesitas: puedo *agendar*, *reagendar* o *cancelar* una cita, o responder dudas.',
      'Estoy para ayudarte con tu cita. Puedes escribir *agendar*, *reagendar*, *cancelar*, o preguntarme algo.',
    ],
    handoff: [
      'Enseguida te atiende una persona del equipo. 🙏',
      'Te derivo con alguien del equipo, enseguida te responden. 🙏',
    ],
    closing: [
      '¡Con gusto! Si necesitas algo más, escríbeme. 🙌',
      'De nada. Aquí estoy si necesitas algo más. 🙌',
      '¡Un gusto ayudarte! Cualquier cosa, escríbeme. 🙌',
    ],
    ctaAfterAnswer: [
      '¿Quieres agendar? Escríbeme *agendar* y lo hacemos aquí, o reserva en línea: {link}',
      'Si quieres una cita, escríbeme *agendar* o resérvala aquí: {link}',
      'Cuando quieras agendar, escríbeme *agendar* o usa nuestra página: {link}',
    ],
    confirmAppointment: [
      '✅ Listo. Tu cita de {service} con {professional} quedó {status} para el {when} en {clinicName}.{address}\n\nTe recordaré antes de la cita.{manageLine}',
      '¡Perfecto! Reservé tu cita de {service} con {professional} para el {when} en {clinicName}.{address}\n\nTe avisaré antes para recordártela.{manageLine}',
    ],
  },
  aiDisclosure:
    'Soy un asistente automático. Si prefieres hablar con una persona, escribe *humano*.',
  apptConfirmedLine: (service, when) =>
    `Tu cita de ${service} del ${when} ya está confirmada.`,
  apptPendingLine: (service, when) =>
    `Veo que tienes una cita de ${service} el ${when}.`,
  manageLine: (url) =>
    `\n\nSi necesitas cambiarla o cancelarla, entra aquí:\n${url}`,
  manageLineFallback: '\n\nSi necesitas cambiarla, escríbeme *reagendar*.',
  status: { confirmed: 'confirmada', scheduled: 'agendada', moved: 'movida' },

  noServices:
    'Por ahora no tenemos servicios cargados. Escríbeme más tarde o escribe *humano* para hablar con una persona.',
  askService: (list) =>
    `¡Con gusto te agendo! Primero, ¿qué servicio necesitas?\n\n${list}\n\nResponde con el número o el nombre.`,
  flowAborted:
    'Listo, dejé el agendamiento en pausa. Cuando quieras, escríbeme *agendar* para retomar.',
  serviceGone:
    'Ese servicio ya no está disponible. Escríbeme *agendar* para empezar de nuevo.',
  noProfessionals:
    'Por ahora no tengo profesionales disponibles para ese servicio. Escríbeme más tarde.',
  askProfessional: (list) =>
    `Perfecto. ¿Con qué profesional prefieres?\n\n${list}\n\nResponde con el número o el nombre.`,
  anyProfessionalLabel: 'Cualquier profesional',
  serviceLostProfessionals:
    'Ese servicio se quedó sin profesionales disponibles. Escríbeme *agendar* para retomar.',
  professionalGone:
    'Ese profesional ya no está disponible. Escríbeme *agendar* para retomar.',
  slotsIntro: 'Vamos bien. Estos son los próximos horarios disponibles:',
  slotsIntroNextWeek: 'Estos son los horarios de la semana siguiente:',
  slotsIntroPreferenceMissed:
    'No me quedan horarios con esa preferencia, pero sí estos:',
  slotsIntroReschedule:
    'Te muestro los horarios libres para mover tu cita. La actual sigue en pie hasta que elijas:',
  slotsMoreOption: '\n0. Ver más horarios',
  slotsPrompt: (labels, more, footer, intro) =>
    `${intro}\n\n${labels}${more}\n\nResponde con el número del horario que prefieras.${footer}`,
  noSlots:
    'No encontré horarios libres en los próximos días. Escríbeme más tarde y volvemos a intentar.',
  agendaExhausted: (link) =>
    `Hasta ahí llega mi agenda por aquí. Puedes ver el calendario completo y elegir con calma en este enlace, que vence en 30 minutos:\n\n${link}`,
  agendaExhaustedWindows: (link) =>
    `Por aquí ya te mostré las próximas semanas. Para ver el calendario completo y elegir con calma, entra en este enlace, que vence en 30 minutos:\n\n${link}\n\nO responde con el número de alguno de los horarios que te pasé.`,
  agendaChanged:
    'Algo cambió en la agenda. Escríbeme *agendar* para volver a intentar.',
  askName: 'Ya casi terminamos. ¿A nombre de quién agendo la cita?',
  askNameAgain: 'Creo que no te entendí. ¿A nombre de quién agendo la cita?',
  confirmPrompt: (name, service, professional, when) =>
    `Último paso. ¿Confirmo tu cita, ${name}, de ${service} con ${professional} el ${when}? Responde *SÍ* para confirmar o *no* para cancelar.`,
  confirmOnlyYesOrNo:
    'Solo necesito un *SÍ* para confirmar o un *no* para cancelar el agendamiento.',
  nothingScheduled:
    'Listo, no agendé nada. Cuando quieras retomar, escríbeme *agendar*.',
  flowLost:
    'Perdí el hilo del agendamiento. Escríbeme *agendar* y empezamos de nuevo.',
  needPhone: (link) =>
    `Para terminar de agendar necesito tu número de teléfono. Completa tu cita aquí, el enlace vence en 30 minutos:\n\n${link}`,
  createFailed:
    'Se me complicó registrar la cita. Vuelve a intentar en un momento o escribe *humano* para hablar con una persona.',
  webFallback: (message, link) =>
    `${message}\n\nSi te resulta más cómodo, también puedes elegir todo desde aquí (el enlace vence en 30 minutos):\n\n${link}`,
  rescheduleFooter: (link) => `\n\nO elígelo con calma aquí: ${link}`,
  rescheduleSlots: (link) =>
    `Puedes elegir el horario nuevo aquí:\n\n${link}\n\nTu cita actual sigue en pie hasta que la cambies.`,
  rescheduleLimit: (link) =>
    `Ya moviste esta cita varias veces, así que prefiero que lo veas con una persona del equipo para no liarlo más. Te derivo con recepción.${
      link ? `\n\nMientras tanto, aquí tienes el detalle de tu cita:\n${link}` : ''
    }`,
  notUnderstoodService: (list) =>
    `Creo que no te entendí. Elige un servicio de la lista:\n\n${list}\n\nResponde con el número o el nombre.`,
  notUnderstoodProfessional: (list) =>
    `Creo que no te entendí. Elige un profesional de la lista:\n\n${list}\n\nResponde con el número o el nombre.`,
  notUnderstoodSlot: (list) =>
    `Creo que no te entendí. Elige un horario respondiendo con su número:\n\n${list}`,
  slotNotInList: (max, list) =>
    `Ese número no está en la lista. Elige uno entre 1 y ${max}:\n\n${list}`,
  slotTaken: (labels) =>
    `¡Ay! Ese horario acaba de ocuparse. Te muestro los que quedan libres:\n\n${labels}\n\nElige uno respondiendo con el número.`,
  slotExpired: (labels) =>
    `Ese horario ya pasó. Te muestro los que quedan libres:\n\n${labels}\n\nElige uno respondiendo con el número.`,
  noSlotsLeftForPair:
    'Por ahora no quedan horarios en los próximos 7 días para este servicio y profesional. Escríbeme *agendar* más tarde y probamos de nuevo.',

  cannotLinkChat:
    'No pude asociar este chat a una cita. Te derivo con recepción para ayudarte.',
  noUpcomingAppointment:
    'No encontré una cita próxima asociada a este número. Si necesitas ayuda, escribe *humano* para hablar con una persona.',
  appointmentConfirmed: '¡Listo! Tu cita quedó confirmada. Te esperamos.',
  appointmentCanceled:
    'Tu cita fue cancelada. Cuando quieras, escríbeme para reagendar.',
  cancelNeedsWord: (link) =>
    link
      ? `Puedes cambiarla o cancelarla aquí:\n\n${link}\n\nSi prefieres, responde *CANCELAR* aquí mismo. No voy a cancelarla sin esa confirmación explícita.`
      : 'Para cancelar tu próxima cita, responde *CANCELAR*. No voy a cancelarla sin esa confirmación explícita.',
  confirmNeedsWord: 'Para confirmar tu próxima cita, responde *SÍ*.',
  handoffOutsideHours: (schedule) =>
    `Le paso tu mensaje al equipo. Te responden en horario de atención: ${schedule}`,

  waitingForHuman:
    'Ya le avisé al equipo, te responden en cuanto puedan. Mientras tanto puedo cancelar tu cita si escribes *CANCELAR*.',
  appointmentInfo: (service, professional, when, statusLine, link) =>
    `${statusLine} Es de ${service} con ${professional}, el ${when}.${
      link ? `\n\nSi necesitas cambiarla o cancelarla:\n${link}` : ''
    }`,
  noAppointmentToTell:
    'No encontré ninguna cita próxima a tu nombre. Si quieres, puedo agendarte una: escríbeme *agendar*.',

  reminder: (patientName, service, clinic, when) =>
    `Hola${patientName ? ' ' + patientName : ''}, reservaste una cita de ${service} en ${clinic} para el ${when}. ¿Confirmas que vas?\n\n` +
    `Responde *SÍ* para confirmar, *REAGENDAR* para cambiarla o *CANCELAR* si no puedes ir, así liberamos el turno para otro paciente.`,
  reminderManageLine: (url) =>
    `\n\nTambién puedes cambiarla o cancelarla aquí:\n${url}`,
  followUpPrompt: (patientName, clinic, professional) =>
    `Hola${patientName ? ' ' + patientName : ''}, gracias por tu visita a ${clinic}.\n\n` +
    `¿Cómo fue tu experiencia con ${professional}? Responde con un número del *1* (muy mala) al *5* (excelente).`,

  npsInvalid: 'Creo que no te entendí. Respóndeme con un número del *1* al *5*.',
  npsThanks: '¡Gracias por tu respuesta!',
  npsAskComment:
    '¡Gracias! Si quieres contarnos algo más, escríbelo ahora (o responde *no* para finalizar).',
  npsDone: '¡Muchas gracias por tu tiempo! Que tengas un buen día.',

  voiceNoteFirstTime:
    'Recibí tu nota de voz. La transcribo automáticamente con inteligencia artificial (OpenAI) para poder ayudarte; el audio se elimina en minutos, solo guardo el texto. Si prefieres, también puedes escribirme directo.',
};

const pt: BotCopy = {
  pools: {
    greeting: [
      'Olá! Sou o assistente da {clinicName}. Quer marcar uma consulta? Escreva *agendar* e fazemos por aqui mesmo, ou reserve online: {link}\n\nSe tiver outra dúvida, é só dizer.',
      'Oi 👋 Sou o assistente da {clinicName}. Escreva *agendar* para marcar sua consulta por aqui, ou faça online: {link}\n\nTambém posso responder suas dúvidas.',
      'Olá! Obrigado por escrever para a {clinicName}. Para marcar uma consulta escreva *agendar*, ou use nossa página: {link}\n\nComo posso ajudar?',
    ],
    greetingWithAppointment: [
      'Oi{patientName}. {statusLine}\n\nResponda *SIM* para confirmar, *REMARCAR* para mudar o horário ou *CANCELAR* se não puder ir.\n\nSe precisar de outra coisa, é só dizer.',
    ],
    fallback: [
      'Posso ajudar você a *agendar*, *remarcar* ou *cancelar* uma consulta, ou tirar dúvidas. Do que precisa?',
      'Me diga do que precisa: posso *agendar*, *remarcar* ou *cancelar* uma consulta, ou responder dúvidas.',
      'Estou aqui para ajudar com sua consulta. Você pode escrever *agendar*, *remarcar*, *cancelar*, ou me perguntar algo.',
    ],
    handoff: [
      'Já já alguém da equipe fala com você. 🙏',
      'Vou passar para alguém da equipe, respondem em seguida. 🙏',
    ],
    closing: [
      'Com prazer! Se precisar de mais alguma coisa, é só escrever. 🙌',
      'De nada. Estou por aqui se precisar de mais alguma coisa. 🙌',
      'Foi um prazer ajudar! Qualquer coisa, escreva. 🙌',
    ],
    ctaAfterAnswer: [
      'Quer marcar uma consulta? Escreva *agendar* e fazemos por aqui, ou reserve online: {link}',
      'Se quiser uma consulta, escreva *agendar* ou reserve aqui: {link}',
      'Quando quiser marcar, escreva *agendar* ou use nossa página: {link}',
    ],
    confirmAppointment: [
      '✅ Pronto. Sua consulta de {service} com {professional} ficou {status} para {when} na {clinicName}.{address}\n\nVou lembrar você antes da consulta.{manageLine}',
      'Perfeito! Reservei sua consulta de {service} com {professional} para {when} na {clinicName}.{address}\n\nAviso você antes para lembrar.{manageLine}',
    ],
  },
  aiDisclosure:
    'Sou um assistente automático. Se preferir falar com uma pessoa, escreva *humano*.',
  apptConfirmedLine: (service, when) =>
    `Sua consulta de ${service} de ${when} já está confirmada.`,
  apptPendingLine: (service, when) =>
    `Vi que você tem uma consulta de ${service} em ${when}.`,
  manageLine: (url) =>
    `\n\nSe precisar mudar ou cancelar, é por aqui:\n${url}`,
  manageLineFallback: '\n\nSe precisar mudar, escreva *remarcar*.',
  status: { confirmed: 'confirmada', scheduled: 'marcada', moved: 'remarcada' },

  noServices:
    'Por enquanto não temos serviços cadastrados. Escreva mais tarde ou escreva *humano* para falar com uma pessoa.',
  askService: (list) =>
    `Com prazer! Primeiro, de qual serviço você precisa?\n\n${list}\n\nResponda com o número ou o nome.`,
  flowAborted:
    'Pronto, deixei o agendamento em pausa. Quando quiser, escreva *agendar* para retomar.',
  serviceGone:
    'Esse serviço não está mais disponível. Escreva *agendar* para começar de novo.',
  noProfessionals:
    'Por enquanto não tenho profissionais disponíveis para esse serviço. Escreva mais tarde.',
  askProfessional: (list) =>
    `Perfeito. Com qual profissional você prefere?\n\n${list}\n\nResponda com o número ou o nome.`,
  anyProfessionalLabel: 'Qualquer profissional',
  serviceLostProfessionals:
    'Esse serviço ficou sem profissionais disponíveis. Escreva *agendar* para retomar.',
  professionalGone:
    'Esse profissional não está mais disponível. Escreva *agendar* para retomar.',
  slotsIntro: 'Vamos lá. Estes são os próximos horários disponíveis:',
  slotsIntroNextWeek: 'Estes são os horários da semana seguinte:',
  slotsIntroPreferenceMissed:
    'Não tenho horários com essa preferência, mas tenho estes:',
  slotsIntroReschedule:
    'Estes são os horários livres para mudar sua consulta. A atual continua valendo até você escolher:',
  slotsMoreOption: '\n0. Ver mais horários',
  slotsPrompt: (labels, more, footer, intro) =>
    `${intro}\n\n${labels}${more}\n\nResponda com o número do horário que preferir.${footer}`,
  noSlots:
    'Não encontrei horários livres nos próximos dias. Escreva mais tarde e tentamos de novo.',
  agendaExhausted: (link) =>
    `Minha agenda por aqui vai até aí. Você pode ver o calendário completo e escolher com calma neste link, que vale por 30 minutos:\n\n${link}`,
  agendaExhaustedWindows: (link) =>
    `Por aqui já mostrei as próximas semanas. Para ver o calendário completo e escolher com calma, entre neste link, que vale por 30 minutos:\n\n${link}\n\nOu responda com o número de algum dos horários que passei.`,
  agendaChanged:
    'Algo mudou na agenda. Escreva *agendar* para tentar de novo.',
  askName: 'Estamos quase lá. Em nome de quem eu marco a consulta?',
  askNameAgain: 'Acho que não entendi. Em nome de quem eu marco a consulta?',
  confirmPrompt: (name, service, professional, when) =>
    `Último passo. Confirmo sua consulta, ${name}, de ${service} com ${professional} em ${when}? Responda *SIM* para confirmar ou *não* para cancelar.`,
  confirmOnlyYesOrNo:
    'Preciso só de um *SIM* para confirmar ou um *não* para cancelar o agendamento.',
  nothingScheduled:
    'Pronto, não marquei nada. Quando quiser retomar, escreva *agendar*.',
  flowLost: 'Perdi o fio do agendamento. Escreva *agendar* e começamos de novo.',
  needPhone: (link) =>
    `Para terminar o agendamento preciso do seu telefone. Complete sua consulta aqui, o link vale por 30 minutos:\n\n${link}`,
  createFailed:
    'Tive um problema para registrar a consulta. Tente de novo daqui a pouco ou escreva *humano* para falar com uma pessoa.',
  webFallback: (message, link) =>
    `${message}\n\nSe for mais cômodo, você também pode escolher tudo por aqui (o link vale por 30 minutos):\n\n${link}`,
  rescheduleFooter: (link) => `\n\nOu escolha com calma aqui: ${link}`,
  rescheduleSlots: (link) =>
    `Você pode escolher o novo horário aqui:\n\n${link}\n\nSua consulta atual continua valendo até você mudar.`,
  rescheduleLimit: (link) =>
    `Você já mudou esta consulta várias vezes, então prefiro que veja isso com alguém da equipe para não complicar. Vou passar para a recepção.${
      link ? `\n\nEnquanto isso, aqui está o detalhe da sua consulta:\n${link}` : ''
    }`,
  notUnderstoodService: (list) =>
    `Acho que não entendi. Escolha um serviço da lista:\n\n${list}\n\nResponda com o número ou o nome.`,
  notUnderstoodProfessional: (list) =>
    `Acho que não entendi. Escolha um profissional da lista:\n\n${list}\n\nResponda com o número ou o nome.`,
  notUnderstoodSlot: (list) =>
    `Acho que não entendi. Escolha um horário respondendo com o número:\n\n${list}`,
  slotNotInList: (max, list) =>
    `Esse número não está na lista. Escolha um entre 1 e ${max}:\n\n${list}`,
  slotTaken: (labels) =>
    `Puxa! Esse horário acabou de ser ocupado. Estes são os que continuam livres:\n\n${labels}\n\nEscolha um respondendo com o número.`,
  slotExpired: (labels) =>
    `Esse horário já passou. Estes são os que continuam livres:\n\n${labels}\n\nEscolha um respondendo com o número.`,
  noSlotsLeftForPair:
    'Por enquanto não sobraram horários nos próximos 7 dias para este serviço e profissional. Escreva *agendar* mais tarde e tentamos de novo.',

  cannotLinkChat:
    'Não consegui associar esta conversa a uma consulta. Vou passar para a recepção ajudar você.',
  noUpcomingAppointment:
    'Não encontrei uma consulta próxima associada a este número. Se precisar de ajuda, escreva *humano* para falar com uma pessoa.',
  appointmentConfirmed: 'Pronto! Sua consulta está confirmada. Esperamos você.',
  appointmentCanceled:
    'Sua consulta foi cancelada. Quando quiser, escreva para remarcar.',
  cancelNeedsWord: (link) =>
    link
      ? `Você pode mudar ou cancelar aqui:\n\n${link}\n\nSe preferir, responda *CANCELAR* por aqui mesmo. Não vou cancelar sem essa confirmação explícita.`
      : 'Para cancelar sua próxima consulta, responda *CANCELAR*. Não vou cancelar sem essa confirmação explícita.',
  confirmNeedsWord: 'Para confirmar sua próxima consulta, responda *SIM*.',
  handoffOutsideHours: (schedule) =>
    `Vou passar sua mensagem para a equipe. Respondem no horário de atendimento: ${schedule}`,

  waitingForHuman:
    'Já avisei a equipe, respondem assim que puderem. Enquanto isso posso cancelar sua consulta se você escrever *CANCELAR*.',
  appointmentInfo: (service, professional, when, statusLine, link) =>
    `${statusLine} É de ${service} com ${professional}, em ${when}.${
      link ? `\n\nSe precisar mudar ou cancelar:\n${link}` : ''
    }`,
  noAppointmentToTell:
    'Não encontrei nenhuma consulta próxima no seu nome. Se quiser, posso marcar uma: escreva *agendar*.',

  reminder: (patientName, service, clinic, when) =>
    `Oi${patientName ? ' ' + patientName : ''}, você marcou uma consulta de ${service} na ${clinic} para ${when}. Confirma que vai?\n\n` +
    `Responda *SIM* para confirmar, *REMARCAR* para mudar o horário ou *CANCELAR* se não puder ir, assim liberamos o horário para outro paciente.`,
  reminderManageLine: (url) =>
    `\n\nVocê também pode mudar ou cancelar aqui:\n${url}`,
  followUpPrompt: (patientName, clinic, professional) =>
    `Oi${patientName ? ' ' + patientName : ''}, obrigado pela sua visita à ${clinic}.\n\n` +
    `Como foi sua experiência com ${professional}? Responda com um número de *1* (muito ruim) a *5* (excelente).`,

  npsInvalid: 'Acho que não entendi. Responda com um número de *1* a *5*.',
  npsThanks: 'Obrigado pela sua resposta!',
  npsAskComment:
    'Obrigado! Se quiser contar mais alguma coisa, escreva agora (ou responda *não* para finalizar).',
  npsDone: 'Muito obrigado pelo seu tempo! Tenha um ótimo dia.',

  voiceNoteFirstTime:
    'Recebi sua nota de voz. Transcrevo automaticamente com inteligência artificial (OpenAI) para poder ajudar você; o áudio é apagado em minutos, só guardo o texto. Se preferir, você também pode escrever direto.',
};

/** Si alguien añade una clave a `es` y se olvida de `pt`, esto no compila. */
export const BOT_COPY: Record<BotLocale, BotCopy> = { es, pt };

export function botCopy(locale: string | null | undefined): BotCopy {
  return BOT_COPY[botLocale(locale)];
}
