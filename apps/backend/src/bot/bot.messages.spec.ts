import { BOT_COPY, botCopy, botLocale } from './bot.messages';

describe('bot.messages (B7)', () => {
  it('resuelve pt y cae a es ante cualquier otra cosa', () => {
    expect(botLocale('pt')).toBe('pt');
    expect(botLocale('es')).toBe('es');
    // `clinic.locale` es un String libre en DB: no puede reventar ni quedarse
    // sin copy porque alguien escriba "pt-BR" o "en".
    expect(botLocale('en')).toBe('es');
    expect(botLocale(null)).toBe('es');
    expect(botLocale(undefined)).toBe('es');
    expect(botLocale('')).toBe('es');
  });

  it('los dos idiomas tienen exactamente las mismas claves', () => {
    // El tipo ya lo garantiza en compilación; esto lo fija también en runtime
    // por si alguien añade una clave con un cast.
    expect(Object.keys(BOT_COPY.pt).sort()).toEqual(
      Object.keys(BOT_COPY.es).sort(),
    );
    expect(Object.keys(BOT_COPY.pt.pools).sort()).toEqual(
      Object.keys(BOT_COPY.es.pools).sort(),
    );
  });

  it('ningún pool está vacío: `pickVariant` devolvería undefined', () => {
    for (const locale of ['es', 'pt'] as const) {
      for (const [name, pool] of Object.entries(BOT_COPY[locale].pools)) {
        expect(`${locale}.${name}: ${pool.length}`).not.toContain(': 0');
      }
    }
  });

  it('el copy en pt no se quedó en español', () => {
    const pt = botCopy('pt');
    // Palabras que delatarían una traducción olvidada.
    const sospechosas = /\b(escríbeme|horarios? disponibles|cita|gracias por tu|tu cita)\b/i;
    const textos = [
      ...pt.pools.greeting,
      ...pt.pools.fallback,
      ...pt.pools.handoff,
      ...pt.pools.closing,
      ...pt.pools.confirmAppointment,
      pt.aiDisclosure,
      pt.noServices,
      pt.askName,
      pt.flowLost,
      pt.appointmentConfirmed,
      pt.npsDone,
      pt.askService('1. X'),
      pt.confirmPrompt('Ana', 'Limpeza', 'Dr. Silva', 'segunda'),
      pt.reminder('Ana', 'Limpeza', 'Clínica', 'segunda'),
      pt.followUpPrompt('Ana', 'Clínica', 'Dr. Silva'),
      pt.voiceNoteFirstTime,
      pt.voiceNoteTooLong,
      pt.voiceNoteFailed,
      pt.voiceConfirmHandoff,
      pt.voiceConfirmEcho('sim', pt.wordYes),
    ];
    for (const t of textos) {
      expect(`${t}`).not.toMatch(sospechosas);
    }
  });

  it('las palabras de acción del pt son las que el matching entiende', () => {
    // Si el copy dice *SIM* pero el parser solo entiende "sí", el paciente
    // hace exactamente lo que le pedimos y el bot no lo entiende.
    const pt = botCopy('pt');
    expect(pt.pools.greetingWithAppointment[0]).toContain('*SIM*');
    expect(pt.pools.greetingWithAppointment[0]).toContain('*REMARCAR*');
    expect(pt.pools.greetingWithAppointment[0]).toContain('*CANCELAR*');
    expect(pt.confirmNeedsWord).toContain('*SIM*');
    expect(pt.aiDisclosure).toContain('*humano*');
    expect(pt.reminder('', 'x', 'y', 'z')).toContain('*SIM*');
    expect(pt.reminder('', 'x', 'y', 'z')).toContain('*REMARCAR*');
  });

  it('voiceConfirmEcho (M10 PR5) pide la palabra del idioma de la clínica', () => {
    // Si el eco dijera *SÍ* en una clínica en portugués, el paciente escribiría
    // lo que le dijimos y `parseReminderReply` no lo entendería.
    expect(botCopy('es').voiceConfirmEcho('sí', botCopy('es').wordYes)).toContain(
      '*SÍ*',
    );
    expect(botCopy('pt').voiceConfirmEcho('sim', botCopy('pt').wordYes)).toContain(
      '*SIM*',
    );
    // Y la misma que usa el recordatorio, que es a lo que el paciente responde.
    expect(botCopy('pt').reminder('', 'x', 'y', 'z')).toContain(
      `*${botCopy('pt').wordYes}*`,
    );
    expect(botCopy('es').reminder('', 'x', 'y', 'z')).toContain(
      `*${botCopy('es').wordYes}*`,
    );
  });

  it('voiceNoteFirstTime (M10) dice que se transcribe con IA y que el audio no se guarda', () => {
    // Ver docs/adr/0004-pii-y-compliance.md §7.2: el aviso tiene que ser
    // honesto sobre las dos cosas que le importan al paciente: quién procesa
    // su voz y si esa grabación se queda guardada en algún lado.
    for (const locale of ['es', 'pt'] as const) {
      const msg = botCopy(locale).voiceNoteFirstTime;
      expect(msg).toMatch(/OpenAI/);
      expect(msg.toLowerCase()).toMatch(/(guardo|guarda|conserva)/);
      expect(msg.toLowerCase()).toMatch(/áudio|audio/);
    }
  });
});
