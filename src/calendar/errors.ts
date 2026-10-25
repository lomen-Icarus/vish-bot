/**
 * Ошибки календарных сервисов (Google, Яндекс), сведённые к четырём видам, по
 * которым решает сверка (push.ts):
 *   revoked — доступ отозван: нужно подключиться заново;
 *   gone    — календаря больше нет (удалили): тоже заново;
 *   retry   — лимиты, 5xx, сеть: повторить на следующем проходе;
 *   fatal   — остальное (неверный запрос): записать ошибку, не долбить.
 */
export type CalErrorKind = "revoked" | "gone" | "retry" | "fatal";

export class CalError extends Error {
  constructor(
    readonly kind: CalErrorKind,
    readonly status: number,
    readonly reason: string,
  ) {
    super(`calendar ${kind}: ${status} ${reason}`);
  }
}
