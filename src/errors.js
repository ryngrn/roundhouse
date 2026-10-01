export class RoundhouseError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RoundhouseError";
    this.code = code;
    this.details = details;
  }
}
