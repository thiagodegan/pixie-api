// ---------------------------------------------------------------------------
// Erros de aplicação. Mensagens em pt-BR porque chegam direto na interface.
// ---------------------------------------------------------------------------

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    override readonly message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (message: string, code = "BAD_REQUEST") =>
  new AppError(400, message, code);

export const unauthorized = (
  message = "Sessão expirada ou inválida.",
  code = "UNAUTHORIZED",
) => new AppError(401, message, code);

export const forbidden = (
  message = "Você não tem acesso a este recurso.",
  code = "FORBIDDEN",
) => new AppError(403, message, code);

export const notFound = (message = "Não encontrado.", code = "NOT_FOUND") =>
  new AppError(404, message, code);

export const conflict = (message: string, code = "CONFLICT") =>
  new AppError(409, message, code);
