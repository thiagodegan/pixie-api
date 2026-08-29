// ---------------------------------------------------------------------------
// Fronteiras de dia e mês.
//
// "Recebido hoje" é o dia do lojista, não o dia UTC. Um pagamento às 22h de
// São Paulo é 01h UTC do dia seguinte — sem fuso correto, o fechamento do
// caixa da noite apareceria no dia errado.
//
// O contêiner roda com TZ=America/Sao_Paulo (definido no docker-compose), então
// a aritmética local do Date já resolve. Estas funções isolam essa dependência
// num lugar só.
// ---------------------------------------------------------------------------

export function startOfToday(now = new Date()): Date {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function startOfMonth(now = new Date()): Date {
  const d = new Date(now);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}
